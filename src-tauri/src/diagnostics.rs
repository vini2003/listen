use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

use chrono::Utc;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

const MAX_DETAIL_CHARS: usize = 2_000;

#[derive(Clone)]
pub struct Diagnostics {
    path: PathBuf,
}

impl Diagnostics {
    pub fn new(app_data_directory: &Path) -> Self {
        Self {
            path: app_data_directory.join("listen-diagnostics.log"),
        }
    }

    pub fn record_transcription_error(
        &self,
        meeting_id: &str,
        category: &str,
        detail: &str,
    ) -> String {
        let diagnostic_id = Uuid::new_v4().simple().to_string()[..8].to_uppercase();
        let line = format!(
            "{} [{}] transcription.error meeting={} category={} detail={}\n",
            Utc::now().to_rfc3339(),
            diagnostic_id,
            sanitize_field(meeting_id),
            sanitize_field(category),
            sanitize(detail),
        );

        if let Err(error) = self.append(&line) {
            eprintln!("Unable to write Listen diagnostic {diagnostic_id}: {error}");
        }

        diagnostic_id
    }

    pub fn record_cleanup_error(&self, meeting_id: &str, detail: &str) -> String {
        let diagnostic_id = Uuid::new_v4().simple().to_string()[..8].to_uppercase();
        let line = format!(
            "{} [{}] transcript_cleanup.error meeting={} detail={}\n",
            Utc::now().to_rfc3339(),
            diagnostic_id,
            sanitize_field(meeting_id),
            sanitize(detail),
        );

        if let Err(error) = self.append(&line) {
            eprintln!("Unable to write Listen diagnostic {diagnostic_id}: {error}");
        }

        diagnostic_id
    }

    pub fn record_pipeline_warning(&self, meeting_id: &str, stage: &str, detail: &str) -> String {
        self.record_event(
            "transcription.warning",
            &format!(
                "meeting={} stage={} detail={}",
                sanitize_field(meeting_id),
                sanitize_field(stage),
                sanitize(detail)
            ),
        )
    }

    pub fn record_transcription_completed(
        &self,
        meeting_id: &str,
        active_sources: &[String],
        minimum_speakers: Option<u8>,
        detected_speakers: &[String],
        transcribed_speakers: &[String],
    ) -> String {
        self.record_event(
            "transcription.completed",
            &format!(
                "meeting={} active_sources={} minimum_speakers={} diarized_speakers={} diarized_labels={} transcribed_speakers={} transcribed_labels={}",
                sanitize_field(meeting_id),
                sanitize_field(&active_sources.join(",")),
                minimum_speakers
                    .map(|count| count.to_string())
                    .unwrap_or_else(|| "auto".to_string()),
                detected_speakers.len(),
                sanitize_field(&detected_speakers.join(",")),
                transcribed_speakers.len(),
                sanitize_field(&transcribed_speakers.join(","))
            ),
        )
    }

    pub fn record_voiceprint_error(
        &self,
        meeting_id: &str,
        person_id: &str,
        speaker_label: &str,
        detail: &str,
    ) -> String {
        self.record_event(
            "voiceprint.error",
            &format!(
                "meeting={} person={} speaker={} detail={}",
                sanitize_field(meeting_id),
                sanitize_field(person_id),
                sanitize_field(speaker_label),
                sanitize(detail)
            ),
        )
    }

    pub fn record_voiceprint_learned(
        &self,
        meeting_id: &str,
        person_id: &str,
        speaker_label: &str,
        source: &str,
        start_ms: i64,
        end_ms: i64,
        rms: f64,
        dominance: f64,
    ) -> String {
        self.record_event(
            "voiceprint.learned",
            &format!(
                "meeting={} person={} speaker={} source={} start_ms={} end_ms={} rms={:.1} dominance={:.2}",
                sanitize_field(meeting_id),
                sanitize_field(person_id),
                sanitize_field(speaker_label),
                sanitize_field(source),
                start_ms,
                end_ms,
                rms,
                dominance
            ),
        )
    }

    pub fn open(&self) -> AppResult<()> {
        self.ensure_file()?;

        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("explorer.exe");
            command.arg(format!("/select,{}", self.path.display()));
            command
        };

        #[cfg(target_os = "macos")]
        let mut command = {
            let mut command = Command::new("open");
            command.arg("-R").arg(&self.path);
            command
        };

        #[cfg(target_os = "linux")]
        let mut command = {
            let mut command = Command::new("xdg-open");
            command.arg(self.path.parent().unwrap_or_else(|| Path::new(".")));
            command
        };

        command.spawn().map(|_| ()).map_err(AppError::Io)
    }

    fn append(&self, line: &str) -> std::io::Result<()> {
        self.ensure_file()?;
        OpenOptions::new()
            .append(true)
            .open(&self.path)?
            .write_all(line.as_bytes())
    }

    fn record_event(&self, event: &str, detail: &str) -> String {
        let diagnostic_id = Uuid::new_v4().simple().to_string()[..8].to_uppercase();
        let line = format!(
            "{} [{}] {} {}\n",
            Utc::now().to_rfc3339(),
            diagnostic_id,
            sanitize_field(event),
            detail
        );
        if let Err(error) = self.append(&line) {
            eprintln!("Unable to write Listen diagnostic {diagnostic_id}: {error}");
        }
        diagnostic_id
    }

    fn ensure_file(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map(|_| ())
    }
}

fn sanitize(detail: &str) -> String {
    let normalized = detail.replace(['\r', '\n'], " ");
    let mut output = Vec::new();
    let mut redact_next = false;

    for token in normalized.split_whitespace() {
        let lower = token.to_ascii_lowercase();
        if redact_next || lower.starts_with("sk-") || lower.contains("api_key=") {
            output.push("[redacted]");
            redact_next = false;
            continue;
        }
        output.push(token);
        redact_next = lower == "bearer" || lower.ends_with("authorization:");
    }

    output.join(" ").chars().take(MAX_DETAIL_CHARS).collect()
}

fn sanitize_field(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_secrets_and_line_breaks() {
        let safe = sanitize("Authorization: Bearer sk-proj-secret\napi_key=also-secret failed");

        assert!(!safe.contains("secret"));
        assert!(!safe.contains('\n'));
        assert_eq!(
            safe,
            "Authorization: [redacted] [redacted] [redacted] failed"
        );
    }
}
