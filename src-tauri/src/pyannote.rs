use std::{collections::HashMap, path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use tokio_util::codec::{BytesCodec, FramedRead};

use crate::error::{AppError, AppResult};

const API_BASE: &str = "https://api.pyannote.ai/v1";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const JOB_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const IDENTIFICATION_THRESHOLD: u8 = 65;

#[derive(Clone)]
pub struct PyannoteClient {
    http: reqwest::Client,
    api_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSpan {
    pub speaker: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionTurn {
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentificationSpan {
    pub start: f64,
    pub end: f64,
    pub diarization_speaker: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceprintMatch {
    pub speaker: String,
    pub r#match: Option<String>,
    #[serde(default)]
    pub confidence: HashMap<String, f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobOutput {
    #[serde(default)]
    pub diarization: Vec<SpeakerSpan>,
    #[serde(default)]
    pub turn_level_transcription: Vec<TranscriptionTurn>,
    #[serde(default)]
    pub identification: Vec<IdentificationSpan>,
    #[serde(default)]
    pub voiceprints: Vec<VoiceprintMatch>,
    pub voiceprint: Option<String>,
    pub warning: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatedJob {
    job_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobResponse {
    job_id: String,
    status: String,
    output: Option<JobOutput>,
}

#[derive(Debug, Deserialize)]
struct MediaUpload {
    url: String,
}

#[derive(Debug, Serialize)]
struct MediaRequest<'a> {
    url: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiarizationRequest<'a> {
    url: &'a str,
    model: &'static str,
    exclusive: bool,
    turn_level_confidence: bool,
    transcription: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_speakers: Option<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct KnownVoiceprint {
    pub label: String,
    pub voiceprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdentificationRequest<'a> {
    url: &'a str,
    model: &'static str,
    voiceprints: &'a [KnownVoiceprint],
    exclusive: bool,
    turn_level_confidence: bool,
    confidence: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_speakers: Option<u8>,
    matching: MatchingConfig,
}

#[derive(Debug, Serialize)]
struct MatchingConfig {
    exclusive: bool,
    threshold: u8,
}

#[derive(Debug, Serialize)]
struct VoiceprintRequest<'a> {
    url: &'a str,
    model: &'static str,
}

impl PyannoteClient {
    pub fn new(api_key: String) -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(30 * 60))
            .build()
            .map_err(|error| AppError::Pyannote(format!("Could not create API client: {error}")))?;
        Ok(Self { http, api_key })
    }

    pub async fn validate_key(&self) -> AppResult<()> {
        let response = self
            .http
            .get(format!("{API_BASE}/test"))
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(self.response_error(response, "validate API key").await);
        }
        Ok(())
    }

    pub async fn upload(&self, path: &Path, object_key: &str) -> AppResult<String> {
        let media_url = format!("media://{object_key}");
        let response = self
            .http
            .post(format!("{API_BASE}/media/input"))
            .bearer_auth(&self.api_key)
            .json(&MediaRequest { url: &media_url })
            .send()
            .await
            .map_err(network_error)?;
        let upload = self
            .json_response::<MediaUpload>(response, "create media upload")
            .await?;

        let content_length = tokio::fs::metadata(path).await.map_err(AppError::Io)?.len();
        let file = tokio::fs::File::open(path).await.map_err(AppError::Io)?;
        let stream = FramedRead::new(file, BytesCodec::new());
        let response = self
            .http
            .put(upload.url)
            .header("Content-Type", "application/octet-stream")
            .header("Content-Length", content_length)
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .map_err(network_error)?;
        if !response.status().is_success() {
            return Err(self.response_error(response, "upload media").await);
        }

        Ok(media_url)
    }

    pub async fn transcribe(
        &self,
        media_url: &str,
        min_speakers: Option<u8>,
    ) -> AppResult<JobOutput> {
        let request = DiarizationRequest {
            url: media_url,
            model: "precision-2",
            exclusive: true,
            turn_level_confidence: true,
            transcription: true,
            min_speakers,
        };
        let job_id = self.submit("diarize", &request).await?;
        self.wait_for_job(&job_id).await
    }

    pub async fn identify(
        &self,
        media_url: &str,
        voiceprints: &[KnownVoiceprint],
        min_speakers: Option<u8>,
    ) -> AppResult<JobOutput> {
        let request = IdentificationRequest {
            url: media_url,
            model: "precision-2",
            voiceprints,
            exclusive: true,
            turn_level_confidence: true,
            confidence: true,
            min_speakers,
            matching: MatchingConfig {
                exclusive: true,
                threshold: IDENTIFICATION_THRESHOLD,
            },
        };
        let job_id = self.submit("identify", &request).await?;
        self.wait_for_job(&job_id).await
    }

    pub async fn create_voiceprint(&self, media_url: &str) -> AppResult<String> {
        let request = VoiceprintRequest {
            url: media_url,
            model: "precision-2",
        };
        let job_id = self.submit("voiceprint", &request).await?;
        self.wait_for_job(&job_id)
            .await?
            .voiceprint
            .filter(|voiceprint| !voiceprint.trim().is_empty())
            .ok_or_else(|| AppError::Pyannote("Voiceprint job returned no voiceprint".to_string()))
    }

    async fn submit<T: Serialize>(&self, endpoint: &str, request: &T) -> AppResult<String> {
        let response = self
            .http
            .post(format!("{API_BASE}/{endpoint}"))
            .bearer_auth(&self.api_key)
            .json(request)
            .send()
            .await
            .map_err(network_error)?;
        Ok(self
            .json_response::<CreatedJob>(response, "submit job")
            .await?
            .job_id)
    }

    async fn wait_for_job(&self, job_id: &str) -> AppResult<JobOutput> {
        let started = tokio::time::Instant::now();
        loop {
            if started.elapsed() > JOB_TIMEOUT {
                return Err(AppError::Pyannote(format!(
                    "job={job_id} timed out after {} seconds",
                    JOB_TIMEOUT.as_secs()
                )));
            }
            let response = self
                .http
                .get(format!("{API_BASE}/jobs/{job_id}"))
                .bearer_auth(&self.api_key)
                .send()
                .await
                .map_err(network_error)?;
            let job = self
                .json_response::<JobResponse>(response, "read job")
                .await?;
            match job.status.as_str() {
                "succeeded" => {
                    let output = job.output.ok_or_else(|| {
                        AppError::Pyannote(format!("job={} completed without output", job.job_id))
                    })?;
                    if let Some(error) = output.error.as_deref().filter(|error| !error.is_empty()) {
                        return Err(AppError::Pyannote(format!(
                            "job={} output_error={error}",
                            job.job_id
                        )));
                    }
                    return Ok(output);
                }
                "failed" | "canceled" => {
                    let detail = job
                        .output
                        .and_then(|output| output.error.or(output.warning))
                        .unwrap_or_else(|| "no failure detail was returned".to_string());
                    return Err(AppError::Pyannote(format!(
                        "job={} status={} detail={detail}",
                        job.job_id, job.status
                    )));
                }
                _ => tokio::time::sleep(POLL_INTERVAL).await,
            }
        }
    }

    async fn json_response<T: for<'de> Deserialize<'de>>(
        &self,
        response: reqwest::Response,
        operation: &str,
    ) -> AppResult<T> {
        if !response.status().is_success() {
            return Err(self.response_error(response, operation).await);
        }
        response.json::<T>().await.map_err(|error| {
            AppError::Pyannote(format!("Could not decode {operation} response: {error}"))
        })
    }

    async fn response_error(&self, response: reqwest::Response, operation: &str) -> AppError {
        let status = response.status();
        let detail = response
            .text()
            .await
            .unwrap_or_else(|_| "unreadable response".to_string());
        let detail = detail.chars().take(1_500).collect::<String>();
        AppError::Pyannote(format!(
            "operation={operation} http_status={} detail={detail}",
            status.as_u16()
        ))
    }
}

fn network_error(error: reqwest::Error) -> AppError {
    AppError::Pyannote(format!("network_error={error}"))
}

pub fn failure_summary(error: &AppError) -> (&'static str, &'static str) {
    let detail = error.to_string().to_ascii_lowercase();
    if detail.contains("pyannote api key") || detail.contains("credential storage") {
        return (
            "credentials",
            "Add a pyannote API key in Settings, then try again.",
        );
    }
    if detail.contains("http_status=401") || detail.contains("http_status=403") {
        return (
            "authentication",
            "pyannote rejected the API key. Replace it in Settings and try again.",
        );
    }
    if detail.contains("http_status=402") || detail.contains("budget") || detail.contains("credit")
    {
        return (
            "billing",
            "The pyannote account needs credits or a larger monthly budget.",
        );
    }
    if detail.contains("http_status=429") || detail.contains("rate limit") {
        return ("rate_limit", "pyannote is busy. Try again shortly.");
    }
    if detail.contains("no_speech_detected") {
        return (
            "no_speech",
            "No clear speech was detected in the recording.",
        );
    }
    if detail.contains("file_too_large") || detail.contains("1gib") {
        return (
            "audio_too_large",
            "The prepared recording exceeded pyannote's 1 GiB upload limit.",
        );
    }
    if detail.contains("network_error=") || detail.contains("timed out") {
        return (
            "network",
            "Listen could not reach pyannote. Check the connection and try again.",
        );
    }
    (
        "unexpected",
        "pyannote could not process this recording. Open the log for the exact reason.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorizes_authentication_errors() {
        let error = AppError::Pyannote("http_status=401 detail=invalid token".to_string());
        assert_eq!(failure_summary(&error).0, "authentication");
    }

    #[test]
    fn parses_transcription_job_output() {
        let output: JobOutput = serde_json::from_str(
            r#"{
                "turnLevelTranscription": [{
                    "speaker": "SPEAKER_00",
                    "start": 0.5,
                    "end": 2.3,
                    "text": "Hello there"
                }]
            }"#,
        )
        .expect("job output");

        assert_eq!(output.turn_level_transcription[0].text, "Hello there");
    }
}
