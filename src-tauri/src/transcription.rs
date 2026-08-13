use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    time::Duration,
};

use uuid::Uuid;

use crate::{
    credentials,
    database::Database,
    domain::TranscriptSegment,
    error::{AppError, AppResult},
    pyannote::{self, IdentificationSpan, KnownVoiceprint, PyannoteClient, TranscriptionTurn},
    speech_audio,
    transcript_cleanup::{self, CleanupContext},
    voice_reference,
};

const MAX_PYANNOTE_FILE_BYTES: u64 = 1024 * 1024 * 1024;

pub struct TranscriptionReport {
    pub cleanup_error: Option<String>,
    pub identification_error: Option<String>,
    pub warning: Option<String>,
    pub active_sources: Vec<String>,
    pub minimum_speakers: Option<u8>,
    pub detected_speakers: Vec<String>,
    pub transcribed_speakers: Vec<String>,
}

pub async fn transcribe_meeting(
    database: &Database,
    meeting_id: &str,
) -> AppResult<TranscriptionReport> {
    let meeting = database.meeting(meeting_id)?;
    let audio_directory = meeting
        .audio_directory
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Validation("This meeting has no saved audio".to_string()))?;
    let api_key = credentials::pyannote_key().map_err(|_| {
        AppError::Validation("Add a pyannote API key in Settings before transcribing".to_string())
    })?;
    let client = PyannoteClient::new(api_key)?;
    let active_sources = speech_audio::active_capture_sources(&audio_directory)?;
    let minimum_speakers = (active_sources.iter().any(|source| source == "microphone")
        && active_sources.iter().any(|source| source == "system"))
    .then_some(2);

    let upload_path = std::env::temp_dir().join(format!(
        "listen-precision-upload-{}.wav",
        Uuid::new_v4().simple()
    ));
    let duration_ms = match speech_audio::write_mixed_recording(&audio_directory, &upload_path) {
        Ok(duration_ms) => duration_ms,
        Err(error) => {
            let _ = fs::remove_file(&upload_path);
            return Err(error);
        }
    };
    if duration_ms <= 0 {
        let _ = fs::remove_file(&upload_path);
        return Err(AppError::Validation(
            "No recorded audio was found".to_string(),
        ));
    }
    let file_bytes = fs::metadata(&upload_path)?.len();
    if file_bytes > MAX_PYANNOTE_FILE_BYTES {
        let _ = fs::remove_file(&upload_path);
        return Err(AppError::Pyannote(format!(
            "file_too_large prepared_bytes={file_bytes} limit_bytes={MAX_PYANNOTE_FILE_BYTES}"
        )));
    }

    let object_key = format!(
        "listen/meetings/{meeting_id}/{}.wav",
        Uuid::new_v4().simple()
    );
    let media_url = client.upload(&upload_path, &object_key).await;
    let _ = fs::remove_file(&upload_path);
    let media_url = media_url?;

    let people = database.people()?;
    let known_people = people
        .iter()
        .filter_map(|person| {
            voice_reference::known_voiceprint(person.reference_audio_data_url.as_deref()).map(
                |voiceprint| KnownVoiceprint {
                    label: person.id.clone(),
                    voiceprint,
                },
            )
        })
        .take(50)
        .collect::<Vec<_>>();

    let (transcription, identification, identification_error) = if known_people.is_empty() {
        (
            client.transcribe(&media_url, minimum_speakers).await?,
            None,
            None,
        )
    } else {
        let (transcription, identification) = tokio::join!(
            client.transcribe(&media_url, minimum_speakers),
            client.identify(&media_url, &known_people, minimum_speakers),
        );
        match identification {
            Ok(identification) => (transcription?, Some(identification), None),
            Err(error) => (transcription?, None, Some(error.to_string())),
        }
    };

    if transcription.turn_level_transcription.is_empty() {
        return Err(AppError::Pyannote(
            "Precision-2 returned no transcribed speaker turns".to_string(),
        ));
    }
    voice_reference::write_overlap_metadata(&audio_directory, &transcription.diarization)?;
    let mut detected_speakers = transcription
        .diarization
        .iter()
        .map(|span| span.speaker.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    detected_speakers.sort();
    let mut transcribed_speakers = transcription
        .turn_level_transcription
        .iter()
        .map(|turn| turn.speaker.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    transcribed_speakers.sort();

    let existing_segments = database
        .segments()?
        .into_iter()
        .filter(|segment| segment.meeting_id == meeting_id)
        .collect::<Vec<_>>();
    let valid_person_ids = people
        .iter()
        .map(|person| person.id.clone())
        .collect::<HashSet<_>>();
    let identification_spans = identification
        .as_ref()
        .map(|output| output.identification.as_slice())
        .unwrap_or_default();
    let mut segments = transcription
        .turn_level_transcription
        .iter()
        .filter_map(|turn| {
            let text = turn.text.trim();
            if text.is_empty() {
                return None;
            }
            let start_ms = seconds_to_ms(turn.start);
            let end_ms = seconds_to_ms(turn.end).max(start_ms + 1);
            let person_id = person_from_identification(turn, identification_spans)
                .filter(|person_id| valid_person_ids.contains(person_id))
                .or_else(|| person_from_overlap(&existing_segments, start_ms, end_ms));
            Some(TranscriptSegment {
                id: Uuid::new_v4().to_string(),
                meeting_id: meeting_id.to_string(),
                speaker_label: format!("precision:{}", turn.speaker),
                person_id,
                start_ms,
                end_ms,
                text: text.to_string(),
            })
        })
        .collect::<Vec<_>>();
    segments.sort_by_key(|segment| segment.start_ms);
    database.replace_segments(meeting_id, segments.clone())?;

    let project_name = meeting.project_id.as_ref().and_then(|project_id| {
        database
            .projects()
            .ok()?
            .into_iter()
            .find(|project| &project.id == project_id)
            .map(|project| project.name)
    });
    let cleanup_context = CleanupContext {
        meeting_id: meeting_id.to_string(),
        meeting_title: meeting.title,
        project_name,
        people,
    };
    let cleanup_error = optional_cleanup(database, &cleanup_context, &segments).await;
    let mut warning = transcription
        .warning
        .filter(|warning| !warning.trim().is_empty());
    if minimum_speakers.is_some_and(|minimum| detected_speakers.len() < minimum as usize) {
        let count_warning = format!(
            "Precision-2 returned {} speaker(s) despite a minimum of {} inferred from active capture tracks",
            detected_speakers.len(),
            minimum_speakers.unwrap_or_default()
        );
        warning = Some(match warning {
            Some(existing) => format!("{existing}; {count_warning}"),
            None => count_warning,
        });
    }

    Ok(TranscriptionReport {
        cleanup_error,
        identification_error,
        warning,
        active_sources,
        minimum_speakers,
        detected_speakers,
        transcribed_speakers,
    })
}

async fn optional_cleanup(
    database: &Database,
    context: &CleanupContext,
    segments: &[TranscriptSegment],
) -> Option<String> {
    let api_key = credentials::openai_key().ok()?;
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5 * 60))
        .build()
    {
        Ok(client) => client,
        Err(error) => return Some(format!("Could not prepare transcript cleanup: {error}")),
    };
    match transcript_cleanup::refine_transcript(&client, &api_key, context, segments).await {
        Ok(refined) => database
            .update_segment_texts(&context.meeting_id, &refined)
            .err()
            .map(|error| error.to_string()),
        Err(error) => Some(error.to_string()),
    }
}

fn person_from_identification(
    turn: &TranscriptionTurn,
    identification: &[IdentificationSpan],
) -> Option<String> {
    let turn_start_ms = seconds_to_ms(turn.start);
    let turn_end_ms = seconds_to_ms(turn.end);
    let duration_ms = (turn_end_ms - turn_start_ms).max(1);
    let mut overlap_by_person = HashMap::<&str, i64>::new();
    for span in identification {
        let Some(person_id) = span.r#match.as_deref() else {
            continue;
        };
        let overlap = overlap_ms(
            turn_start_ms,
            turn_end_ms,
            seconds_to_ms(span.start),
            seconds_to_ms(span.end),
        );
        if overlap > 0 {
            *overlap_by_person.entry(person_id).or_default() += overlap;
        }
    }
    let (person_id, overlap_ms) = overlap_by_person
        .into_iter()
        .max_by_key(|(_, overlap_ms)| *overlap_ms)?;
    (overlap_ms * 2 >= duration_ms).then(|| person_id.to_string())
}

fn person_from_overlap(
    existing_segments: &[TranscriptSegment],
    start_ms: i64,
    end_ms: i64,
) -> Option<String> {
    let duration_ms = (end_ms - start_ms).max(1);
    let (person_id, overlap_ms) = existing_segments
        .iter()
        .filter_map(|segment| {
            let person_id = segment.person_id.as_ref()?;
            let overlap_ms = overlap_ms(start_ms, end_ms, segment.start_ms, segment.end_ms);
            (overlap_ms > 0).then_some((person_id, overlap_ms))
        })
        .max_by_key(|(_, overlap_ms)| *overlap_ms)?;
    (overlap_ms * 2 >= duration_ms).then(|| person_id.clone())
}

fn overlap_ms(left_start: i64, left_end: i64, right_start: i64, right_end: i64) -> i64 {
    left_end.min(right_end) - left_start.max(right_start)
}

fn seconds_to_ms(seconds: f64) -> i64 {
    (seconds * 1_000.0).round() as i64
}

pub fn failure_summary(error: &AppError) -> (&'static str, &'static str) {
    if matches!(error, AppError::Pyannote(_))
        || error.to_string().to_ascii_lowercase().contains("pyannote")
    {
        return pyannote::failure_summary(error);
    }
    if matches!(error, AppError::Audio(_) | AppError::Io(_)) {
        return (
            "local_audio",
            "Listen could not prepare the saved recording. Open the log for details.",
        );
    }
    (
        "unexpected",
        "Listen could not create this transcript. Open the log for the exact reason.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_identification_by_time_not_request_local_speaker_label() {
        let turn = TranscriptionTurn {
            speaker: "SPEAKER_00".to_string(),
            start: 10.0,
            end: 15.0,
            text: "Hello".to_string(),
        };
        let identity = IdentificationSpan {
            start: 10.2,
            end: 14.9,
            r#match: Some("nestor".to_string()),
        };

        assert_eq!(
            person_from_identification(&turn, &[identity]),
            Some("nestor".to_string())
        );
    }

    #[test]
    fn does_not_force_a_weak_identity_match() {
        let turn = TranscriptionTurn {
            speaker: "SPEAKER_00".to_string(),
            start: 10.0,
            end: 20.0,
            text: "Hello".to_string(),
        };
        let identity = IdentificationSpan {
            start: 10.0,
            end: 12.0,
            r#match: Some("nestor".to_string()),
        };

        assert_eq!(person_from_identification(&turn, &[identity]), None);
    }
}
