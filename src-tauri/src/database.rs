use std::{fs, io::Cursor, path::PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use image::{ImageFormat, ImageReader};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    domain::{
        AppSettings, ChatMessage, Folder, FolderDraft, Meeting, MeetingDraft, MeetingPlacement,
        Person, PersonDraft, Project, ProjectDraft, StoredVoiceProfile, TranscriptSegment,
        TranscriptSegmentBackup, VoiceProfileSummary,
    },
    error::{AppError, AppResult},
};

const PERSON_COLORS: [&str; 6] = [
    "#d96c4a", "#477a66", "#6256a5", "#b07a28", "#3c6e9b", "#985b76",
];
const MAX_CHAT_MESSAGE_CHARACTERS: usize = 12_000;
const MAX_AVATAR_EDGE: u32 = 256;

#[derive(Clone)]
pub struct Database {
    path: PathBuf,
}

impl Database {
    pub fn open(app_data_dir: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(&app_data_dir)?;
        let database = Self {
            path: app_data_dir.join("listen.sqlite3"),
        };
        database.migrate()?;
        database.optimize_person_photos()?;
        Ok(database)
    }

    fn connection(&self) -> AppResult<Connection> {
        let connection = Connection::open(&self.path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(connection)
    }

    fn migrate(&self) -> AppResult<()> {
        self.connection()?.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                position INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                position INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS folders_project_idx ON folders(project_id, position);

            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
                position INTEGER NOT NULL DEFAULT 0,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                created_at TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                audio_directory TEXT,
                error_message TEXT,
                deleted_at TEXT
            );

            CREATE INDEX IF NOT EXISTS meetings_project_idx ON meetings(project_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS people (
                id TEXT PRIMARY KEY,
                full_name TEXT NOT NULL,
                nickname TEXT,
                photo_data_url TEXT,
                photo_original_data_url TEXT,
                reference_audio_data_url TEXT,
                color TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS voice_profiles (
                person_id TEXT PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
                provider TEXT NOT NULL DEFAULT 'pyannote',
                voiceprint TEXT,
                status TEXT NOT NULL,
                consent_confirmed_at TEXT,
                enrollment_meeting_id TEXT,
                enrollment_speaker_label TEXT,
                enrollment_duration_ms INTEGER,
                enrollment_clip_count INTEGER,
                source TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transcript_segments (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                speaker_label TEXT NOT NULL,
                person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
                identity_source TEXT,
                identity_confidence REAL,
                start_ms INTEGER NOT NULL,
                end_ms INTEGER NOT NULL,
                text TEXT NOT NULL,
                raw_text TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS transcript_meeting_idx ON transcript_segments(meeting_id, start_ms);

            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                scope_type TEXT NOT NULL CHECK(scope_type IN ('meeting', 'project')),
                scope_id TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                content TEXT NOT NULL,
                position INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS chat_scope_position_idx
                ON chat_messages(scope_type, scope_id, position);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )?;
        self.ensure_transcript_raw_text_column()?;
        self.ensure_transcript_identity_columns()?;
        self.ensure_meeting_organization_columns()?;
        self.ensure_person_photo_columns()?;
        self.migrate_legacy_voice_profiles()?;
        Ok(())
    }

    fn ensure_person_photo_columns(&self) -> AppResult<()> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("PRAGMA table_info(people)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !columns
            .iter()
            .any(|column| column == "photo_original_data_url")
        {
            connection.execute(
                "ALTER TABLE people ADD COLUMN photo_original_data_url TEXT",
                [],
            )?;
        }
        Ok(())
    }

    fn optimize_person_photos(&self) -> AppResult<()> {
        let mut connection = self.connection()?;
        let photos = {
            let mut statement = connection.prepare(
                "SELECT id, photo_data_url
                 FROM people
                 WHERE photo_data_url LIKE 'data:image/png;base64,%'
                    OR photo_data_url LIKE 'data:image/jpeg;base64,%'
                    OR photo_data_url LIKE 'data:image/jpg;base64,%'",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let transaction = connection.transaction()?;
        for (person_id, photo) in photos {
            let Some(thumbnail) = thumbnail_photo_data_url(&photo) else {
                continue;
            };
            transaction.execute(
                "UPDATE people
                 SET photo_original_data_url = COALESCE(photo_original_data_url, photo_data_url),
                     photo_data_url = ?1
                 WHERE id = ?2",
                params![thumbnail, person_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn ensure_transcript_identity_columns(&self) -> AppResult<()> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("PRAGMA table_info(transcript_segments)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        if !columns.iter().any(|column| column == "identity_source") {
            connection.execute(
                "ALTER TABLE transcript_segments ADD COLUMN identity_source TEXT",
                [],
            )?;
            connection.execute(
                "UPDATE transcript_segments SET identity_source = 'manual' WHERE person_id IS NOT NULL",
                [],
            )?;
        }
        if !columns.iter().any(|column| column == "identity_confidence") {
            connection.execute(
                "ALTER TABLE transcript_segments ADD COLUMN identity_confidence REAL",
                [],
            )?;
        }
        Ok(())
    }

    fn migrate_legacy_voice_profiles(&self) -> AppResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let legacy = {
            let mut statement = transaction.prepare(
                "SELECT id, reference_audio_data_url FROM people WHERE reference_audio_data_url LIKE 'pyannote:%'",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        let now = Utc::now().to_rfc3339();
        for (person_id, encoded) in legacy {
            let Some(voiceprint) = legacy_voiceprint(&encoded) else {
                continue;
            };
            transaction.execute(
                "INSERT OR IGNORE INTO voice_profiles(
                    person_id, provider, voiceprint, status, created_at, updated_at
                 ) VALUES(?1, 'pyannote', ?2, 'ready', ?3, ?3)",
                params![person_id, voiceprint, now],
            )?;
            transaction.execute(
                "UPDATE people SET reference_audio_data_url = NULL WHERE id = ?1",
                [person_id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    fn ensure_meeting_organization_columns(&self) -> AppResult<()> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("PRAGMA table_info(meetings)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;

        if !columns.iter().any(|column| column == "position") {
            connection.execute(
                "ALTER TABLE meetings ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        if !columns.iter().any(|column| column == "deleted_at") {
            connection.execute("ALTER TABLE meetings ADD COLUMN deleted_at TEXT", [])?;
        }
        if !columns.iter().any(|column| column == "folder_id") {
            connection.execute(
                "ALTER TABLE meetings ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL",
                [],
            )?;
        }
        Ok(())
    }

    fn ensure_transcript_raw_text_column(&self) -> AppResult<()> {
        let connection = self.connection()?;
        let mut statement = connection.prepare("PRAGMA table_info(transcript_segments)")?;
        let columns = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;

        if !columns.iter().any(|column| column == "raw_text") {
            connection.execute(
                "ALTER TABLE transcript_segments ADD COLUMN raw_text TEXT",
                [],
            )?;
            connection.execute(
                "UPDATE transcript_segments SET raw_text = text WHERE raw_text IS NULL",
                [],
            )?;
        }

        Ok(())
    }

    pub fn projects(&self) -> AppResult<Vec<Project>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, name, position, created_at FROM projects ORDER BY position, created_at",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                position: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn meetings(&self) -> AppResult<Vec<Meeting>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, folder_id, position, title, status, created_at, started_at, ended_at,
                    duration_ms, audio_directory, error_message
             FROM meetings WHERE deleted_at IS NULL
             ORDER BY CASE WHEN project_id IS NULL THEN '' ELSE project_id END, position, created_at DESC",
        )?;
        let rows = statement.query_map([], map_meeting)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn meeting(&self, id: &str) -> AppResult<Meeting> {
        self.connection()?
            .query_row(
                "SELECT id, project_id, folder_id, position, title, status, created_at, started_at, ended_at,
                        duration_ms, audio_directory, error_message
                 FROM meetings WHERE id = ?1 AND deleted_at IS NULL",
                [id],
                map_meeting,
            )
            .optional()?
            .ok_or(AppError::NotFound("Meeting"))
    }

    pub fn people(&self) -> AppResult<Vec<Person>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT p.id, p.full_name, p.nickname, p.photo_data_url, p.color, p.created_at,
                    v.status, v.enrollment_duration_ms,
                    v.enrollment_clip_count, v.source, v.updated_at, v.last_error
             FROM people p LEFT JOIN voice_profiles v ON v.person_id = p.id
             ORDER BY COALESCE(p.nickname, p.full_name) COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            let voice_profile = match row.get::<_, Option<String>>(6)? {
                Some(status) => Some(VoiceProfileSummary {
                    status,
                    enrollment_duration_ms: row.get(7)?,
                    enrollment_clip_count: row.get(8)?,
                    source: row.get(9)?,
                    updated_at: row.get::<_, Option<String>>(10)?.unwrap_or_default(),
                    last_error: row.get(11)?,
                }),
                None => None,
            };
            Ok(Person {
                id: row.get(0)?,
                full_name: row.get(1)?,
                nickname: row.get(2)?,
                photo_data_url: row.get(3)?,
                color: row.get(4)?,
                created_at: row.get(5)?,
                voice_profile,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn segments(&self) -> AppResult<Vec<TranscriptSegment>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT segment.id, segment.meeting_id, segment.speaker_label, segment.person_id,
                    segment.identity_source, segment.identity_confidence,
                    segment.start_ms, segment.end_ms, segment.text
             FROM transcript_segments segment
             JOIN meetings meeting ON meeting.id = segment.meeting_id
             WHERE meeting.deleted_at IS NULL
             ORDER BY segment.meeting_id, segment.start_ms",
        )?;
        let rows = statement.query_map([], map_transcript_segment)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn segments_for_meeting(&self, meeting_id: &str) -> AppResult<Vec<TranscriptSegment>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, meeting_id, speaker_label, person_id, identity_source,
                    identity_confidence, start_ms, end_ms, text
             FROM transcript_segments
             WHERE meeting_id = ?1
             ORDER BY start_ms",
        )?;
        let rows = statement.query_map([meeting_id], map_transcript_segment)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn best_assigned_segment_for_person(
        &self,
        person_id: &str,
    ) -> AppResult<Option<TranscriptSegment>> {
        self.connection()?
            .query_row(
                "SELECT segment.id, segment.meeting_id, segment.speaker_label, segment.person_id,
                        segment.identity_source, segment.identity_confidence,
                        segment.start_ms, segment.end_ms, segment.text
                 FROM transcript_segments segment
                 JOIN meetings meeting ON meeting.id = segment.meeting_id
                 WHERE segment.person_id = ?1 AND segment.identity_source = 'manual'
                   AND meeting.deleted_at IS NULL
                 ORDER BY segment.end_ms - segment.start_ms DESC, segment.start_ms
                 LIMIT 1",
                [person_id],
                map_transcript_segment,
            )
            .optional()
            .map_err(AppError::from)
    }

    pub fn settings(&self) -> AppResult<AppSettings> {
        let connection = self.connection()?;
        let stored: Option<String> = connection
            .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| {
                row.get(0)
            })
            .optional()?;
        stored
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|error| AppError::Validation(error.to_string()))
            })
            .transpose()
            .map(|settings| settings.unwrap_or_default())
    }

    pub fn update_settings(&self, settings: &AppSettings) -> AppResult<AppSettings> {
        let mut settings = settings.clone();
        if let Some(person_id) = settings.local_speaker_person_id.as_deref() {
            let exists: bool = self.connection()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM people WHERE id = ?1)",
                [person_id],
                |row| row.get(0),
            )?;
            // A stale id (person deleted elsewhere) must not block unrelated settings saves.
            if !exists {
                settings.local_speaker_person_id = None;
            }
        }
        let value = serde_json::to_string(&settings)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        self.connection()?.execute(
            "INSERT INTO settings(key, value) VALUES('app', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [value],
        )?;
        Ok(settings)
    }

    pub fn create_project(&self, draft: ProjectDraft) -> AppResult<Project> {
        let name = required_text(draft.name, "Project name")?;
        let connection = self.connection()?;
        let position: i64 =
            connection.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
        let project = Project {
            id: Uuid::new_v4().to_string(),
            name,
            position,
            created_at: Utc::now().to_rfc3339(),
        };
        connection.execute(
            "INSERT INTO projects(id, name, position, created_at) VALUES(?1, ?2, ?3, ?4)",
            params![
                project.id,
                project.name,
                project.position,
                project.created_at
            ],
        )?;
        Ok(project)
    }

    pub fn rename_project(&self, id: &str, name: String) -> AppResult<Project> {
        let name = required_text(name, "Project name")?;
        if self.connection()?.execute(
            "UPDATE projects SET name = ?1 WHERE id = ?2",
            params![name, id],
        )? == 0
        {
            return Err(AppError::NotFound("Project"));
        }
        self.projects()?
            .into_iter()
            .find(|project| project.id == id)
            .ok_or(AppError::NotFound("Project"))
    }

    pub fn delete_project(&self, id: &str) -> AppResult<()> {
        self.connection()?
            .execute("DELETE FROM projects WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn reorder_projects(&self, ids: Vec<String>) -> AppResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for (position, id) in ids.iter().enumerate() {
            transaction.execute(
                "UPDATE projects SET position = ?1 WHERE id = ?2",
                params![position as i64, id],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn folders(&self) -> AppResult<Vec<Folder>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, project_id, parent_id, name, position, created_at
             FROM folders ORDER BY position, created_at",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                project_id: row.get(1)?,
                parent_id: row.get(2)?,
                name: row.get(3)?,
                position: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    fn folder(&self, id: &str) -> AppResult<Folder> {
        self.folders()?
            .into_iter()
            .find(|folder| folder.id == id)
            .ok_or(AppError::NotFound("Folder"))
    }

    pub fn create_folder(&self, draft: FolderDraft) -> AppResult<Folder> {
        let name = required_text(draft.name, "Folder name")?;
        let connection = self.connection()?;
        if let Some(parent_id) = draft.parent_id.as_deref() {
            let parent_project: Option<String> = connection
                .query_row(
                    "SELECT project_id FROM folders WHERE id = ?1",
                    [parent_id],
                    |row| row.get(0),
                )
                .optional()?;
            if parent_project.as_deref() != Some(draft.project_id.as_str()) {
                return Err(AppError::NotFound("Folder"));
            }
        }
        let position: i64 = connection.query_row(
            "SELECT COUNT(*) FROM folders WHERE project_id = ?1 AND parent_id IS ?2",
            params![draft.project_id, draft.parent_id],
            |row| row.get(0),
        )?;
        let folder = Folder {
            id: Uuid::new_v4().to_string(),
            project_id: draft.project_id,
            parent_id: draft.parent_id,
            name,
            position,
            created_at: Utc::now().to_rfc3339(),
        };
        connection.execute(
            "INSERT INTO folders(id, project_id, parent_id, name, position, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                folder.id,
                folder.project_id,
                folder.parent_id,
                folder.name,
                folder.position,
                folder.created_at
            ],
        )?;
        Ok(folder)
    }

    pub fn rename_folder(&self, id: &str, name: String) -> AppResult<Folder> {
        let name = required_text(name, "Folder name")?;
        if self.connection()?.execute(
            "UPDATE folders SET name = ?1 WHERE id = ?2",
            params![name, id],
        )? == 0
        {
            return Err(AppError::NotFound("Folder"));
        }
        self.folder(id)
    }

    pub fn move_folder(&self, id: &str, parent_id: Option<String>) -> AppResult<Folder> {
        let folders = self.folders()?;
        let folder = folders
            .iter()
            .find(|candidate| candidate.id == id)
            .ok_or(AppError::NotFound("Folder"))?;
        if let Some(target_id) = parent_id.as_deref() {
            // The target must live in the same project and must not be the
            // folder itself or one of its descendants.
            let mut cursor = Some(target_id.to_string());
            while let Some(current) = cursor {
                if current == id {
                    return Err(AppError::Validation(
                        "A folder cannot be moved inside itself".to_string(),
                    ));
                }
                cursor = folders
                    .iter()
                    .find(|candidate| candidate.id == current)
                    .ok_or(AppError::NotFound("Folder"))?
                    .parent_id
                    .clone();
            }
            let target = folders
                .iter()
                .find(|candidate| candidate.id == target_id)
                .ok_or(AppError::NotFound("Folder"))?;
            if target.project_id != folder.project_id {
                return Err(AppError::Validation(
                    "Folders can only be moved within their project".to_string(),
                ));
            }
        }
        let connection = self.connection()?;
        let position: i64 = connection.query_row(
            "SELECT COUNT(*) FROM folders WHERE project_id = ?1 AND parent_id IS ?2 AND id != ?3",
            params![folder.project_id, parent_id, id],
            |row| row.get(0),
        )?;
        connection.execute(
            "UPDATE folders SET parent_id = ?1, position = ?2 WHERE id = ?3",
            params![parent_id, position, id],
        )?;
        self.folder(id)
    }

    pub fn delete_folder(&self, id: &str) -> AppResult<()> {
        let folder = self.folder(id)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        // Contents move up one level instead of disappearing with the folder.
        let meeting_offset: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM meetings
             WHERE project_id IS ?1 AND folder_id IS ?2 AND deleted_at IS NULL",
            params![folder.project_id, folder.parent_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE meetings SET folder_id = ?1, position = position + ?2 WHERE folder_id = ?3",
            params![folder.parent_id, meeting_offset, id],
        )?;
        let folder_offset: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM folders WHERE project_id = ?1 AND parent_id IS ?2 AND id != ?3",
            params![folder.project_id, folder.parent_id, id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "UPDATE folders SET parent_id = ?1, position = position + ?2 WHERE parent_id = ?3",
            params![folder.parent_id, folder_offset, id],
        )?;
        transaction.execute("DELETE FROM folders WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn create_meeting(&self, draft: MeetingDraft) -> AppResult<Meeting> {
        let title = required_text(draft.title, "Meeting title")?;
        let meeting = Meeting {
            id: Uuid::new_v4().to_string(),
            project_id: draft.project_id,
            folder_id: None,
            position: 0,
            title,
            status: "draft".to_string(),
            created_at: Utc::now().to_rfc3339(),
            started_at: None,
            ended_at: None,
            duration_ms: 0,
            audio_directory: None,
            error_message: None,
        };
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE meetings SET position = position + 1
             WHERE project_id IS ?1 AND folder_id IS NULL AND deleted_at IS NULL",
            params![meeting.project_id],
        )?;
        transaction.execute(
            "INSERT INTO meetings(id, project_id, position, title, status, created_at, duration_ms)
             VALUES(?1, ?2, 0, ?3, ?4, ?5, 0)",
            params![
                meeting.id,
                meeting.project_id,
                meeting.title,
                meeting.status,
                meeting.created_at
            ],
        )?;
        transaction.commit()?;
        Ok(meeting)
    }

    pub fn rename_meeting(&self, id: &str, title: String) -> AppResult<Meeting> {
        let title = required_text(title, "Meeting title")?;
        self.connection()?.execute(
            "UPDATE meetings SET title = ?1 WHERE id = ?2",
            params![title, id],
        )?;
        self.meeting(id)
    }

    pub fn move_meeting(&self, id: &str, project_id: Option<String>) -> AppResult<Meeting> {
        let connection = self.connection()?;
        let position: i64 = connection.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM meetings
             WHERE project_id IS ?1 AND folder_id IS NULL AND deleted_at IS NULL",
            params![project_id],
            |row| row.get(0),
        )?;
        connection.execute(
            "UPDATE meetings SET project_id = ?1, folder_id = NULL, position = ?2 WHERE id = ?3",
            params![project_id, position, id],
        )?;
        self.meeting(id)
    }

    pub fn reorder_meetings(&self, placements: Vec<MeetingPlacement>) -> AppResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for placement in placements {
            if let Some(folder_id) = placement.folder_id.as_deref() {
                let folder_project: Option<String> = transaction
                    .query_row(
                        "SELECT project_id FROM folders WHERE id = ?1",
                        [folder_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if folder_project.as_deref() != placement.project_id.as_deref() {
                    return Err(AppError::NotFound("Folder"));
                }
            }
            if transaction.execute(
                "UPDATE meetings SET project_id = ?1, folder_id = ?2, position = ?3
                 WHERE id = ?4 AND deleted_at IS NULL",
                params![
                    placement.project_id,
                    placement.folder_id,
                    placement.position,
                    placement.id
                ],
            )? != 1
            {
                return Err(AppError::NotFound("Meeting"));
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn delete_meeting(&self, id: &str) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE meetings SET deleted_at = ?1 WHERE id = ?2",
            params![Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    pub fn restore_meeting(&self, id: &str) -> AppResult<Meeting> {
        self.connection()?
            .execute("UPDATE meetings SET deleted_at = NULL WHERE id = ?1", [id])?;
        self.meeting(id)
    }

    pub fn create_person(&self, draft: PersonDraft) -> AppResult<Person> {
        let connection = self.connection()?;
        let count: i64 =
            connection.query_row("SELECT COUNT(*) FROM people", [], |row| row.get(0))?;
        let person = Person {
            id: Uuid::new_v4().to_string(),
            full_name: required_text(draft.full_name, "Full name")?,
            nickname: clean_optional(draft.nickname),
            photo_data_url: clean_optional(draft.photo_data_url),
            voice_profile: None,
            color: PERSON_COLORS[count as usize % PERSON_COLORS.len()].to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        connection.execute(
            "INSERT INTO people(id, full_name, nickname, photo_data_url, reference_audio_data_url, color, created_at)
             VALUES(?1, ?2, ?3, ?4, NULL, ?5, ?6)",
            params![person.id, person.full_name, person.nickname, person.photo_data_url, person.color, person.created_at],
        )?;
        Ok(person)
    }

    pub fn update_person(&self, id: &str, draft: PersonDraft) -> AppResult<Person> {
        self.connection()?.execute(
            "UPDATE people
             SET full_name = ?1,
                 nickname = ?2,
                 photo_original_data_url = CASE
                     WHEN photo_data_url IS NOT ?3 THEN NULL
                     ELSE photo_original_data_url
                 END,
                 photo_data_url = ?3
             WHERE id = ?4",
            params![
                required_text(draft.full_name, "Full name")?,
                clean_optional(draft.nickname),
                clean_optional(draft.photo_data_url),
                id,
            ],
        )?;
        self.people()?
            .into_iter()
            .find(|person| person.id == id)
            .ok_or(AppError::NotFound("Person"))
    }

    pub fn delete_person(&self, id: &str) -> AppResult<()> {
        self.connection()?
            .execute("DELETE FROM people WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn voice_profiles(&self) -> AppResult<Vec<StoredVoiceProfile>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT person_id, voiceprint, status
             FROM voice_profiles
             ORDER BY updated_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(StoredVoiceProfile {
                person_id: row.get(0)?,
                voiceprint: row.get(1)?,
                status: row.get(2)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    /// Creates a pending profile row when the person has none. Never resurrects
    /// a row a user disabled.
    pub fn ensure_voice_profile(&self, person_id: &str) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        self.connection()?
            .execute(
                "INSERT INTO voice_profiles(person_id, provider, status, created_at, updated_at)
                 VALUES(?1, 'pyannote', 'pending_sample', ?2, ?2)
                 ON CONFLICT(person_id) DO NOTHING",
                params![person_id, now],
            )
            .map_err(|error| match error {
                rusqlite::Error::SqliteFailure(inner, _)
                    if inner.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    AppError::NotFound("Person")
                }
                other => AppError::from(other),
            })?;
        Ok(())
    }

    /// Durable erase: keeps a tombstone row so labeling this person again does
    /// not silently relearn a voiceprint.
    pub fn disable_voice_profile(&self, person_id: &str) -> AppResult<()> {
        let connection = self.connection()?;
        let now = Utc::now().to_rfc3339();
        connection.execute(
            "INSERT INTO voice_profiles(person_id, provider, status, created_at, updated_at)
             VALUES(?1, 'pyannote', 'disabled', ?2, ?2)
             ON CONFLICT(person_id) DO UPDATE SET
                status = 'disabled', voiceprint = NULL, enrollment_meeting_id = NULL,
                enrollment_speaker_label = NULL, enrollment_duration_ms = NULL,
                enrollment_clip_count = NULL, source = NULL, last_error = NULL,
                updated_at = excluded.updated_at",
            params![person_id, now],
        )?;
        connection.execute(
            "UPDATE people SET reference_audio_data_url = NULL WHERE id = ?1",
            [person_id],
        )?;
        Ok(())
    }

    pub fn enable_voice_profile(&self, person_id: &str) -> AppResult<()> {
        self.ensure_voice_profile(person_id)?;
        self.connection()?.execute(
            "UPDATE voice_profiles SET status = 'pending_sample', last_error = NULL, updated_at = ?1
             WHERE person_id = ?2 AND status = 'disabled'",
            params![Utc::now().to_rfc3339(), person_id],
        )?;
        Ok(())
    }

    pub fn touch_voice_profiles(&self, person_ids: &[String]) -> AppResult<()> {
        if person_ids.is_empty() {
            return Ok(());
        }
        let connection = self.connection()?;
        let now = Utc::now().to_rfc3339();
        for person_id in person_ids {
            connection.execute(
                "UPDATE voice_profiles SET updated_at = ?1 WHERE person_id = ?2",
                params![now, person_id],
            )?;
        }
        Ok(())
    }

    pub fn mark_voice_profile_learning(&self, person_id: &str) -> AppResult<()> {
        self.ensure_voice_profile(person_id)?;
        let now = Utc::now().to_rfc3339();
        if self.connection()?.execute(
            "UPDATE voice_profiles SET status = 'learning', last_error = NULL, updated_at = ?1
             WHERE person_id = ?2 AND status != 'disabled'",
            params![now, person_id],
        )? != 1
        {
            return Err(AppError::Validation(
                "Automatic voice labeling is turned off for this person".to_string(),
            ));
        }
        Ok(())
    }

    pub fn save_voice_profile(
        &self,
        person_id: &str,
        meeting_id: &str,
        speaker_label: &str,
        duration_ms: i64,
        clip_count: i64,
        source: &str,
    ) -> AppResult<()> {
        let now = Utc::now().to_rfc3339();
        if self.connection()?.execute(
            "UPDATE voice_profiles SET
                voiceprint = NULL, status = 'ready', enrollment_meeting_id = ?1,
                enrollment_speaker_label = ?2, enrollment_duration_ms = ?3,
                enrollment_clip_count = ?4, source = ?5, last_error = NULL, updated_at = ?6
             WHERE person_id = ?7 AND status != 'disabled'",
            params![
                meeting_id,
                speaker_label,
                duration_ms,
                clip_count,
                source,
                now,
                person_id
            ],
        )? != 1
        {
            return Err(AppError::Validation(
                "The voice profile was removed during enrollment".to_string(),
            ));
        }
        Ok(())
    }

    pub fn clear_voiceprint_blob(&self, person_id: &str) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE voice_profiles SET voiceprint = NULL WHERE person_id = ?1",
            [person_id],
        )?;
        Ok(())
    }

    pub fn activate_existing_voice_profile(&self, person_id: &str) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE voice_profiles SET status = 'ready', last_error = NULL, updated_at = ?1
             WHERE person_id = ?2 AND status != 'disabled'",
            params![Utc::now().to_rfc3339(), person_id],
        )?;
        Ok(())
    }

    pub fn recover_interrupted_voice_profiles(&self) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE voice_profiles
             SET status = 'pending_sample',
                 last_error = 'Local voice profile storage was upgraded; enrollment will retry',
                 updated_at = ?1
             WHERE status = 'learning'
                OR (status = 'failed' AND LOWER(COALESCE(last_error, '')) LIKE '%platform limit%')",
            [Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn mark_voice_profile_pending(&self, person_id: &str, detail: &str) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE voice_profiles SET status = 'pending_sample', last_error = ?1, updated_at = ?2
             WHERE person_id = ?3 AND status != 'disabled'",
            params![detail, Utc::now().to_rfc3339(), person_id],
        )?;
        Ok(())
    }

    pub fn mark_voice_profile_failed(&self, person_id: &str, detail: &str) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE voice_profiles SET status = 'failed', last_error = ?1, updated_at = ?2
             WHERE person_id = ?3 AND status != 'disabled'",
            params![detail, Utc::now().to_rfc3339(), person_id],
        )?;
        Ok(())
    }

    pub fn assign_speaker(
        &self,
        meeting_id: &str,
        speaker_label: &str,
        person_id: Option<String>,
        identity_source: Option<String>,
    ) -> AppResult<()> {
        // Undo/redo restores the recorded source so machine-attributed labels
        // never get promoted to 'manual' (the only source enrollment learns from).
        let identity_source = person_id
            .as_ref()
            .map(|_| identity_source.unwrap_or_else(|| "manual".to_string()));
        self.connection()?.execute(
            "UPDATE transcript_segments
             SET person_id = ?1, identity_source = ?2, identity_confidence = NULL
             WHERE meeting_id = ?3 AND speaker_label = ?4",
            params![person_id, identity_source, meeting_id, speaker_label],
        )?;
        Ok(())
    }

    pub fn speaker_segments(
        &self,
        meeting_id: &str,
        speaker_label: &str,
    ) -> AppResult<Vec<TranscriptSegment>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, meeting_id, speaker_label, person_id, identity_source,
                    identity_confidence, start_ms, end_ms, text
             FROM transcript_segments
             WHERE meeting_id = ?1 AND speaker_label = ?2
             ORDER BY (end_ms - start_ms) DESC",
        )?;
        let rows = statement.query_map(params![meeting_id, speaker_label], |row| {
            Ok(TranscriptSegment {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                speaker_label: row.get(2)?,
                person_id: row.get(3)?,
                identity_source: row.get(4)?,
                identity_confidence: row.get(5)?,
                start_ms: row.get(6)?,
                end_ms: row.get(7)?,
                text: row.get(8)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn chat_messages(&self, scope_type: &str, scope_id: &str) -> AppResult<Vec<ChatMessage>> {
        validate_chat_scope(scope_type)?;
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, scope_type, scope_id, role, content, position, created_at
             FROM chat_messages
             WHERE scope_type = ?1 AND scope_id = ?2
             ORDER BY position",
        )?;
        let rows = statement.query_map(params![scope_type, scope_id], map_chat_message)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn prepare_chat_user_message(
        &self,
        scope_type: &str,
        scope_id: &str,
        content: String,
        message_id: Option<&str>,
        client_message_id: Option<&str>,
    ) -> AppResult<ChatMessage> {
        validate_chat_scope(scope_type)?;
        let content = required_text(content, "Message")?;
        if content.chars().count() > MAX_CHAT_MESSAGE_CHARACTERS {
            return Err(AppError::Validation(format!(
                "Messages can be up to {MAX_CHAT_MESSAGE_CHARACTERS} characters"
            )));
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;

        let message = if let Some(message_id) = message_id {
            let existing = transaction
                .query_row(
                    "SELECT id, scope_type, scope_id, role, content, position, created_at
                     FROM chat_messages WHERE id = ?1",
                    [message_id],
                    map_chat_message,
                )
                .optional()?
                .ok_or(AppError::NotFound("Chat message"))?;
            if existing.scope_type != scope_type
                || existing.scope_id != scope_id
                || existing.role != "user"
            {
                return Err(AppError::Validation(
                    "Only a user message in this conversation can be resent".to_string(),
                ));
            }
            transaction.execute(
                "UPDATE chat_messages SET content = ?1 WHERE id = ?2",
                params![content, message_id],
            )?;
            transaction.execute(
                "DELETE FROM chat_messages
                 WHERE scope_type = ?1 AND scope_id = ?2 AND position > ?3",
                params![scope_type, scope_id, existing.position],
            )?;
            ChatMessage {
                content,
                ..existing
            }
        } else {
            let id = match client_message_id {
                Some(id) => Uuid::parse_str(id)
                    .map_err(|_| AppError::Validation("Chat message ID is invalid".to_string()))?
                    .to_string(),
                None => Uuid::new_v4().to_string(),
            };
            let position: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM chat_messages
                 WHERE scope_type = ?1 AND scope_id = ?2",
                params![scope_type, scope_id],
                |row| row.get(0),
            )?;
            let message = ChatMessage {
                id,
                scope_type: scope_type.to_string(),
                scope_id: scope_id.to_string(),
                role: "user".to_string(),
                content,
                position,
                created_at: Utc::now().to_rfc3339(),
            };
            insert_chat_message(&transaction, &message)?;
            message
        };

        transaction.commit()?;
        Ok(message)
    }

    pub fn append_chat_assistant_message(
        &self,
        scope_type: &str,
        scope_id: &str,
        content: String,
    ) -> AppResult<ChatMessage> {
        validate_chat_scope(scope_type)?;
        let content = required_text(content, "Assistant response")?;
        let connection = self.connection()?;
        let position: i64 = connection.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM chat_messages
             WHERE scope_type = ?1 AND scope_id = ?2",
            params![scope_type, scope_id],
            |row| row.get(0),
        )?;
        let message = ChatMessage {
            id: Uuid::new_v4().to_string(),
            scope_type: scope_type.to_string(),
            scope_id: scope_id.to_string(),
            role: "assistant".to_string(),
            content,
            position,
            created_at: Utc::now().to_rfc3339(),
        };
        insert_chat_message(&connection, &message)?;
        Ok(message)
    }

    pub fn begin_recording(&self, id: &str, audio_directory: &str) -> AppResult<Meeting> {
        self.connection()?.execute(
            "UPDATE meetings SET status = 'recording', started_at = COALESCE(started_at, ?1), ended_at = NULL,
                    audio_directory = ?2, error_message = NULL WHERE id = ?3",
            params![Utc::now().to_rfc3339(), audio_directory, id],
        )?;
        self.meeting(id)
    }

    pub fn finish_recording(&self, id: &str, duration_ms: i64) -> AppResult<Meeting> {
        self.connection()?.execute(
            "UPDATE meetings SET status = 'ready', ended_at = ?1,
                    duration_ms = duration_ms + ?2 WHERE id = ?3",
            params![Utc::now().to_rfc3339(), duration_ms, id],
        )?;
        self.meeting(id)
    }

    pub fn recover_interrupted_recording(&self, id: &str, duration_ms: i64) -> AppResult<Meeting> {
        self.connection()?.execute(
            "UPDATE meetings SET status = 'ready', ended_at = ?1, duration_ms = ?2,
                    error_message = NULL WHERE id = ?3 AND status = 'recording'",
            params![Utc::now().to_rfc3339(), duration_ms, id],
        )?;
        self.meeting(id)
    }

    pub fn mark_processing(&self, id: &str) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE meetings SET status = 'processing', error_message = NULL WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    pub fn mark_ready(&self, id: &str) -> AppResult<Meeting> {
        self.connection()?
            .execute("UPDATE meetings SET status = 'ready' WHERE id = ?1", [id])?;
        self.meeting(id)
    }

    pub fn mark_failed(&self, id: &str, message: &str) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE meetings SET status = 'failed', error_message = ?1 WHERE id = ?2",
            params![message, id],
        )?;
        Ok(())
    }

    pub fn replace_segments(
        &self,
        meeting_id: &str,
        segments: Vec<TranscriptSegment>,
    ) -> AppResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "DELETE FROM transcript_segments WHERE meeting_id = ?1",
            [meeting_id],
        )?;
        for segment in segments {
            transaction.execute(
                "INSERT INTO transcript_segments(
                    id, meeting_id, speaker_label, person_id, identity_source,
                    identity_confidence, start_ms, end_ms, text, raw_text
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![
                    segment.id,
                    segment.meeting_id,
                    segment.speaker_label,
                    segment.person_id,
                    segment.identity_source,
                    segment.identity_confidence,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn update_segment_texts(
        &self,
        meeting_id: &str,
        segments: &[TranscriptSegment],
    ) -> AppResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;

        for segment in segments {
            if transaction.execute(
                "UPDATE transcript_segments SET text = ?1 WHERE id = ?2 AND meeting_id = ?3",
                params![segment.text, segment.id, meeting_id],
            )? != 1
            {
                return Err(AppError::Validation(
                    "Transcript changed while it was being refined".to_string(),
                ));
            }
        }

        transaction.commit()?;
        Ok(())
    }

    pub fn delete_transcript_segments(
        &self,
        mut ids: Vec<String>,
    ) -> AppResult<Vec<TranscriptSegmentBackup>> {
        ids.sort();
        ids.dedup();
        if ids.is_empty() || ids.len() > 500 {
            return Err(AppError::Validation(
                "Choose between 1 and 500 transcript segments".to_string(),
            ));
        }

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let mut deleted = Vec::with_capacity(ids.len());
        for id in ids {
            let backup = transaction
                .query_row(
                    "SELECT id, meeting_id, speaker_label, person_id, identity_source,
                            identity_confidence, start_ms, end_ms, text, raw_text
                     FROM transcript_segments WHERE id = ?1",
                    [&id],
                    |row| {
                        Ok(TranscriptSegmentBackup {
                            segment: TranscriptSegment {
                                id: row.get(0)?,
                                meeting_id: row.get(1)?,
                                speaker_label: row.get(2)?,
                                person_id: row.get(3)?,
                                identity_source: row.get(4)?,
                                identity_confidence: row.get(5)?,
                                start_ms: row.get(6)?,
                                end_ms: row.get(7)?,
                                text: row.get(8)?,
                            },
                            raw_text: row.get(9)?,
                        })
                    },
                )
                .optional()?
                .ok_or(AppError::NotFound("Transcript segment"))?;
            transaction.execute("DELETE FROM transcript_segments WHERE id = ?1", [&id])?;
            deleted.push(backup);
        }
        transaction.commit()?;
        deleted.sort_by_key(|backup| backup.segment.start_ms);
        Ok(deleted)
    }

    pub fn restore_transcript_segments(
        &self,
        backups: Vec<TranscriptSegmentBackup>,
    ) -> AppResult<()> {
        if backups.is_empty() || backups.len() > 500 {
            return Err(AppError::Validation(
                "Restore requires between 1 and 500 transcript segments".to_string(),
            ));
        }

        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for backup in backups {
            let segment = backup.segment;
            transaction.execute(
                "INSERT INTO transcript_segments(
                    id, meeting_id, speaker_label, person_id, identity_source,
                    identity_confidence, start_ms, end_ms, text, raw_text
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    segment.id,
                    segment.meeting_id,
                    segment.speaker_label,
                    segment.person_id,
                    segment.identity_source,
                    segment.identity_confidence,
                    segment.start_ms,
                    segment.end_ms,
                    segment.text,
                    backup.raw_text,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }
}

fn map_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: row.get(0)?,
        project_id: row.get(1)?,
        folder_id: row.get(2)?,
        position: row.get(3)?,
        title: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        started_at: row.get(7)?,
        ended_at: row.get(8)?,
        duration_ms: row.get(9)?,
        audio_directory: row.get(10)?,
        error_message: row.get(11)?,
    })
}

fn map_transcript_segment(row: &rusqlite::Row<'_>) -> rusqlite::Result<TranscriptSegment> {
    Ok(TranscriptSegment {
        id: row.get(0)?,
        meeting_id: row.get(1)?,
        speaker_label: row.get(2)?,
        person_id: row.get(3)?,
        identity_source: row.get(4)?,
        identity_confidence: row.get(5)?,
        start_ms: row.get(6)?,
        end_ms: row.get(7)?,
        text: row.get(8)?,
    })
}

fn map_chat_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    Ok(ChatMessage {
        id: row.get(0)?,
        scope_type: row.get(1)?,
        scope_id: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        position: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn insert_chat_message(connection: &Connection, message: &ChatMessage) -> AppResult<()> {
    connection.execute(
        "INSERT INTO chat_messages(id, scope_type, scope_id, role, content, position, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            message.id,
            message.scope_type,
            message.scope_id,
            message.role,
            message.content,
            message.position,
            message.created_at,
        ],
    )?;
    Ok(())
}

fn validate_chat_scope(scope_type: &str) -> AppResult<()> {
    if matches!(scope_type, "meeting" | "project") {
        Ok(())
    } else {
        Err(AppError::Validation(
            "Unknown conversation scope".to_string(),
        ))
    }
}

fn required_text(value: String, label: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(format!("{label} is required")));
    }
    Ok(trimmed.to_string())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn thumbnail_photo_data_url(data_url: &str) -> Option<String> {
    let (metadata, encoded) = data_url.split_once(',')?;
    if !matches!(
        metadata,
        "data:image/png;base64" | "data:image/jpeg;base64" | "data:image/jpg;base64"
    ) {
        return None;
    }
    let bytes = BASE64.decode(encoded).ok()?;
    let image = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let thumbnail = image.thumbnail(MAX_AVATAR_EDGE, MAX_AVATAR_EDGE);
    let mut output = Vec::new();
    thumbnail
        .write_to(&mut Cursor::new(&mut output), ImageFormat::WebP)
        .ok()?;
    Some(format!("data:image/webp;base64,{}", BASE64.encode(output)))
}

fn legacy_voiceprint(value: &str) -> Option<String> {
    if let Some(encoded) = value.strip_prefix("pyannote:v1:") {
        return serde_json::from_str::<serde_json::Value>(encoded)
            .ok()?
            .get("voiceprint")?
            .as_str()
            .filter(|voiceprint| !voiceprint.trim().is_empty())
            .map(ToOwned::to_owned);
    }
    value
        .strip_prefix("pyannote:")
        .filter(|voiceprint| !voiceprint.trim().is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, GenericImageView, Rgba, RgbaImage};

    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().to_path_buf()).expect("database");
        (directory, database)
    }

    #[test]
    fn avatar_thumbnail_bounds_large_images_without_losing_alpha() {
        let source =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(512, 384, Rgba([20, 40, 60, 0])));
        let mut encoded = Vec::new();
        source
            .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
            .expect("encode source image");
        let data_url = format!("data:image/png;base64,{}", BASE64.encode(encoded));
        let animated_or_vector = data_url.replacen("image/png", "image/gif", 1);

        let thumbnail = thumbnail_photo_data_url(&data_url).expect("thumbnail");
        let bytes = BASE64
            .decode(thumbnail.split_once(',').expect("data URL").1)
            .expect("thumbnail bytes");
        let decoded = image::load_from_memory(&bytes).expect("decode thumbnail");

        assert_eq!(decoded.dimensions(), (256, 192));
        assert_eq!(decoded.to_rgba8().get_pixel(0, 0).0[3], 0);
        assert_eq!(thumbnail_photo_data_url(&animated_or_vector), None);
    }

    #[test]
    fn avatar_migration_preserves_the_original_until_the_user_replaces_it() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(512, 384, Rgba([20, 40, 60, 255])));
        let mut encoded = Vec::new();
        source
            .write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png)
            .expect("encode source image");
        let data_url = format!("data:image/png;base64,{}", BASE64.encode(encoded));

        let database = Database::open(directory.path().to_path_buf()).expect("database");
        let person = database
            .create_person(PersonDraft {
                full_name: "Speaker".to_string(),
                nickname: None,
                photo_data_url: Some(data_url.clone()),
            })
            .expect("person");
        drop(database);

        let database = Database::open(directory.path().to_path_buf()).expect("reopened database");
        let migrated = database
            .people()
            .expect("people")
            .into_iter()
            .find(|candidate| candidate.id == person.id)
            .expect("migrated person");
        assert!(migrated
            .photo_data_url
            .as_deref()
            .is_some_and(|photo| photo.starts_with("data:image/webp;base64,")));
        let preserved: Option<String> = database
            .connection()
            .expect("connection")
            .query_row(
                "SELECT photo_original_data_url FROM people WHERE id = ?1",
                [&person.id],
                |row| row.get(0),
            )
            .expect("preserved original");
        assert_eq!(preserved.as_deref(), Some(data_url.as_str()));

        database
            .update_person(
                &person.id,
                PersonDraft {
                    full_name: person.full_name,
                    nickname: person.nickname,
                    photo_data_url: None,
                },
            )
            .expect("remove photo");
        let preserved: Option<String> = database
            .connection()
            .expect("connection")
            .query_row(
                "SELECT photo_original_data_url FROM people WHERE id = ?1",
                [&person.id],
                |row| row.get(0),
            )
            .expect("cleared original");
        assert_eq!(preserved, None);
    }

    #[test]
    fn meeting_segment_queries_do_not_load_the_rest_of_the_library() {
        let (_directory, database) = database();
        let first = database
            .create_meeting(MeetingDraft {
                title: "First".to_string(),
                project_id: None,
            })
            .expect("first meeting");
        let second = database
            .create_meeting(MeetingDraft {
                title: "Second".to_string(),
                project_id: None,
            })
            .expect("second meeting");
        let person = database
            .create_person(PersonDraft {
                full_name: "Speaker".to_string(),
                nickname: None,
                photo_data_url: None,
            })
            .expect("person");
        for meeting in [&first, &second] {
            database
                .replace_segments(
                    &meeting.id,
                    vec![TranscriptSegment {
                        id: Uuid::new_v4().to_string(),
                        meeting_id: meeting.id.clone(),
                        speaker_label: "A".to_string(),
                        person_id: Some(person.id.clone()),
                        identity_source: Some("manual".to_string()),
                        identity_confidence: None,
                        start_ms: 0,
                        end_ms: if meeting.id == first.id { 500 } else { 1_500 },
                        text: meeting.title.clone(),
                    }],
                )
                .expect("segments");
        }

        let scoped = database
            .segments_for_meeting(&first.id)
            .expect("scoped segments");
        let best = database
            .best_assigned_segment_for_person(&person.id)
            .expect("best segment")
            .expect("assigned segment");

        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].meeting_id, first.id);
        assert_eq!(best.meeting_id, second.id);
    }

    #[test]
    fn creates_and_moves_meetings_between_collections() {
        let (_directory, database) = database();
        let project = database
            .create_project(ProjectDraft {
                name: "Soccer video".to_string(),
            })
            .expect("project");
        let meeting = database
            .create_meeting(MeetingDraft {
                title: "Gameplay review".to_string(),
                project_id: None,
            })
            .expect("meeting");

        let moved = database
            .move_meeting(&meeting.id, Some(project.id.clone()))
            .expect("move meeting");

        assert_eq!(moved.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(database.meetings().expect("meetings").len(), 1);
    }

    #[test]
    fn persists_recording_order_across_projects() {
        let (_directory, database) = database();
        let project = database
            .create_project(ProjectDraft {
                name: "Release".to_string(),
            })
            .expect("project");
        let first = database
            .create_meeting(MeetingDraft {
                title: "First".to_string(),
                project_id: None,
            })
            .expect("first meeting");
        let second = database
            .create_meeting(MeetingDraft {
                title: "Second".to_string(),
                project_id: None,
            })
            .expect("second meeting");

        database
            .reorder_meetings(vec![
                MeetingPlacement {
                    id: first.id.clone(),
                    project_id: Some(project.id.clone()),
                    folder_id: None,
                    position: 0,
                },
                MeetingPlacement {
                    id: second.id.clone(),
                    project_id: Some(project.id.clone()),
                    folder_id: None,
                    position: 1,
                },
            ])
            .expect("reorder meetings");

        let meetings = database.meetings().expect("meetings");
        assert_eq!(meetings[0].id, first.id);
        assert_eq!(meetings[0].position, 0);
        assert_eq!(meetings[1].id, second.id);
        assert_eq!(meetings[1].position, 1);
    }

    #[test]
    fn nests_folders_and_relocates_contents_when_a_folder_is_deleted() {
        let (_directory, database) = database();
        let project = database
            .create_project(ProjectDraft {
                name: "Leads".to_string(),
            })
            .expect("project");
        let parent = database
            .create_folder(FolderDraft {
                project_id: project.id.clone(),
                parent_id: None,
                name: "2026".to_string(),
            })
            .expect("parent folder");
        let child = database
            .create_folder(FolderDraft {
                project_id: project.id.clone(),
                parent_id: Some(parent.id.clone()),
                name: "August".to_string(),
            })
            .expect("child folder");
        let meeting = database
            .create_meeting(MeetingDraft {
                title: "Leads 2026-8-26".to_string(),
                project_id: Some(project.id.clone()),
            })
            .expect("meeting");
        database
            .reorder_meetings(vec![MeetingPlacement {
                id: meeting.id.clone(),
                project_id: Some(project.id.clone()),
                folder_id: Some(child.id.clone()),
                position: 0,
            }])
            .expect("move meeting into folder");

        assert!(database
            .move_folder(&parent.id, Some(child.id.clone()))
            .is_err());

        database.delete_folder(&child.id).expect("delete folder");
        let meetings = database.meetings().expect("meetings");
        assert_eq!(
            meetings[0].folder_id.as_deref(),
            Some(parent.id.as_str()),
            "meeting should move up to the deleted folder's parent"
        );
        assert_eq!(database.folders().expect("folders").len(), 1);

        database.delete_project(&project.id).expect("delete project");
        let meetings = database.meetings().expect("meetings");
        assert_eq!(meetings[0].project_id, None);
        assert_eq!(meetings[0].folder_id, None);
        assert!(database.folders().expect("folders").is_empty());
    }

    #[test]
    fn deleted_recording_can_be_restored_with_its_transcript() {
        let (_directory, database) = database();
        let meeting = database
            .create_meeting(MeetingDraft {
                title: "Recoverable".to_string(),
                project_id: None,
            })
            .expect("meeting");
        database
            .replace_segments(
                &meeting.id,
                vec![TranscriptSegment {
                    id: Uuid::new_v4().to_string(),
                    meeting_id: meeting.id.clone(),
                    speaker_label: "A".to_string(),
                    person_id: None,
                    identity_source: None,
                    identity_confidence: None,
                    start_ms: 0,
                    end_ms: 500,
                    text: "Still here".to_string(),
                }],
            )
            .expect("segments");

        database
            .delete_meeting(&meeting.id)
            .expect("delete meeting");
        assert!(database.meetings().expect("hidden meetings").is_empty());
        assert!(database.segments().expect("hidden segments").is_empty());

        database
            .restore_meeting(&meeting.id)
            .expect("restore meeting");
        assert_eq!(database.meetings().expect("meetings").len(), 1);
        assert_eq!(database.segments().expect("segments")[0].text, "Still here");
    }

    #[test]
    fn deleting_a_person_preserves_transcript_text() {
        let (_directory, database) = database();
        let meeting = database
            .create_meeting(MeetingDraft {
                title: "Planning".to_string(),
                project_id: None,
            })
            .expect("meeting");
        let person = database
            .create_person(PersonDraft {
                full_name: "Ben Carter".to_string(),
                nickname: Some("Ben".to_string()),
                photo_data_url: None,
            })
            .expect("person");
        database
            .replace_segments(
                &meeting.id,
                vec![TranscriptSegment {
                    id: Uuid::new_v4().to_string(),
                    meeting_id: meeting.id.clone(),
                    speaker_label: "A".to_string(),
                    person_id: Some(person.id.clone()),
                    identity_source: Some("manual".to_string()),
                    identity_confidence: None,
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "Keep this sentence.".to_string(),
                }],
            )
            .expect("segments");

        database.delete_person(&person.id).expect("delete person");
        let segments = database.segments().expect("segments");

        assert_eq!(segments[0].text, "Keep this sentence.");
        assert_eq!(segments[0].person_id, None);
    }

    #[test]
    fn refined_text_keeps_the_original_transcription() {
        let (_directory, database) = database();
        let meeting = database
            .create_meeting(MeetingDraft {
                title: "Planning".to_string(),
                project_id: None,
            })
            .expect("meeting");
        let original = TranscriptSegment {
            id: Uuid::new_v4().to_string(),
            meeting_id: meeting.id.clone(),
            speaker_label: "A".to_string(),
            person_id: None,
            identity_source: None,
            identity_confidence: None,
            start_ms: 0,
            end_ms: 1_000,
            text: "We tested hearing codecs.".to_string(),
        };
        database
            .replace_segments(&meeting.id, vec![original.clone()])
            .expect("original transcript");
        database
            .update_segment_texts(
                &meeting.id,
                &[TranscriptSegment {
                    text: "We tested hearing Codex.".to_string(),
                    ..original
                }],
            )
            .expect("refined transcript");

        let connection = database.connection().expect("connection");
        let (text, raw_text) = connection
            .query_row(
                "SELECT text, raw_text FROM transcript_segments WHERE meeting_id = ?1",
                [&meeting.id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("stored text");

        assert_eq!(text, "We tested hearing Codex.");
        assert_eq!(raw_text, "We tested hearing codecs.");
    }

    #[test]
    fn voice_profile_lifecycle_without_consent() {
        let (_directory, database) = database();
        let vinicius = database
            .create_person(PersonDraft {
                full_name: "Vinicius".to_string(),
                nickname: None,
                photo_data_url: None,
            })
            .expect("Vinicius");

        // A freshly-created person has no profile row; learning creates one.
        database
            .mark_voice_profile_learning(&vinicius.id)
            .expect("learning starts without any prior row");
        database
            .mark_voice_profile_failed(
                &vinicius.id,
                "Attribute password encoded as UTF-16 is longer than platform limit",
            )
            .expect("record legacy storage failure");
        database
            .recover_interrupted_voice_profiles()
            .expect("recover legacy storage failure");
        assert_eq!(
            database.people().expect("people")[0]
                .voice_profile
                .as_ref()
                .expect("voice profile")
                .status,
            "pending_sample"
        );
        database
            .save_voice_profile(
                &vinicius.id,
                "meeting",
                "precision:SPEAKER_00",
                18_000,
                3,
                "microphone",
            )
            .expect("save voice profile");

        let people = database.people().expect("people");
        let profile = people[0].voice_profile.as_ref().expect("voice profile");
        assert_eq!(profile.status, "ready");
        assert_eq!(profile.enrollment_duration_ms, Some(18_000));

        // Durable erase: the tombstone survives and blocks relearning...
        database
            .disable_voice_profile(&vinicius.id)
            .expect("disable voice profile");
        assert_eq!(
            database.people().expect("people")[0]
                .voice_profile
                .as_ref()
                .expect("tombstone row")
                .status,
            "disabled"
        );
        assert!(database.mark_voice_profile_learning(&vinicius.id).is_err());
        database
            .ensure_voice_profile(&vinicius.id)
            .expect("ensure is a no-op on a tombstone");
        assert_eq!(
            database.people().expect("people")[0]
                .voice_profile
                .as_ref()
                .expect("tombstone row")
                .status,
            "disabled"
        );

        // ...until the user re-enables automatic labeling.
        database
            .enable_voice_profile(&vinicius.id)
            .expect("re-enable");
        assert_eq!(
            database.people().expect("people")[0]
                .voice_profile
                .as_ref()
                .expect("voice profile")
                .status,
            "pending_sample"
        );
    }

    #[test]
    fn legacy_voiceprint_rows_migrate_as_ready() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().to_path_buf()).expect("database");
        let person = database
            .create_person(PersonDraft {
                full_name: "Legacy".to_string(),
                nickname: None,
                photo_data_url: None,
            })
            .expect("person");
        database
            .connection()
            .expect("connection")
            .execute(
                "UPDATE people SET reference_audio_data_url = 'pyannote:print' WHERE id = ?1",
                [&person.id],
            )
            .expect("seed legacy voiceprint");

        drop(database);
        let database = Database::open(directory.path().to_path_buf()).expect("reopen");
        let people = database.people().expect("people");
        assert_eq!(
            people[0].voice_profile.as_ref().expect("profile").status,
            "ready"
        );
    }

    #[test]
    fn stale_local_speaker_is_cleared_on_settings_save() {
        let (_directory, database) = database();
        let mut settings = AppSettings::default();
        settings.local_speaker_person_id = Some("no-such-person".to_string());
        database.update_settings(&settings).expect("settings save");
        assert_eq!(
            database
                .settings()
                .expect("settings")
                .local_speaker_person_id,
            None
        );

        let person = database
            .create_person(PersonDraft {
                full_name: "Owner".to_string(),
                nickname: None,
                photo_data_url: None,
            })
            .expect("person");
        settings.local_speaker_person_id = Some(person.id.clone());
        database.update_settings(&settings).expect("settings save");
        assert_eq!(
            database
                .settings()
                .expect("settings")
                .local_speaker_person_id,
            Some(person.id)
        );
    }

    #[test]
    fn recording_again_appends_duration_and_preserves_transcript() {
        let (directory, database) = database();
        let meeting = database
            .create_meeting(MeetingDraft {
                title: "Long conversation".to_string(),
                project_id: None,
            })
            .expect("meeting");
        database
            .replace_segments(
                &meeting.id,
                vec![TranscriptSegment {
                    id: Uuid::new_v4().to_string(),
                    meeting_id: meeting.id.clone(),
                    speaker_label: "microphone:A".to_string(),
                    person_id: None,
                    identity_source: None,
                    identity_confidence: None,
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "Keep this first part.".to_string(),
                }],
            )
            .expect("segments");

        let recording_path = directory.path().join("recordings");
        database
            .begin_recording(&meeting.id, recording_path.to_str().expect("path"))
            .expect("begin recording");
        database
            .finish_recording(&meeting.id, 2_500)
            .expect("finish first recording");
        database
            .begin_recording(&meeting.id, recording_path.to_str().expect("path"))
            .expect("begin another recording");
        let updated = database
            .finish_recording(&meeting.id, 1_500)
            .expect("finish another recording");

        assert_eq!(updated.duration_ms, 4_000);
        assert_eq!(database.segments().expect("segments").len(), 1);
    }

    #[test]
    fn recovers_an_interrupted_recording_with_its_measured_duration() {
        let (directory, database) = database();
        let meeting = database
            .create_meeting(MeetingDraft {
                title: "Interrupted conversation".to_string(),
                project_id: None,
            })
            .expect("meeting");
        let recording_path = directory.path().join("recordings");
        database
            .begin_recording(&meeting.id, recording_path.to_str().expect("path"))
            .expect("begin recording");

        let recovered = database
            .recover_interrupted_recording(&meeting.id, 47_000)
            .expect("recover recording");

        assert_eq!(recovered.status, "ready");
        assert_eq!(recovered.duration_ms, 47_000);
        assert!(recovered.ended_at.is_some());
    }

    #[test]
    fn editing_a_chat_message_replaces_the_following_branch() {
        let (_directory, database) = database();
        let first = database
            .prepare_chat_user_message(
                "meeting",
                "meeting-one",
                "What was decided?".to_string(),
                None,
                Some("35fd8172-d7bb-4d55-a531-b4a38f786170"),
            )
            .expect("first question");
        database
            .append_chat_assistant_message(
                "meeting",
                "meeting-one",
                "The team chose option A.".to_string(),
            )
            .expect("first answer");
        database
            .prepare_chat_user_message("meeting", "meeting-one", "Why?".to_string(), None, None)
            .expect("follow-up");

        database
            .prepare_chat_user_message(
                "meeting",
                "meeting-one",
                "What follow-up was agreed?".to_string(),
                Some(&first.id),
                None,
            )
            .expect("edited question");

        let messages = database
            .chat_messages("meeting", "meeting-one")
            .expect("messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "What follow-up was agreed?");
        assert_eq!(messages[0].position, 0);
        assert_eq!(messages[0].id, "35fd8172-d7bb-4d55-a531-b4a38f786170");
    }

    #[test]
    fn chat_history_is_isolated_by_scope() {
        let (_directory, database) = database();
        database
            .prepare_chat_user_message("meeting", "shared", "Meeting".to_string(), None, None)
            .expect("meeting message");
        database
            .prepare_chat_user_message("project", "shared", "Project".to_string(), None, None)
            .expect("project message");

        assert_eq!(
            database
                .chat_messages("meeting", "shared")
                .expect("meeting history")[0]
                .content,
            "Meeting",
        );
        assert_eq!(
            database
                .chat_messages("project", "shared")
                .expect("project history")[0]
                .content,
            "Project",
        );
    }

    #[test]
    fn deleted_transcript_turn_can_be_restored_losslessly() {
        let (_directory, database) = database();
        let meeting = database
            .create_meeting(MeetingDraft {
                title: "Undoable transcript".to_string(),
                project_id: None,
            })
            .expect("meeting");
        let original = TranscriptSegment {
            id: Uuid::new_v4().to_string(),
            meeting_id: meeting.id.clone(),
            speaker_label: "A".to_string(),
            person_id: None,
            identity_source: Some("voiceprint".to_string()),
            identity_confidence: Some(0.91),
            start_ms: 1_200,
            end_ms: 2_800,
            text: "Raw wording".to_string(),
        };
        database
            .replace_segments(&meeting.id, vec![original.clone()])
            .expect("segments");
        let mut refined = original.clone();
        refined.text = "Refined wording.".to_string();
        database
            .update_segment_texts(&meeting.id, &[refined])
            .expect("refine");

        let backups = database
            .delete_transcript_segments(vec![original.id.clone()])
            .expect("delete");
        assert!(database.segments().expect("deleted segments").is_empty());
        assert_eq!(backups[0].raw_text.as_deref(), Some("Raw wording"));

        database
            .restore_transcript_segments(backups)
            .expect("restore");
        let restored = &database.segments().expect("restored segments")[0];
        assert_eq!(restored.text, "Refined wording.");
        assert_eq!(restored.identity_confidence, Some(0.91));
        let raw_text: String = database
            .connection()
            .expect("connection")
            .query_row(
                "SELECT raw_text FROM transcript_segments WHERE id = ?1",
                [&original.id],
                |row| row.get(0),
            )
            .expect("raw text");
        assert_eq!(raw_text, "Raw wording");
    }
}
