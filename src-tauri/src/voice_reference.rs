use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    database::Database,
    domain::TranscriptSegment,
    error::{AppError, AppResult},
    pyannote::{PyannoteClient, SpeakerSpan},
    speech_audio,
};

const MIN_REFERENCE_MS: i64 = 5_000;
const MAX_REFERENCE_MS: i64 = 25_000;
const MIN_SIGNAL_RMS: f64 = 140.0;
const MIN_SOURCE_DOMINANCE: f64 = 1.65;
const OVERLAP_TOLERANCE_MS: i64 = 200;
const METADATA_FILENAME: &str = "precision-overlaps.json";
const VOICEPRINT_PREFIX: &str = "pyannote:";
const VOICEPRINT_V1_PREFIX: &str = "pyannote:v1:";

#[derive(Debug)]
pub struct LearnedVoiceprint {
    pub source: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub rms: f64,
    pub dominance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeRange {
    start_ms: i64,
    end_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredVoiceprint {
    voiceprint: String,
    meeting_id: String,
    speaker_label: String,
}

struct ReferenceCandidate {
    source: &'static str,
    start_ms: i64,
    end_ms: i64,
    samples: Vec<i16>,
    rms: f64,
    dominance: f64,
    score: f64,
}

pub async fn learn_from_assignment(
    database: &Database,
    client: &PyannoteClient,
    meeting_id: &str,
    speaker_label: &str,
    person_id: &str,
) -> AppResult<LearnedVoiceprint> {
    let meeting = database.meeting(meeting_id)?;
    let directory = meeting
        .audio_directory
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Validation("This recording has no saved audio".to_string()))?;
    let speaker_segments = database.speaker_segments(meeting_id, speaker_label)?;
    let all_segments = database
        .segments()?
        .into_iter()
        .filter(|segment| segment.meeting_id == meeting_id)
        .collect::<Vec<_>>();
    let excluded_ranges = read_overlap_metadata(&directory);
    let candidate = best_reference_candidate(
        &directory,
        &speaker_segments,
        &all_segments,
        &excluded_ranges,
    )?;

    let reference_path =
        std::env::temp_dir().join(format!("listen-voiceprint-{}.wav", Uuid::new_v4()));
    speech_audio::write_normalized_wav(&reference_path, &candidate.samples)?;
    let object_key = format!(
        "listen/voiceprints/{person_id}/{}.wav",
        Uuid::new_v4().simple()
    );
    let result = async {
        let media_url = client.upload(&reference_path, &object_key).await?;
        let voiceprint = client.create_voiceprint(&media_url).await?;
        let assignment_is_current = database
            .speaker_segments(meeting_id, speaker_label)?
            .iter()
            .any(|segment| segment.person_id.as_deref() == Some(person_id));
        if !assignment_is_current {
            return Err(AppError::Validation(
                "The speaker assignment changed before voice learning finished".to_string(),
            ));
        }
        database.claim_person_reference(
            person_id,
            &encode_voiceprint(&voiceprint, meeting_id, speaker_label)?,
        )?;
        Ok::<_, AppError>(())
    }
    .await;
    let _ = fs::remove_file(&reference_path);
    result?;

    Ok(LearnedVoiceprint {
        source: candidate.source.to_string(),
        start_ms: candidate.start_ms,
        end_ms: candidate.end_ms,
        rms: candidate.rms,
        dominance: candidate.dominance,
    })
}

pub fn known_voiceprint(value: Option<&str>) -> Option<String> {
    let value = value?;
    if let Some(encoded) = value.strip_prefix(VOICEPRINT_V1_PREFIX) {
        return serde_json::from_str::<StoredVoiceprint>(encoded)
            .ok()
            .map(|stored| stored.voiceprint)
            .filter(|voiceprint| !voiceprint.trim().is_empty());
    }
    value
        .strip_prefix(VOICEPRINT_PREFIX)
        .filter(|voiceprint| !voiceprint.trim().is_empty())
        .map(ToOwned::to_owned)
}

pub fn reference_came_from(value: Option<&str>, meeting_id: &str, speaker_label: &str) -> bool {
    value
        .and_then(|value| value.strip_prefix(VOICEPRINT_V1_PREFIX))
        .and_then(|encoded| serde_json::from_str::<StoredVoiceprint>(encoded).ok())
        .is_some_and(|stored| {
            stored.meeting_id == meeting_id && stored.speaker_label == speaker_label
        })
}

fn encode_voiceprint(voiceprint: &str, meeting_id: &str, speaker_label: &str) -> AppResult<String> {
    let encoded = serde_json::to_string(&StoredVoiceprint {
        voiceprint: voiceprint.to_string(),
        meeting_id: meeting_id.to_string(),
        speaker_label: speaker_label.to_string(),
    })
    .map_err(|error| AppError::Audio(format!("Could not store voice identity: {error}")))?;
    Ok(format!("{VOICEPRINT_V1_PREFIX}{encoded}"))
}

pub fn write_overlap_metadata(directory: &Path, spans: &[SpeakerSpan]) -> AppResult<()> {
    let mut overlaps = Vec::new();
    for (index, left) in spans.iter().enumerate() {
        for right in spans.iter().skip(index + 1) {
            if left.speaker == right.speaker {
                continue;
            }
            let start_ms = seconds_to_ms(left.start.max(right.start));
            let end_ms = seconds_to_ms(left.end.min(right.end));
            if end_ms - start_ms > OVERLAP_TOLERANCE_MS {
                overlaps.push(TimeRange { start_ms, end_ms });
            }
        }
    }
    overlaps.sort_by_key(|range| range.start_ms);
    let mut merged: Vec<TimeRange> = Vec::new();
    for range in overlaps {
        if let Some(previous) = merged
            .last_mut()
            .filter(|previous| range.start_ms <= previous.end_ms + OVERLAP_TOLERANCE_MS)
        {
            previous.end_ms = previous.end_ms.max(range.end_ms);
        } else {
            merged.push(range);
        }
    }
    fs::write(
        directory.join(METADATA_FILENAME),
        serde_json::to_vec(&merged).map_err(|error| {
            AppError::Audio(format!("Could not encode speaker metadata: {error}"))
        })?,
    )?;
    Ok(())
}

fn best_reference_candidate(
    directory: &Path,
    speaker_segments: &[TranscriptSegment],
    all_segments: &[TranscriptSegment],
    excluded_ranges: &[TimeRange],
) -> AppResult<ReferenceCandidate> {
    let mut best: Option<ReferenceCandidate> = None;
    for segment in speaker_segments {
        let duration_ms = segment.end_ms - segment.start_ms;
        if duration_ms < MIN_REFERENCE_MS {
            continue;
        }
        let (start_ms, end_ms) = centered_range(segment, MAX_REFERENCE_MS);
        if excluded_ranges.iter().any(|range| {
            overlap_ms(start_ms, end_ms, range.start_ms, range.end_ms) > OVERLAP_TOLERANCE_MS
        }) || all_segments.iter().any(|other| {
            other.speaker_label != segment.speaker_label
                && overlap_ms(start_ms, end_ms, other.start_ms, other.end_ms) > OVERLAP_TOLERANCE_MS
        }) {
            continue;
        }

        let microphone =
            speech_audio::recording_source_clip(directory, "microphone", start_ms, end_ms)?;
        let system = speech_audio::recording_source_clip(directory, "system", start_ms, end_ms)?;
        let microphone_rms = speech_audio::rms(&microphone);
        let system_rms = speech_audio::rms(&system);
        let (source, samples, primary_rms, secondary_rms) = if microphone_rms >= system_rms {
            ("microphone", microphone, microphone_rms, system_rms)
        } else {
            ("system", system, system_rms, microphone_rms)
        };
        if primary_rms < MIN_SIGNAL_RMS {
            continue;
        }
        let dominance = if secondary_rms < 1.0 {
            100.0
        } else {
            primary_rms / secondary_rms
        };
        if dominance < MIN_SOURCE_DOMINANCE {
            continue;
        }
        let score = (end_ms - start_ms) as f64 * primary_rms.ln_1p() * dominance.min(8.0);
        let candidate = ReferenceCandidate {
            source,
            start_ms,
            end_ms,
            samples,
            rms: primary_rms,
            dominance,
            score,
        };
        if best
            .as_ref()
            .map_or(true, |current| candidate.score > current.score)
        {
            best = Some(candidate);
        }
    }

    best.ok_or_else(|| {
        AppError::Validation(
            "No clean 5-second single-speaker passage was available to learn this voice"
                .to_string(),
        )
    })
}

fn centered_range(segment: &TranscriptSegment, maximum_ms: i64) -> (i64, i64) {
    let duration_ms = segment.end_ms - segment.start_ms;
    if duration_ms <= maximum_ms {
        return (segment.start_ms, segment.end_ms);
    }
    let center_ms = segment.start_ms + duration_ms / 2;
    (center_ms - maximum_ms / 2, center_ms + maximum_ms / 2)
}

fn read_overlap_metadata(directory: &Path) -> Vec<TimeRange> {
    fs::read(directory.join(METADATA_FILENAME))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn overlap_ms(left_start: i64, left_end: i64, right_start: i64, right_end: i64) -> i64 {
    left_end.min(right_end) - left_start.max(right_start)
}

fn seconds_to_ms(seconds: f64) -> i64 {
    (seconds * 1_000.0).round() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_overlapping_exclusion_ranges() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let spans = vec![
            SpeakerSpan {
                speaker: "A".to_string(),
                start: 1.0,
                end: 4.0,
            },
            SpeakerSpan {
                speaker: "B".to_string(),
                start: 2.0,
                end: 3.0,
            },
        ];

        write_overlap_metadata(directory.path(), &spans).expect("speaker metadata");
        let ranges = read_overlap_metadata(directory.path());

        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start_ms, 2_000);
        assert_eq!(ranges[0].end_ms, 3_000);
    }

    #[test]
    fn recognizes_only_precision_voiceprints() {
        assert_eq!(
            known_voiceprint(Some("pyannote:abc")),
            Some("abc".to_string())
        );
        assert_eq!(known_voiceprint(Some("data:audio/wav;base64,old")), None);
    }

    #[test]
    fn tracks_the_assignment_that_created_a_voiceprint() {
        let encoded = encode_voiceprint("abc", "meeting-1", "precision:SPEAKER_00")
            .expect("encoded voiceprint");

        assert_eq!(known_voiceprint(Some(&encoded)), Some("abc".to_string()));
        assert!(reference_came_from(
            Some(&encoded),
            "meeting-1",
            "precision:SPEAKER_00"
        ));
        assert!(!reference_came_from(
            Some(&encoded),
            "meeting-2",
            "precision:SPEAKER_00"
        ));
    }
}
