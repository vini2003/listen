mod ai_chat;
mod audio;
mod credentials;
mod database;
mod diagnostics;
mod domain;
mod error;
#[cfg(target_os = "macos")]
mod macos_system_audio;
mod pyannote;
mod speech_audio;
mod transcript_cleanup;
mod transcription;
mod voice_profile_store;
mod voice_reference;

use std::path::{Path, PathBuf};

use audio::RecordingManager;
use chrono::Utc;
use database::Database;
use diagnostics::Diagnostics;
use domain::{
    AppSettings, ChatMessage, Meeting, MeetingDraft, MeetingPlacement, Person, PersonDraft,
    Project, ProjectDraft, RecordingLevels, RecordingRequest, TranscriptSegmentBackup,
    WorkspaceSnapshot, PRIVACY_NOTICE_VERSION,
};
use error::{AppError, AppResult};
use tauri::{Manager, State};
use voice_profile_store::VoiceProfileStore;

struct AppState {
    database: Database,
    recordings_directory: PathBuf,
    diagnostics: Diagnostics,
    voice_profiles: VoiceProfileStore,
}

#[tauri::command]
fn load_workspace(state: State<'_, AppState>) -> AppResult<WorkspaceSnapshot> {
    let mut settings = state.database.settings()?;
    settings.api_key_configured = credentials::has_openai_key()?;
    settings.pyannote_api_key_configured = credentials::has_pyannote_key()?;
    let devices = audio::list_devices().unwrap_or_default();
    if !settings.microphone_device_id.as_ref().is_some_and(|id| {
        devices
            .iter()
            .any(|device| device.id == *id && device.kind == "microphone" && device.is_available)
    }) {
        settings.microphone_device_id = devices
            .iter()
            .find(|device| device.kind == "microphone" && device.is_default)
            .or_else(|| devices.iter().find(|device| device.kind == "microphone"))
            .map(|device| device.id.clone());
    }
    if !settings.system_device_id.as_ref().is_some_and(|id| {
        devices
            .iter()
            .any(|device| device.id == *id && device.kind == "system" && device.is_available)
    }) {
        settings.system_device_id = devices
            .iter()
            .find(|device| device.kind == "system" && device.is_default && device.is_available)
            .or_else(|| {
                devices
                    .iter()
                    .find(|device| device.kind == "system" && device.is_available)
            })
            .map(|device| device.id.clone());
    }

    Ok(WorkspaceSnapshot {
        projects: state.database.projects()?,
        meetings: state.database.meetings()?,
        people: state.database.people()?,
        segments: Vec::new(),
        devices,
        settings,
    })
}

#[tauri::command]
fn load_meeting_segments(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<Vec<domain::TranscriptSegment>> {
    state.database.segments_for_meeting(&meeting_id)
}

#[tauri::command]
fn find_voice_enrollment_segment(
    state: State<'_, AppState>,
    person_id: String,
) -> AppResult<Option<domain::TranscriptSegment>> {
    state.database.best_assigned_segment_for_person(&person_id)
}

#[tauri::command]
fn create_project(state: State<'_, AppState>, draft: ProjectDraft) -> AppResult<Project> {
    state.database.create_project(draft)
}

#[tauri::command]
fn rename_project(state: State<'_, AppState>, id: String, name: String) -> AppResult<Project> {
    state.database.rename_project(&id, name)
}

#[tauri::command]
fn delete_project(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.database.delete_project(&id)
}

#[tauri::command]
fn reorder_projects(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    state.database.reorder_projects(ids)
}

#[tauri::command]
fn create_meeting(state: State<'_, AppState>, draft: MeetingDraft) -> AppResult<Meeting> {
    state.database.create_meeting(draft)
}

#[tauri::command]
fn rename_meeting(state: State<'_, AppState>, id: String, title: String) -> AppResult<Meeting> {
    state.database.rename_meeting(&id, title)
}

#[tauri::command]
fn move_meeting(
    state: State<'_, AppState>,
    id: String,
    project_id: Option<String>,
) -> AppResult<Meeting> {
    state.database.move_meeting(&id, project_id)
}

#[tauri::command]
fn reorder_meetings(
    state: State<'_, AppState>,
    placements: Vec<MeetingPlacement>,
) -> AppResult<()> {
    state.database.reorder_meetings(placements)
}

#[tauri::command]
fn delete_meeting(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.database.delete_meeting(&id)
}

#[tauri::command]
fn restore_meeting(state: State<'_, AppState>, id: String) -> AppResult<Meeting> {
    state.database.restore_meeting(&id)
}

#[tauri::command]
fn create_person(state: State<'_, AppState>, draft: PersonDraft) -> AppResult<Person> {
    state.database.create_person(draft)
}

#[tauri::command]
fn update_person(state: State<'_, AppState>, id: String, draft: PersonDraft) -> AppResult<Person> {
    state.database.update_person(&id, draft)
}

#[tauri::command]
fn delete_person(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.voice_profiles.delete(&id)?;
    credentials::delete_legacy_voiceprint(&id)?;
    state.database.delete_person(&id)?;
    let mut settings = state.database.settings()?;
    if settings.local_speaker_person_id.as_deref() == Some(id.as_str()) {
        settings.local_speaker_person_id = None;
        state.database.update_settings(&settings)?;
    }
    Ok(())
}

#[tauri::command]
fn assign_speaker(
    state: State<'_, AppState>,
    meeting_id: String,
    speaker_label: String,
    person_id: Option<String>,
) -> AppResult<()> {
    state
        .database
        .assign_speaker(&meeting_id, &speaker_label, person_id)
}

#[tauri::command]
fn delete_transcript_segments(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<TranscriptSegmentBackup>> {
    state.database.delete_transcript_segments(ids)
}

#[tauri::command]
fn restore_transcript_segments(
    state: State<'_, AppState>,
    backups: Vec<TranscriptSegmentBackup>,
) -> AppResult<()> {
    state.database.restore_transcript_segments(backups)
}

#[tauri::command]
fn acknowledge_privacy_notice(
    state: State<'_, AppState>,
    enable_voice_identification: bool,
) -> AppResult<AppSettings> {
    let mut settings = state.database.settings()?;
    settings.privacy_notice_version = Some(PRIVACY_NOTICE_VERSION.to_string());
    settings.speaker_identification_enabled = enable_voice_identification;
    settings.biometric_consent_accepted_at =
        enable_voice_identification.then(|| Utc::now().to_rfc3339());
    state.database.update_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
fn set_person_voice_consent(
    state: State<'_, AppState>,
    person_id: String,
    confirmed: bool,
) -> AppResult<Person> {
    if confirmed {
        let settings = state.database.settings()?;
        if !settings.speaker_identification_enabled
            || settings.biometric_consent_accepted_at.is_none()
        {
            return Err(AppError::Validation(
                "Enable voice identification in Settings first".to_string(),
            ));
        }
    }
    let stored_voiceprint_exists = confirmed && state.voice_profiles.load(&person_id)?.is_some();
    let legacy_voiceprint = if confirmed {
        state
            .database
            .voice_profiles()?
            .into_iter()
            .find(|profile| profile.person_id == person_id)
            .and_then(|profile| profile.voiceprint)
            .or(credentials::legacy_voiceprint(&person_id)?)
    } else {
        None
    };
    if !confirmed {
        state.voice_profiles.delete(&person_id)?;
        credentials::delete_legacy_voiceprint(&person_id)?;
    }
    state
        .database
        .set_person_voice_consent(&person_id, confirmed)?;
    if confirmed {
        if let Some(voiceprint) = legacy_voiceprint {
            state.voice_profiles.store(&person_id, &voiceprint)?;
            state.database.clear_voiceprint_blob(&person_id)?;
            credentials::delete_legacy_voiceprint(&person_id)?;
            state.database.activate_existing_voice_profile(&person_id)?;
        } else if stored_voiceprint_exists {
            state.database.activate_existing_voice_profile(&person_id)?;
        }
    }
    if !confirmed {
        let mut settings = state.database.settings()?;
        if settings.local_speaker_person_id.as_deref() == Some(person_id.as_str()) {
            settings.local_speaker_person_id = None;
            state.database.update_settings(&settings)?;
        }
    }
    state
        .database
        .people()?
        .into_iter()
        .find(|person| person.id == person_id)
        .ok_or(AppError::NotFound("Person"))
}

#[tauri::command]
fn withdraw_biometric_consent(state: State<'_, AppState>) -> AppResult<AppSettings> {
    for profile in state.database.voice_profiles()? {
        state.voice_profiles.delete(&profile.person_id)?;
        credentials::delete_legacy_voiceprint(&profile.person_id)?;
    }
    state.database.delete_all_voice_profiles()?;
    let mut settings = state.database.settings()?;
    settings.speaker_identification_enabled = false;
    settings.biometric_consent_accepted_at = None;
    settings.local_speaker_person_id = None;
    state.database.update_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
async fn enroll_voice_profile(
    state: State<'_, AppState>,
    meeting_id: String,
    speaker_label: String,
    person_id: String,
) -> AppResult<Person> {
    let settings = state.database.settings()?;
    if !settings.speaker_identification_enabled || settings.biometric_consent_accepted_at.is_none()
    {
        return Err(AppError::Validation(
            "Voice identification is disabled".to_string(),
        ));
    }
    state.database.mark_voice_profile_learning(&person_id)?;
    let result = async {
        let api_key = credentials::pyannote_key()?;
        let client = pyannote::PyannoteClient::new(api_key)?;
        let reference = voice_reference::learn_from_assignment(
            &state.database,
            &client,
            &meeting_id,
            &speaker_label,
            &person_id,
        )
        .await?;
        state
            .voice_profiles
            .store(&person_id, &reference.voiceprint)?;
        if let Err(error) = state.database.save_voice_profile(
            &person_id,
            &meeting_id,
            &speaker_label,
            reference.duration_ms,
            reference.clip_count,
            &reference.source,
        ) {
            let _ = state.voice_profiles.delete(&person_id);
            return Err(error);
        }
        Ok::<_, AppError>(reference)
    }
    .await;
    match result {
        Ok(reference) => {
            state.diagnostics.record_voiceprint_learned(
                &meeting_id,
                &person_id,
                &speaker_label,
                &reference.source,
                reference.duration_ms,
                reference.clip_count,
                reference.rms,
                reference.dominance,
            );
        }
        Err(error) => {
            let detail = error.to_string();
            if matches!(error, AppError::Validation(_)) {
                state
                    .database
                    .mark_voice_profile_pending(&person_id, &detail)?;
            } else {
                state
                    .database
                    .mark_voice_profile_failed(&person_id, &detail)?;
            }
            state.diagnostics.record_voiceprint_error(
                &meeting_id,
                &person_id,
                &speaker_label,
                &detail,
            );
        }
    }
    state
        .database
        .people()?
        .into_iter()
        .find(|person| person.id == person_id)
        .ok_or(AppError::NotFound("Person"))
}

#[tauri::command]
fn update_settings(
    state: State<'_, AppState>,
    mut settings: AppSettings,
) -> AppResult<AppSettings> {
    settings.api_key_configured = credentials::has_openai_key()?;
    settings.pyannote_api_key_configured = credentials::has_pyannote_key()?;
    state.database.update_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
fn set_api_key(api_key: String) -> AppResult<bool> {
    credentials::set_openai_key(&api_key)
}

#[tauri::command]
async fn set_pyannote_api_key(api_key: String) -> AppResult<bool> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return credentials::set_pyannote_key(api_key);
    }
    let client = pyannote::PyannoteClient::new(api_key.to_string())?;
    client.validate_key().await?;
    credentials::set_pyannote_key(api_key)
}

#[tauri::command]
fn open_diagnostics(state: State<'_, AppState>) -> AppResult<()> {
    state.diagnostics.open()
}

#[tauri::command]
fn start_recording(
    state: State<'_, AppState>,
    recorder: State<'_, RecordingManager>,
    request: RecordingRequest,
) -> AppResult<Meeting> {
    let directory = state.recordings_directory.join(&request.meeting_id);
    recorder.start(&request, directory.clone())?;
    let result = state.database.begin_recording(
        &request.meeting_id,
        directory
            .to_str()
            .ok_or_else(|| AppError::Audio("Invalid recording path".to_string()))?,
    );
    if result.is_err() {
        let _ = recorder.stop(&request.meeting_id);
        return result;
    }
    result
}

#[tauri::command]
fn set_recording_paused(
    recorder: State<'_, RecordingManager>,
    meeting_id: String,
    paused: bool,
) -> AppResult<()> {
    recorder.set_paused(&meeting_id, paused)
}

#[tauri::command]
fn recording_levels(
    recorder: State<'_, RecordingManager>,
    meeting_id: String,
) -> AppResult<RecordingLevels> {
    recorder.levels(&meeting_id)
}

#[tauri::command]
fn stop_recording(
    state: State<'_, AppState>,
    recorder: State<'_, RecordingManager>,
    meeting_id: String,
) -> AppResult<Meeting> {
    let duration_ms = recorder.stop(&meeting_id)?;
    state.database.finish_recording(&meeting_id, duration_ms)
}

#[tauri::command]
async fn transcribe_meeting(state: State<'_, AppState>, meeting_id: String) -> AppResult<Meeting> {
    transcribe_and_mark(&state, &meeting_id).await
}

#[tauri::command]
fn load_segment_audio(
    state: State<'_, AppState>,
    meeting_id: String,
    start_ms: i64,
    end_ms: i64,
) -> AppResult<String> {
    let meeting = state.database.meeting(&meeting_id)?;
    let directory = meeting
        .audio_directory
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Validation("This recording has no saved audio".to_string()))?;
    speech_audio::mixed_recording_clip_data_url(&directory, start_ms, end_ms)
}

#[tauri::command]
fn load_chat_messages(
    state: State<'_, AppState>,
    scope_type: String,
    scope_id: String,
) -> AppResult<Vec<ChatMessage>> {
    state.database.chat_messages(&scope_type, &scope_id)
}

#[tauri::command]
async fn complete_chat(
    state: State<'_, AppState>,
    scope_type: String,
    scope_id: String,
    content: String,
    message_id: Option<String>,
    client_message_id: Option<String>,
) -> AppResult<Vec<ChatMessage>> {
    if !credentials::has_openai_key()? {
        return Err(AppError::Validation(
            "Add a text model API key in Settings before asking a question".to_string(),
        ));
    }
    let api_key = credentials::openai_key()?;
    state.database.prepare_chat_user_message(
        &scope_type,
        &scope_id,
        content,
        message_id.as_deref(),
        client_message_id.as_deref(),
    )?;
    let answer = match ai_chat::answer(&state.database, &api_key, &scope_type, &scope_id).await {
        Ok(answer) => answer,
        Err(error) => {
            let diagnostic_id =
                state
                    .diagnostics
                    .record_chat_error(&scope_type, &scope_id, &error.to_string());
            return Err(AppError::OpenAi(format!(
                "The text model could not answer that question. Error ID {diagnostic_id}."
            )));
        }
    };
    state
        .database
        .append_chat_assistant_message(&scope_type, &scope_id, answer)?;
    state.database.chat_messages(&scope_type, &scope_id)
}

async fn transcribe_and_mark(state: &AppState, meeting_id: &str) -> AppResult<Meeting> {
    state.database.mark_processing(meeting_id)?;
    let report =
        match transcription::transcribe_meeting(&state.database, &state.voice_profiles, meeting_id)
            .await
        {
            Ok(report) => report,
            Err(error) => {
                let (category, message) = transcription::failure_summary(&error);
                let diagnostic_id = state.diagnostics.record_transcription_error(
                    meeting_id,
                    category,
                    &error.to_string(),
                );
                let public_message = format!("{message} Error ID {diagnostic_id}.");
                let _ = state.database.mark_failed(meeting_id, &public_message);
                return Err(AppError::Pyannote(public_message));
            }
        };
    if let Some(error) = report.cleanup_error {
        state.diagnostics.record_cleanup_error(meeting_id, &error);
    }
    if let Some(error) = report.identification_error {
        state
            .diagnostics
            .record_pipeline_warning(meeting_id, "identification", &error);
    }
    if let Some(warning) = report.warning {
        state
            .diagnostics
            .record_pipeline_warning(meeting_id, "precision-2", &warning);
    }
    for decision in &report.identity_decisions {
        state.diagnostics.record_identity_decision(
            meeting_id,
            &decision.speaker,
            decision.person_id.as_deref(),
            decision.confidence,
            decision.margin,
            &decision.reason,
            report.identity_candidates,
        );
    }
    state.diagnostics.record_transcription_completed(
        meeting_id,
        &report.active_sources,
        report.minimum_speakers,
        &report.detected_speakers,
        &report.transcribed_speakers,
    );
    state.database.mark_ready(meeting_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let database = Database::open(app_data_dir.clone())
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            database
                .recover_interrupted_voice_profiles()
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            for meeting in database
                .meetings()
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?
                .into_iter()
                .filter(|meeting| meeting.status == "recording")
            {
                let saved_duration = meeting
                    .audio_directory
                    .as_deref()
                    .and_then(|directory| {
                        speech_audio::recording_duration_ms(Path::new(directory)).ok()
                    })
                    .unwrap_or_default()
                    .max(meeting.duration_ms);
                database
                    .recover_interrupted_recording(&meeting.id, saved_duration)
                    .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            }
            let voice_profiles = VoiceProfileStore::new(app_data_dir.join("voice-profiles"));
            for profile in database.voice_profiles().unwrap_or_default() {
                let legacy = profile.voiceprint.or_else(|| {
                    credentials::legacy_voiceprint(&profile.person_id)
                        .ok()
                        .flatten()
                });
                if let Some(voiceprint) = legacy {
                    if voice_profiles
                        .store(&profile.person_id, &voiceprint)
                        .is_ok()
                    {
                        let _ = database.clear_voiceprint_blob(&profile.person_id);
                        let _ = credentials::delete_legacy_voiceprint(&profile.person_id);
                    }
                }
            }
            app.manage(AppState {
                database,
                recordings_directory: app_data_dir.join("recordings"),
                diagnostics: Diagnostics::new(&app_data_dir),
                voice_profiles,
            });
            app.manage(RecordingManager::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            load_meeting_segments,
            find_voice_enrollment_segment,
            create_project,
            rename_project,
            delete_project,
            reorder_projects,
            create_meeting,
            rename_meeting,
            move_meeting,
            reorder_meetings,
            delete_meeting,
            restore_meeting,
            create_person,
            update_person,
            delete_person,
            assign_speaker,
            delete_transcript_segments,
            restore_transcript_segments,
            acknowledge_privacy_notice,
            set_person_voice_consent,
            withdraw_biometric_consent,
            enroll_voice_profile,
            update_settings,
            set_api_key,
            set_pyannote_api_key,
            open_diagnostics,
            start_recording,
            stop_recording,
            set_recording_paused,
            recording_levels,
            transcribe_meeting,
            load_segment_audio,
            load_chat_messages,
            complete_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Listen");
}
