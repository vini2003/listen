mod ai_chat;
mod audio;
mod credentials;
mod database;
mod diagnostics;
mod domain;
mod error;
mod pyannote;
mod speech_audio;
mod transcript_cleanup;
mod transcription;
mod voice_reference;

use std::path::PathBuf;

use audio::RecordingManager;
use database::Database;
use diagnostics::Diagnostics;
use domain::{
    AppSettings, ChatMessage, Meeting, MeetingDraft, MeetingPlacement, Person, PersonDraft,
    Project, ProjectDraft, RecordingLevels, RecordingRequest, WorkspaceSnapshot,
};
use error::{AppError, AppResult};
use tauri::{Manager, State};

struct AppState {
    database: Database,
    recordings_directory: PathBuf,
    diagnostics: Diagnostics,
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
        segments: state.database.segments()?,
        devices,
        settings,
    })
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
    state.database.delete_person(&id)
}

#[tauri::command]
fn assign_speaker(
    state: State<'_, AppState>,
    meeting_id: String,
    speaker_label: String,
    person_id: Option<String>,
) -> AppResult<()> {
    let previous_person_ids = state
        .database
        .speaker_segments(&meeting_id, &speaker_label)?
        .into_iter()
        .filter_map(|segment| segment.person_id)
        .collect::<std::collections::HashSet<_>>();
    state
        .database
        .assign_speaker(&meeting_id, &speaker_label, person_id.clone())?;
    for previous_person_id in previous_person_ids {
        if person_id.as_deref() == Some(previous_person_id.as_str()) {
            continue;
        }
        let previous_reference = state
            .database
            .people()?
            .into_iter()
            .find(|person| person.id == previous_person_id)
            .and_then(|person| person.reference_audio_data_url);
        if voice_reference::reference_came_from(
            previous_reference.as_deref(),
            &meeting_id,
            &speaker_label,
        ) {
            state.database.clear_person_reference(&previous_person_id)?;
        }
    }
    if let Some(person_id) = person_id {
        let database = state.database.clone();
        let diagnostics = state.diagnostics.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                let api_key = credentials::pyannote_key()?;
                let client = pyannote::PyannoteClient::new(api_key)?;
                voice_reference::learn_from_assignment(
                    &database,
                    &client,
                    &meeting_id,
                    &speaker_label,
                    &person_id,
                )
                .await
            }
            .await;
            match result {
                Ok(reference) => {
                    diagnostics.record_voiceprint_learned(
                        &meeting_id,
                        &person_id,
                        &speaker_label,
                        &reference.source,
                        reference.start_ms,
                        reference.end_ms,
                        reference.rms,
                        reference.dominance,
                    );
                }
                Err(error) => {
                    diagnostics.record_voiceprint_error(
                        &meeting_id,
                        &person_id,
                        &speaker_label,
                        &error.to_string(),
                    );
                }
            }
        });
    }
    Ok(())
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
    let report = match transcription::transcribe_meeting(&state.database, meeting_id).await {
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let database = Database::open(app_data_dir.clone())
                .map_err(|error| Box::<dyn std::error::Error>::from(error.to_string()))?;
            app.manage(AppState {
                database,
                recordings_directory: app_data_dir.join("recordings"),
                diagnostics: Diagnostics::new(&app_data_dir),
            });
            app.manage(RecordingManager::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
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
