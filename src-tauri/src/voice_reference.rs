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

const MIN_REFERENCE_MS: i64 = 8_000;
const MAX_REFERENCE_MS: i64 = 30_000;
const MIN_CLIP_MS: i64 = 1_500;
const MIN_SIGNAL_RMS: f64 = 140.0;
const MIN_SOURCE_DOMINANCE: f64 = 1.65;
const OVERLAP_TOLERANCE_MS: i64 = 200;
const METADATA_FILENAME: &str = "precision-overlaps.json";

#[derive(Debug)]
pub struct LearnedVoiceprint {
    pub voiceprint: String,
    pub source: String,
    pub duration_ms: i64,
    pub clip_count: i64,
    pub rms: f64,
    pub dominance: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeRange {
    start_ms: i64,
    end_ms: i64,
}

struct ClipCandidate {
    source: &'static str,
    start_ms: i64,
    end_ms: i64,
    samples: Vec<i16>,
    rms: f64,
    dominance: f64,
    score: f64,
}

struct ReferenceCandidate {
    source: &'static str,
    samples: Vec<i16>,
    duration_ms: i64,
    clip_count: i64,
    rms: f64,
    dominance: f64,
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
    // Check before the paid upload/voiceprint calls; a rapid reassignment or
    // undo should not cost an API round-trip. Re-checked after the calls too.
    if !speaker_segments
        .iter()
        .any(|segment| segment.person_id.as_deref() == Some(person_id))
    {
        return Err(AppError::Validation(
            "The speaker assignment changed before voice learning started".to_string(),
        ));
    }
    let all_segments = database.segments_for_meeting(meeting_id)?;
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
        Ok::<_, AppError>(voiceprint)
    }
    .await;
    let _ = fs::remove_file(&reference_path);
    let voiceprint = result?;

    Ok(LearnedVoiceprint {
        voiceprint,
        source: candidate.source.to_string(),
        duration_ms: candidate.duration_ms,
        clip_count: candidate.clip_count,
        rms: candidate.rms,
        dominance: candidate.dominance,
    })
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
    let mut clips = Vec::new();
    for segment in speaker_segments {
        let duration_ms = segment.end_ms - segment.start_ms;
        if duration_ms < MIN_CLIP_MS {
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
        clips.push(ClipCandidate {
            source,
            start_ms,
            end_ms,
            samples,
            rms: primary_rms,
            dominance,
            score,
        });
    }

    let best = ["microphone", "system"]
        .into_iter()
        .filter_map(|source| combine_clips(&clips, source))
        .max_by(|left, right| {
            left.duration_ms
                .cmp(&right.duration_ms)
                .then_with(|| left.rms.total_cmp(&right.rms))
        });
    best.filter(|candidate| candidate.duration_ms >= MIN_REFERENCE_MS)
        .ok_or_else(|| {
            AppError::Validation(
            "At least 8 seconds of clean, single-speaker audio is needed for this voice profile"
                .to_string(),
        )
        })
}

fn combine_clips(clips: &[ClipCandidate], source: &'static str) -> Option<ReferenceCandidate> {
    let mut selected = clips
        .iter()
        .filter(|clip| clip.source == source)
        .collect::<Vec<_>>();
    selected.sort_by(|left, right| right.score.total_cmp(&left.score));
    let mut samples = Vec::new();
    let mut duration_ms = 0i64;
    let mut weighted_rms = 0.0;
    let mut weighted_dominance = 0.0;
    let mut clip_count = 0i64;
    for clip in selected {
        let remaining_ms = MAX_REFERENCE_MS - duration_ms;
        if remaining_ms <= 0 {
            break;
        }
        let clip_duration_ms = clip.end_ms - clip.start_ms;
        let used_ms = clip_duration_ms.min(remaining_ms);
        let sample_count = if used_ms == clip_duration_ms {
            clip.samples.len()
        } else {
            (clip.samples.len() as i64 * used_ms / clip_duration_ms) as usize
        };
        samples.extend_from_slice(&clip.samples[..sample_count]);
        duration_ms += used_ms;
        weighted_rms += clip.rms * used_ms as f64;
        weighted_dominance += clip.dominance * used_ms as f64;
        clip_count += 1;
    }
    (duration_ms > 0).then(|| ReferenceCandidate {
        source,
        samples,
        duration_ms,
        clip_count,
        rms: weighted_rms / duration_ms as f64,
        dominance: weighted_dominance / duration_ms as f64,
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
    fn combines_multiple_clean_clips_up_to_thirty_seconds() {
        let clips = vec![
            ClipCandidate {
                source: "microphone",
                start_ms: 0,
                end_ms: 6_000,
                samples: vec![1; 96_000],
                rms: 400.0,
                dominance: 10.0,
                score: 10.0,
            },
            ClipCandidate {
                source: "microphone",
                start_ms: 7_000,
                end_ms: 13_000,
                samples: vec![2; 96_000],
                rms: 500.0,
                dominance: 12.0,
                score: 12.0,
            },
        ];
        let combined = combine_clips(&clips, "microphone").expect("combined clips");
        assert_eq!(combined.duration_ms, 12_000);
        assert_eq!(combined.clip_count, 2);
        assert_eq!(combined.samples.len(), 192_000);
    }
}
