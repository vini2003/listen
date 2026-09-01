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
use database::Database;
use diagnostics::Diagnostics;
use domain::{
    AppSettings, AssistantContext, ChatMessage, Folder, FolderDraft, Meeting, MeetingDraft,
    MeetingPlacement, Person, PersonDraft, Project, ProjectDraft, RecordingLevels,
    RecordingRequest, TranscriptSegmentBackup, WorkspaceSnapshot,
};
use error::{AppError, AppResult};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Emitter, Manager, State};
use voice_profile_store::VoiceProfileStore;

struct AppState {
    database: Database,
    recordings_directory: PathBuf,
    diagnostics: Diagnostics,
    voice_profiles: VoiceProfileStore,
    assistant_meeting_id: Mutex<Option<String>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssistantReferenceEvent {
    meeting_id: String,
    time_ms: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatUpdatedEvent {
    scope_type: String,
    scope_id: String,
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
        folders: state.database.folders()?,
        meetings: state.database.meetings()?,
        people: state.database.people()?,
        segments: Vec::new(),
        devices,
        settings,
    })
}

#[tauri::command]
fn load_assistant_context(
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<AssistantContext> {
    let mut settings = state.database.settings()?;
    settings.api_key_configured = credentials::has_openai_key()?;
    settings.pyannote_api_key_configured = credentials::has_pyannote_key()?;
    Ok(AssistantContext {
        meeting: state.database.meeting(&meeting_id)?,
        meetings: state.database.meetings()?,
        settings,
    })
}

#[tauri::command]
async fn open_assistant_window(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<()> {
    let meeting = state.database.meeting(&meeting_id)?;

    if let Some(window) = app.get_webview_window("assistant") {
        navigate_assistant_window(&window, &meeting_id, &meeting.title)?;
        *state.assistant_meeting_id.lock() = Some(meeting_id);
        return Ok(());
    }

    let url =
        tauri::WebviewUrl::App(format!("index.html?view=assistant&meetingId={meeting_id}").into());
    if let Err(error) = tauri::WebviewWindowBuilder::new(&app, "assistant", url)
        .title(format!("Ask — {}", meeting.title))
        .inner_size(480.0, 700.0)
        .min_inner_size(360.0, 460.0)
        .resizable(true)
        .prevent_overflow()
        .center()
        .build()
    {
        if let Some(window) = app.get_webview_window("assistant") {
            navigate_assistant_window(&window, &meeting_id, &meeting.title)?;
            *state.assistant_meeting_id.lock() = Some(meeting_id);
            return Ok(());
        }
        *state.assistant_meeting_id.lock() = None;
        return Err(AppError::Window(error.to_string()));
    }
    *state.assistant_meeting_id.lock() = Some(meeting_id);
    Ok(())
}

fn navigate_assistant_window(
    window: &tauri::WebviewWindow,
    meeting_id: &str,
    meeting_title: &str,
) -> AppResult<()> {
    window
        .set_title(&format!("Ask — {meeting_title}"))
        .map_err(|error| AppError::Window(error.to_string()))?;
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|error| AppError::Window(error.to_string()))?;
    window
        .emit("listen://assistant-navigate", meeting_id)
        .map_err(|error| AppError::Window(error.to_string()))
}

#[tauri::command]
fn attached_assistant_meeting(state: State<'_, AppState>) -> Option<String> {
    state.assistant_meeting_id.lock().clone()
}

#[tauri::command]
fn focus_assistant_window(app: tauri::AppHandle) -> AppResult<bool> {
    let Some(window) = app.get_webview_window("assistant") else {
        return Ok(false);
    };
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(true)
}

#[tauri::command]
fn attach_assistant_window(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
) -> AppResult<()> {
    state.database.meeting(&meeting_id)?;
    let main = app
        .get_webview_window("main")
        .ok_or(AppError::NotFound("Main window"))?;
    main.show()
        .and_then(|_| main.set_focus())
        .map_err(|error| AppError::Window(error.to_string()))?;
    main.emit("listen://assistant-attached", meeting_id)
        .map_err(|error| AppError::Window(error.to_string()))?;
    *state.assistant_meeting_id.lock() = None;
    Ok(())
}

#[tauri::command]
fn focus_main_window_reference(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    meeting_id: String,
    time_ms: i64,
) -> AppResult<()> {
    state.database.meeting(&meeting_id)?;
    let main = app
        .get_webview_window("main")
        .ok_or(AppError::NotFound("Main window"))?;
    main.show()
        .and_then(|_| main.set_focus())
        .map_err(|error| AppError::Window(error.to_string()))?;
    main.emit(
        "listen://assistant-reference",
        AssistantReferenceEvent {
            meeting_id,
            time_ms,
        },
    )
    .map_err(|error| AppError::Window(error.to_string()))?;
    Ok(())
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
fn create_folder(state: State<'_, AppState>, draft: FolderDraft) -> AppResult<Folder> {
    state.database.create_folder(draft)
}

#[tauri::command]
fn rename_folder(state: State<'_, AppState>, id: String, name: String) -> AppResult<Folder> {
    state.database.rename_folder(&id, name)
}

#[tauri::command]
fn move_folder(
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
) -> AppResult<Folder> {
    state.database.move_folder(&id, parent_id)
}

#[tauri::command]
fn delete_folder(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.database.delete_folder(&id)
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
fn delete_meeting(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.database.delete_meeting(&id)?;
    let close_assistant = {
        let mut assistant_meeting_id = state.assistant_meeting_id.lock();
        let matches = assistant_meeting_id.as_deref() == Some(id.as_str());
        if matches {
            *assistant_meeting_id = None;
        }
        matches
    };
    if close_assistant {
        if let Some(window) = app.get_webview_window("assistant") {
            let _ = window.close();
        }
    }
    Ok(())
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
    identity_source: Option<String>,
) -> AppResult<()> {
    state
        .database
        .assign_speaker(&meeting_id, &speaker_label, person_id, identity_source)
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
fn forget_voice_profile(state: State<'_, AppState>, person_id: String) -> AppResult<Person> {
    state.voice_profiles.delete(&person_id)?;
    credentials::delete_legacy_voiceprint(&person_id)?;
    state.database.disable_voice_profile(&person_id)?;
    state
        .database
        .people()?
        .into_iter()
        .find(|person| person.id == person_id)
        .ok_or(AppError::NotFound("Person"))
}

#[tauri::command]
fn forget_all_voice_profiles(state: State<'_, AppState>) -> AppResult<()> {
    for profile in state.database.voice_profiles()? {
        state.voice_profiles.delete(&profile.person_id)?;
        credentials::delete_legacy_voiceprint(&profile.person_id)?;
        state.database.disable_voice_profile(&profile.person_id)?;
    }
    Ok(())
}

#[tauri::command]
fn enable_voice_profile(state: State<'_, AppState>, person_id: String) -> AppResult<Person> {
    state.database.enable_voice_profile(&person_id)?;
    state
        .database
        .people()?
        .into_iter()
        .find(|person| person.id == person_id)
        .ok_or(AppError::NotFound("Person"))
}

#[tauri::command]
async fn enroll_voice_profile(
    state: State<'_, AppState>,
    meeting_id: String,
    speaker_label: String,
    person_id: String,
) -> AppResult<Person> {
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
    state.database.update_settings(&settings)
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
async fn export_meeting_audio(state: State<'_, AppState>, meeting_id: String) -> AppResult<String> {
    let meeting = state.database.meeting(&meeting_id)?;
    let directory = meeting
        .audio_directory
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Validation("This recording has no saved audio".to_string()))?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        speech_audio::export_mixed_recording(&directory)
    })
    .await
    .map_err(|error| AppError::Audio(format!("Could not export meeting audio: {error}")))??;
    Ok(path.to_string_lossy().into_owned())
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
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
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
    notify_other_chat_window(&app, window.label(), &scope_type, &scope_id);
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
    let messages = state.database.chat_messages(&scope_type, &scope_id)?;
    notify_other_chat_window(&app, window.label(), &scope_type, &scope_id);
    Ok(messages)
}

fn notify_other_chat_window(
    app: &tauri::AppHandle,
    source_window: &str,
    scope_type: &str,
    scope_id: &str,
) {
    let target = if source_window == "assistant" {
        "main"
    } else {
        "assistant"
    };
    let _ = app.emit_to(
        target,
        "listen://chat-updated",
        ChatUpdatedEvent {
            scope_type: scope_type.to_string(),
            scope_id: scope_id.to_string(),
        },
    );
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
    // Keeps recently-matched voiceprints ahead of the 50-profile identification cap.
    let matched_people: Vec<String> = report
        .identity_decisions
        .iter()
        .filter_map(|decision| decision.person_id.clone())
        .collect();
    if let Err(error) = state.database.touch_voice_profiles(&matched_people) {
        state
            .diagnostics
            .record_pipeline_warning(meeting_id, "identification", &error.to_string());
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
            // Consent was removed in 0.3: promote profiles that were parked
            // behind the old per-person permission gate.
            for profile in database.voice_profiles().unwrap_or_default() {
                if profile.status != "consent_required" {
                    continue;
                }
                let has_print = profile.voiceprint.is_some()
                    || voice_profiles
                        .load(&profile.person_id)
                        .ok()
                        .flatten()
                        .is_some();
                if has_print {
                    let _ = database.activate_existing_voice_profile(&profile.person_id);
                } else {
                    let _ = database.mark_voice_profile_pending(
                        &profile.person_id,
                        "The voice profile will be learned from the next labeled recording",
                    );
                }
            }
            app.manage(AppState {
                database,
                recordings_directory: app_data_dir.join("recordings"),
                diagnostics: Diagnostics::new(&app_data_dir),
                voice_profiles,
                assistant_meeting_id: Mutex::new(None),
            });
            app.manage(RecordingManager::default());
            Ok(())
        })
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            if window.label() == "main" {
                if let Some(assistant) = window.app_handle().get_webview_window("assistant") {
                    let _ = assistant.close();
                }
            } else if window.label() == "assistant" {
                let state = window.state::<AppState>();
                *state.assistant_meeting_id.lock() = None;
                let _ = window
                    .app_handle()
                    .emit_to("main", "listen://assistant-closed", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            load_assistant_context,
            open_assistant_window,
            attached_assistant_meeting,
            focus_assistant_window,
            attach_assistant_window,
            focus_main_window_reference,
            load_meeting_segments,
            find_voice_enrollment_segment,
            create_project,
            rename_project,
            delete_project,
            reorder_projects,
            create_folder,
            rename_folder,
            move_folder,
            delete_folder,
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
            forget_voice_profile,
            forget_all_voice_profiles,
            enable_voice_profile,
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
            export_meeting_audio,
            load_chat_messages,
            complete_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Listen");
}
