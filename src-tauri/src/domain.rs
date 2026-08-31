use serde::{Deserialize, Serialize};

pub const PRIVACY_NOTICE_VERSION: &str = "2026-08-14";

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
    pub voice_profile: Option<VoiceProfileSummary>,
    pub color: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonDraft {
    pub full_name: String,
    pub nickname: Option<String>,
    pub photo_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProfileSummary {
    pub status: String,
    pub consent_confirmed_at: Option<String>,
    pub enrollment_duration_ms: Option<i64>,
    pub enrollment_clip_count: Option<i64>,
    pub source: Option<String>,
    pub updated_at: String,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct StoredVoiceProfile {
    pub person_id: String,
    pub voiceprint: Option<String>,
    pub status: String,
    pub consent_confirmed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub meeting_id: String,
    pub speaker_label: String,
    pub person_id: Option<String>,
    #[serde(default)]
    pub identity_source: Option<String>,
    #[serde(default)]
    pub identity_confidence: Option<f64>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegmentBackup {
    pub segment: TranscriptSegment,
    pub raw_text: Option<String>,
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
pub struct ChatMessage {
    pub id: String,
    pub scope_type: String,
    pub scope_id: String,
    pub role: String,
    pub content: String,
    pub position: i64,
    pub created_at: String,
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
    #[serde(default)]
    pub privacy_notice_version: Option<String>,
    #[serde(default)]
    pub biometric_consent_accepted_at: Option<String>,
    #[serde(default)]
    pub speaker_identification_enabled: bool,
    #[serde(default)]
    pub local_speaker_person_id: Option<String>,
    #[serde(default)]
    pub prefer_local_speaker_for_microphone: bool,
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
            privacy_notice_version: None,
            biometric_consent_accepted_at: None,
            speaker_identification_enabled: false,
            local_speaker_person_id: None,
            prefer_local_speaker_for_microphone: true,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantContext {
    pub meeting: Meeting,
    pub meetings: Vec<Meeting>,
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
