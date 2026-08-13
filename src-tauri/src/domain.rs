use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDraft {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meeting {
    pub id: String,
    pub project_id: Option<String>,
    pub position: i64,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub started_at: Option<String>,
    pub ended_at: Option<String>,
    pub duration_ms: i64,
    pub audio_directory: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingDraft {
    pub title: String,
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub full_name: String,
    pub nickname: Option<String>,
    pub photo_data_url: Option<String>,
    pub reference_audio_data_url: Option<String>,
    pub color: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonDraft {
    pub full_name: String,
    pub nickname: Option<String>,
    pub photo_data_url: Option<String>,
    pub reference_audio_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub meeting_id: String,
    pub speaker_label: String,
    pub person_id: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub subtitle: Option<String>,
    pub kind: String,
    pub is_default: bool,
    pub is_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingPlacement {
    pub id: String,
    pub project_id: Option<String>,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingLevels {
    pub microphone: f32,
    pub system: f32,
    pub elapsed_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub microphone_device_id: Option<String>,
    pub system_device_id: Option<String>,
    pub capture_microphone: bool,
    pub capture_system: bool,
    pub theme: String,
    pub api_key_configured: bool,
    #[serde(default)]
    pub pyannote_api_key_configured: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            microphone_device_id: None,
            system_device_id: None,
            capture_microphone: true,
            capture_system: false,
            theme: "system".to_string(),
            api_key_configured: false,
            pyannote_api_key_configured: false,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub projects: Vec<Project>,
    pub meetings: Vec<Meeting>,
    pub people: Vec<Person>,
    pub segments: Vec<TranscriptSegment>,
    pub devices: Vec<AudioDevice>,
    pub settings: AppSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingRequest {
    pub meeting_id: String,
    pub microphone_device_id: Option<String>,
    pub system_device_id: Option<String>,
    pub capture_microphone: bool,
    pub capture_system: bool,
}
