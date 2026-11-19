use std::{
    fs::{self, File},
    io::ErrorKind,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use crate::{
    database::Database,
    domain::{Meeting, MeetingDraft},
    error::{AppError, AppResult},
    media_decode, speech_audio,
};

const STAGING_DIRECTORY: &str = ".media-import-stage";

/// The lock covers only imports, and is released by the OS if Listen exits.
/// Recording, transcription and playback in other meetings can continue.
fn try_lock(root: &Path) -> AppResult<Option<File>> {
    crate::try_lock_file(&root.join(".media-import.lock"))
}

fn track_path(directory: &Path, session: i64) -> PathBuf {
    // A media file is independent of the user's microphone. Giving it its own
    // system-audio session also keeps its timestamps after all prior sessions.
    directory.join(format!("system-{session}-import.wav"))
}

fn clean_staging(database: &Database, root: &Path) -> AppResult<()> {
    for (id, directory, session) in database.pending_media_imports()? {
        match fs::remove_file(track_path(&directory, session)) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        database.clear_pending_media_import(&id)?;
    }
    match fs::remove_dir_all(root.join(STAGING_DIRECTORY)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub fn recover(database: &Database, root: &Path) -> AppResult<()> {
    if root.join(STAGING_DIRECTORY).exists() {
        if let Some(_lock) = try_lock(root)? {
            clean_staging(database, root)?;
        }
    }
    Ok(())
}

pub fn import(
    database: &Database,
    root: &Path,
    meeting_id: Option<&str>,
    draft: Option<MeetingDraft>,
    input: &Path,
    progress: impl FnMut(f32),
) -> AppResult<Meeting> {
    let (id, directory) = match (meeting_id, &draft) {
        (Some(id), None) => {
            let meeting = database.meeting(id)?;
            let directory = meeting
                .audio_directory
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join(&meeting.id));
            (meeting.id, directory)
        }
        (None, Some(draft)) if !draft.title.trim().is_empty() => {
            let id = Uuid::new_v4().to_string();
            let directory = root.join(&id);
            (id, directory)
        }
        _ => {
            return Err(AppError::Validation(
                "Choose a meeting or provide a title for a new meeting.".into(),
            ))
        }
    };
    if !input.is_absolute() || !fs::metadata(input)?.is_file() {
        return Err(AppError::Validation(
            "Choose a local audio or video file.".into(),
        ));
    }

    fs::create_dir_all(root)?;
    let _lock = try_lock(root)?
        .ok_or_else(|| AppError::Validation("Another media import is in progress.".into()))?;
    clean_staging(database, root)?;
    let staging = root.join(STAGING_DIRECTORY);
    fs::create_dir(&staging)?;
    let result = (|| {
        fs::create_dir_all(&directory)?;
        let session = database.reserve_media_import(&id, draft.is_some(), &directory, || {
            speech_audio::next_session_id(&directory)
        })?;
        let target = track_path(&directory, session);
        let prior_duration = speech_audio::recording_duration_ms(&directory)?;
        let temporary = staging.join("audio.wav.part");
        let imported_ms = media_decode::decode_to_wav(input, &temporary, progress)?;
        // The existing whole-meeting player and transcription engine share a RIFF/WAV mix.
        let max_ms =
            (u32::MAX as i64 - 44) * 1000 / (i64::from(speech_audio::SPEECH_SAMPLE_RATE) * 2);
        if prior_duration.saturating_add(imported_ms) > max_ms {
            return Err(AppError::Validation(
                "This file would exceed the 37-hour meeting audio limit.".into(),
            ));
        }
        database.finish_media_import(&id, draft, &directory, prior_duration, imported_ms, || {
            fs::rename(&temporary, &target)?;
            Ok(())
        })
    })();
    // On a failed SQLite commit, the pending row survives and the published
    // file is rolled back. On a crash the same cleanup runs at the next launch.
    let cleanup = clean_staging(database, root);
    if result.is_err() {
        // A failed draft import may have created its destination directory.
        // remove_dir touches only an empty directory, never an existing track.
        if meeting_id.is_none() {
            let _ = fs::remove_dir(&directory);
        }
        cleanup?;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::TranscriptSegment;

    fn draft() -> MeetingDraft {
        MeetingDraft {
            title: "Archive".into(),
            project_id: None,
        }
    }

    fn wav(path: &Path, level: i16) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: speech_audio::SPEECH_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for _ in 0..spec.sample_rate {
            writer.write_sample(level).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn segment(meeting: &str, id: &str, start_ms: i64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            id: id.into(),
            meeting_id: meeting.into(),
            speaker_label: "voice:1".into(),
            person_id: None,
            identity_source: None,
            identity_confidence: None,
            start_ms,
            end_ms: start_ms + 200,
            text: text.into(),
        }
    }

    #[test]
    fn append_preserves_the_timeline_and_an_edited_transcript_across_retries() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(temp.path().into()).unwrap();
        let root = temp.path().join("recordings");
        let first = temp.path().join("first.wav");
        let second = temp.path().join("second.wav");
        wav(&first, 450);
        wav(&second, -450);
        let original = fs::read(&first).unwrap();
        let imported = import(&db, &root, None, Some(draft()), &first, |_| {}).unwrap();
        let id = &imported.id;
        assert_eq!(
            (imported.status.as_str(), imported.duration_ms),
            ("processing", 1_000)
        );
        assert!(db.import_transcription_boundary(id).unwrap().is_none());
        let directory = PathBuf::from(imported.audio_directory.unwrap());
        let initial_mix = speech_audio::export_mixed_recording(&directory).unwrap();
        let original_line = segment(id, "saved-link", 100, "Edited text");
        db.store_transcription_segments(id, &[original_line], None)
            .unwrap();
        db.mark_ready(id).unwrap();

        let appended = import(&db, &root, Some(id), None, &second, |_| {}).unwrap();
        let (session, offset) = db.import_transcription_boundary(id).unwrap().unwrap();
        assert_eq!((appended.duration_ms, offset), (2_000, 1_000));
        assert_eq!(fs::read(&first).unwrap(), original);
        let mix = speech_audio::export_mixed_recording(&directory).unwrap();
        assert_ne!(initial_mix, mix);
        let samples: Vec<i16> = hound::WavReader::open(mix)
            .unwrap()
            .into_samples()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(samples.len(), 32_000);
        assert!(samples[8_000] > 0 && samples[24_000] < 0);
        assert_eq!(
            speech_audio::active_capture_sources(&directory).unwrap(),
            ["system"]
        );

        // Simulate interruption after saving ASR, before marking the meeting ready.
        let interrupted_line = segment(id, "first-attempt", offset + 100, "Unpolished");
        db.store_transcription_segments(id, &[interrupted_line], Some(session))
            .unwrap();
        db.mark_failed(id, "Interrupted").unwrap();
        let retry = Database::open(temp.path().into()).unwrap();
        assert!(retry.store_transcription_segments(id, &[], None).is_err());
        let new_line = segment(id, "retry", offset + 100, "New audio");
        retry
            .store_transcription_segments(id, &[new_line], Some(session))
            .unwrap();
        retry.mark_ready(id).unwrap();
        assert!(retry.import_transcription_boundary(id).unwrap().is_none());
        let lines = retry.segments_for_meeting(id).unwrap();
        assert_eq!(
            lines
                .iter()
                .map(|line| (line.id.as_str(), line.text.as_str()))
                .collect::<Vec<_>>(),
            [("saved-link", "Edited text"), ("retry", "New audio")]
        );
    }

    #[test]
    fn empty_transcript_preserves_user_deletions_but_transcribes_unprocessed_recordings() {
        for previously_transcribed in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let db = Database::open(temp.path().into()).unwrap();
            let root = temp.path().join("recordings");
            let source = temp.path().join("source.wav");
            wav(&source, 350);
            let meeting = import(&db, &root, None, Some(draft()), &source, |_| {}).unwrap();
            if previously_transcribed {
                let directory = Path::new(meeting.audio_directory.as_ref().unwrap());
                crate::voice_reference::write_overlap_metadata(directory, &[], None).unwrap();
            }
            db.mark_ready(&meeting.id).unwrap();
            import(&db, &root, Some(&meeting.id), None, &source, |_| {}).unwrap();
            assert_eq!(
                db.import_transcription_boundary(&meeting.id)
                    .unwrap()
                    .is_some(),
                previously_transcribed
            );
        }
    }

    #[test]
    fn failure_leaves_no_draft_and_preserves_existing_audio() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(temp.path().into()).unwrap();
        let root = temp.path().join("recordings");
        let valid = temp.path().join("valid.wav");
        wav(&valid, 500);
        let invalid = temp.path().join("invalid.mp4");
        fs::write(&invalid, b"broken recording").unwrap();
        assert!(import(&db, &root, None, Some(draft()), &invalid, |_| {}).is_err());
        let missing_project = MeetingDraft {
            project_id: Some("missing".into()),
            ..draft()
        };
        assert!(import(&db, &root, None, Some(missing_project), &valid, |_| {}).is_err());
        assert!(db.meetings().unwrap().is_empty());
        let meeting = import(&db, &root, None, Some(draft()), &valid, |_| {}).unwrap();
        assert!(import(&db, &root, Some(&meeting.id), None, &valid, |_| {}).is_err());
        db.mark_ready(&meeting.id).unwrap();
        assert!(import(&db, &root, Some(&meeting.id), None, &invalid, |_| {}).is_err());
        let current = db.meeting(&meeting.id).unwrap();
        assert_eq!(
            (current.status.as_str(), current.duration_ms),
            ("ready", 1_000)
        );
        assert_eq!(
            speech_audio::recording_sessions(Path::new(&current.audio_directory.unwrap()))
                .unwrap()
                .len(),
            1
        );
        assert!(!root.join(STAGING_DIRECTORY).exists());
        assert!(db.pending_media_imports().unwrap().is_empty());
    }

    #[test]
    fn recovery_removes_only_uncommitted_audio_and_respects_live_imports() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(temp.path().into()).unwrap();
        let root = temp.path().join("recordings");
        let meeting = db.create_meeting(draft()).unwrap();
        let dir = root.join(&meeting.id);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir(root.join(STAGING_DIRECTORY)).unwrap();
        let valid = dir.join("microphone-10-0.wav");
        wav(&valid, 500);
        let lock = try_lock(&root).unwrap().unwrap();
        db.reserve_media_import(&meeting.id, false, &dir, || Ok(20))
            .unwrap();
        let uncommitted = track_path(&dir, 20);
        wav(&uncommitted, 800);
        assert!(db.delete_meeting(&meeting.id).is_err());
        assert!(db.mark_processing(&meeting.id).is_err());
        assert!(db
            .begin_recording(&meeting.id, dir.to_str().unwrap(), || panic!(
                "must not start"
            ))
            .is_err());
        recover(&db, &root).unwrap();
        assert!(uncommitted.exists());
        drop(lock);
        recover(&db, &root).unwrap();
        assert!(!uncommitted.exists());
        assert!(valid.exists());
        assert!(db.pending_media_imports().unwrap().is_empty());
        assert!(!root.join(STAGING_DIRECTORY).exists());
        assert_eq!(db.meeting(&meeting.id).unwrap().status, "draft");
    }
}
