use std::{fs, path::PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    domain::{
        AppSettings, ChatMessage, Meeting, MeetingDraft, MeetingPlacement, Person, PersonDraft,
        Project, ProjectDraft, TranscriptSegment,
    },
    error::{AppError, AppResult},
};

const PERSON_COLORS: [&str; 6] = [
    "#d96c4a", "#477a66", "#6256a5", "#b07a28", "#3c6e9b", "#985b76",
];
const MAX_CHAT_MESSAGE_CHARACTERS: usize = 12_000;

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

            CREATE TABLE IF NOT EXISTS meetings (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
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
                reference_audio_data_url TEXT,
                color TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS transcript_segments (
                id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
                speaker_label TEXT NOT NULL,
                person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
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
        self.ensure_meeting_organization_columns()?;
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
            "SELECT id, project_id, position, title, status, created_at, started_at, ended_at,
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
                "SELECT id, project_id, position, title, status, created_at, started_at, ended_at,
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
            "SELECT id, full_name, nickname, photo_data_url, reference_audio_data_url, color, created_at
             FROM people ORDER BY COALESCE(nickname, full_name) COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(Person {
                id: row.get(0)?,
                full_name: row.get(1)?,
                nickname: row.get(2)?,
                photo_data_url: row.get(3)?,
                reference_audio_data_url: row.get(4)?,
                color: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
    }

    pub fn segments(&self) -> AppResult<Vec<TranscriptSegment>> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT segment.id, segment.meeting_id, segment.speaker_label, segment.person_id,
                    segment.start_ms, segment.end_ms, segment.text
             FROM transcript_segments segment
             JOIN meetings meeting ON meeting.id = segment.meeting_id
             WHERE meeting.deleted_at IS NULL
             ORDER BY segment.meeting_id, segment.start_ms",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(TranscriptSegment {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                speaker_label: row.get(2)?,
                person_id: row.get(3)?,
                start_ms: row.get(4)?,
                end_ms: row.get(5)?,
                text: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(AppError::from)
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

    pub fn update_settings(&self, settings: &AppSettings) -> AppResult<()> {
        let value = serde_json::to_string(settings)
            .map_err(|error| AppError::Validation(error.to_string()))?;
        self.connection()?.execute(
            "INSERT INTO settings(key, value) VALUES('app', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [value],
        )?;
        Ok(())
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

    pub fn create_meeting(&self, draft: MeetingDraft) -> AppResult<Meeting> {
        let title = required_text(draft.title, "Meeting title")?;
        let meeting = Meeting {
            id: Uuid::new_v4().to_string(),
            project_id: draft.project_id,
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
             WHERE project_id IS ?1 AND deleted_at IS NULL",
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
             WHERE project_id IS ?1 AND deleted_at IS NULL",
            params![project_id],
            |row| row.get(0),
        )?;
        connection.execute(
            "UPDATE meetings SET project_id = ?1, position = ?2 WHERE id = ?3",
            params![project_id, position, id],
        )?;
        self.meeting(id)
    }

    pub fn reorder_meetings(&self, placements: Vec<MeetingPlacement>) -> AppResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        for placement in placements {
            if transaction.execute(
                "UPDATE meetings SET project_id = ?1, position = ?2
                 WHERE id = ?3 AND deleted_at IS NULL",
                params![placement.project_id, placement.position, placement.id],
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
            reference_audio_data_url: clean_optional(draft.reference_audio_data_url),
            color: PERSON_COLORS[count as usize % PERSON_COLORS.len()].to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        connection.execute(
            "INSERT INTO people(id, full_name, nickname, photo_data_url, reference_audio_data_url, color, created_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![person.id, person.full_name, person.nickname, person.photo_data_url, person.reference_audio_data_url, person.color, person.created_at],
        )?;
        Ok(person)
    }

    pub fn update_person(&self, id: &str, draft: PersonDraft) -> AppResult<Person> {
        self.connection()?.execute(
            "UPDATE people SET full_name = ?1, nickname = ?2, photo_data_url = ?3, reference_audio_data_url = ?4
             WHERE id = ?5",
            params![
                required_text(draft.full_name, "Full name")?,
                clean_optional(draft.nickname),
                clean_optional(draft.photo_data_url),
                clean_optional(draft.reference_audio_data_url),
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

    pub fn assign_speaker(
        &self,
        meeting_id: &str,
        speaker_label: &str,
        person_id: Option<String>,
    ) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE transcript_segments SET person_id = ?1 WHERE meeting_id = ?2 AND speaker_label = ?3",
            params![person_id, meeting_id, speaker_label],
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
            "SELECT id, meeting_id, speaker_label, person_id, start_ms, end_ms, text
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
                start_ms: row.get(4)?,
                end_ms: row.get(5)?,
                text: row.get(6)?,
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
            let position: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM chat_messages
                 WHERE scope_type = ?1 AND scope_id = ?2",
                params![scope_type, scope_id],
                |row| row.get(0),
            )?;
            let message = ChatMessage {
                id: Uuid::new_v4().to_string(),
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

    pub fn claim_person_reference(&self, person_id: &str, data_url: &str) -> AppResult<()> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "UPDATE people SET reference_audio_data_url = NULL
             WHERE id != ?1 AND reference_audio_data_url = ?2",
            params![person_id, data_url],
        )?;
        transaction.execute(
            "UPDATE people
             SET reference_audio_data_url = ?1
             WHERE id = ?2",
            params![data_url, person_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn clear_person_reference(&self, person_id: &str) -> AppResult<()> {
        self.connection()?.execute(
            "UPDATE people SET reference_audio_data_url = NULL WHERE id = ?1",
            [person_id],
        )?;
        Ok(())
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
                    id, meeting_id, speaker_label, person_id, start_ms, end_ms, text, raw_text
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    segment.id,
                    segment.meeting_id,
                    segment.speaker_label,
                    segment.person_id,
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
}

fn map_meeting(row: &rusqlite::Row<'_>) -> rusqlite::Result<Meeting> {
    Ok(Meeting {
        id: row.get(0)?,
        project_id: row.get(1)?,
        position: row.get(2)?,
        title: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        started_at: row.get(6)?,
        ended_at: row.get(7)?,
        duration_ms: row.get(8)?,
        audio_directory: row.get(9)?,
        error_message: row.get(10)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database = Database::open(directory.path().to_path_buf()).expect("database");
        (directory, database)
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
                    position: 0,
                },
                MeetingPlacement {
                    id: second.id.clone(),
                    project_id: Some(project.id.clone()),
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
                reference_audio_data_url: None,
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
    fn moves_an_identical_voice_reference_to_its_new_owner() {
        let (_directory, database) = database();
        let max = database
            .create_person(PersonDraft {
                full_name: "Max".to_string(),
                nickname: None,
                photo_data_url: None,
                reference_audio_data_url: Some("data:audio/wav;base64,voice".to_string()),
            })
            .expect("Max");
        let vinicius = database
            .create_person(PersonDraft {
                full_name: "Vinicius".to_string(),
                nickname: None,
                photo_data_url: None,
                reference_audio_data_url: None,
            })
            .expect("Vinicius");

        database
            .claim_person_reference(&vinicius.id, "data:audio/wav;base64,voice")
            .expect("claim voice");

        let people = database.people().expect("people");
        assert!(people
            .iter()
            .find(|person| person.id == max.id)
            .expect("Max")
            .reference_audio_data_url
            .is_none());
        assert_eq!(
            people
                .iter()
                .find(|person| person.id == vinicius.id)
                .expect("Vinicius")
                .reference_audio_data_url
                .as_deref(),
            Some("data:audio/wav;base64,voice"),
        );
    }

    #[test]
    fn relearning_a_voice_replaces_the_previous_reference() {
        let (_directory, database) = database();
        let vinicius = database
            .create_person(PersonDraft {
                full_name: "Vinicius".to_string(),
                nickname: None,
                photo_data_url: None,
                reference_audio_data_url: Some("data:audio/wav;base64,existing".to_string()),
            })
            .expect("Vinicius");

        database
            .claim_person_reference(&vinicius.id, "data:audio/wav;base64,new")
            .expect("claim voice");

        let people = database.people().expect("people");
        assert_eq!(
            people
                .iter()
                .find(|person| person.id == vinicius.id)
                .expect("Vinicius")
                .reference_audio_data_url
                .as_deref(),
            Some("data:audio/wav;base64,new"),
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
    fn editing_a_chat_message_replaces_the_following_branch() {
        let (_directory, database) = database();
        let first = database
            .prepare_chat_user_message(
                "meeting",
                "meeting-one",
                "What was decided?".to_string(),
                None,
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
            .prepare_chat_user_message("meeting", "meeting-one", "Why?".to_string(), None)
            .expect("follow-up");

        database
            .prepare_chat_user_message(
                "meeting",
                "meeting-one",
                "What follow-up was agreed?".to_string(),
                Some(&first.id),
            )
            .expect("edited question");

        let messages = database
            .chat_messages("meeting", "meeting-one")
            .expect("messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "What follow-up was agreed?");
        assert_eq!(messages[0].position, 0);
    }

    #[test]
    fn chat_history_is_isolated_by_scope() {
        let (_directory, database) = database();
        database
            .prepare_chat_user_message("meeting", "shared", "Meeting".to_string(), None)
            .expect("meeting message");
        database
            .prepare_chat_user_message("project", "shared", "Project".to_string(), None)
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
}
