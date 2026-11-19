use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use crate::{
    database::Database,
    domain::TranscriptSegment,
    error::{AppError, AppResult},
    speech::{SpeakerEmbedder, SpeakerSpan, Voiceprint},
    speech_audio,
};

const MIN_REFERENCE_MS: i64 = 8_000;
const MAX_REFERENCE_MS: i64 = 30_000;
const MIN_CLIP_MS: i64 = 1_500;
const MIN_SIGNAL_RMS: f64 = 140.0;
const MIN_SOURCE_DOMINANCE: f64 = 1.65;
const OVERLAP_TOLERANCE_MS: i64 = 200;
pub(crate) const METADATA_FILENAME: &str = "speaker-overlaps.json";

#[derive(Debug)]
pub struct LearnedVoiceprint {
    pub voiceprint: Voiceprint,
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
    clips: Vec<Vec<i16>>,
    duration_ms: i64,
    clip_count: i64,
    rms: f64,
    dominance: f64,
}

/// Learns a voiceprint from a manually labelled speaker. Runs on a blocking
/// thread: it reads clips from disk and runs the voice matching model.
pub fn learn_from_assignment(
    database: &Database,
    embedder_model: &Path,
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
    let still_assigned = |segments: &[TranscriptSegment]| {
        segments
            .iter()
            .any(|segment| segment.person_id.as_deref() == Some(person_id))
    };
    if !still_assigned(&speaker_segments) {
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

    let mut embedder = SpeakerEmbedder::load(embedder_model)?;
    let mut embeddings = Vec::with_capacity(candidate.clips.len());
    for clip in &candidate.clips {
        if let Some(embedding) = embedder.embed(clip)? {
            embeddings.push((embedding, clip.len() as f32));
        }
    }
    let embedding = crate::speech::centroid(
        embeddings
            .iter()
            .map(|(embedding, weight)| (embedding.as_slice(), *weight)),
    )
    .ok_or_else(|| {
        AppError::Validation(
            "The labelled speech was too short or too quiet to learn this voice".to_string(),
        )
    })?;

    if !still_assigned(&database.speaker_segments(meeting_id, speaker_label)?) {
        return Err(AppError::Validation(
            "The speaker assignment changed before voice learning finished".to_string(),
        ));
    }
    Ok(LearnedVoiceprint {
        voiceprint: Voiceprint::new(embedding),
        source: candidate.source.to_string(),
        duration_ms: candidate.duration_ms,
        clip_count: candidate.clip_count,
        rms: candidate.rms,
        dominance: candidate.dominance,
    })
}

pub fn write_overlap_metadata(
    directory: &Path,
    spans: &[SpeakerSpan],
    append_from_ms: Option<i64>,
) -> AppResult<()> {
    let path = directory.join(METADATA_FILENAME);
    let mut overlaps = match append_from_ms {
        Some(start_ms) => match fs::read(&path) {
            Ok(bytes) => {
                let mut prior: Vec<TimeRange> =
                    serde_json::from_slice(&bytes).map_err(|error| {
                        AppError::Audio(format!("Could not read speaker metadata: {error}"))
                    })?;
                prior.retain_mut(|range| {
                    range.end_ms = range.end_ms.min(start_ms);
                    range.start_ms < range.end_ms
                });
                prior
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        },
        None => Vec::new(),
    };
    for (index, left) in spans.iter().enumerate() {
        for right in spans.iter().skip(index + 1) {
            if left.speaker == right.speaker {
                continue;
            }
            let start_ms = left.start_ms.max(right.start_ms);
            let end_ms = left.end_ms.min(right.end_ms);
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
    let temporary = tempfile::NamedTempFile::new_in(directory)?;
    serde_json::to_writer(temporary.as_file(), &merged)
        .map_err(|error| AppError::Audio(format!("Could not encode speaker metadata: {error}")))?;
    temporary.persist(path).map_err(|error| error.error)?;
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
    let mut clips = Vec::new();
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
        clips.push(clip.samples[..sample_count].to_vec());
        duration_ms += used_ms;
        weighted_rms += clip.rms * used_ms as f64;
        weighted_dominance += clip.dominance * used_ms as f64;
        clip_count += 1;
    }
    (duration_ms > 0).then(|| ReferenceCandidate {
        source,
        clips,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_overlapping_exclusion_ranges() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let spans = vec![
            SpeakerSpan {
                speaker: 0,
                start_ms: 1_000,
                end_ms: 4_000,
            },
            SpeakerSpan {
                speaker: 1,
                start_ms: 2_000,
                end_ms: 3_000,
            },
        ];

        write_overlap_metadata(directory.path(), &spans, None).expect("speaker metadata");
        let ranges = read_overlap_metadata(directory.path());

        assert_eq!(ranges.len(), 1);
        assert_eq!(ranges[0].start_ms, 2_000);
        assert_eq!(ranges[0].end_ms, 3_000);
    }

    #[test]
    fn retrying_an_append_preserves_only_prior_overlap_ranges() {
        let directory = tempfile::tempdir().unwrap();
        let spans = |start_ms| {
            vec![
                SpeakerSpan {
                    speaker: 0,
                    start_ms,
                    end_ms: start_ms + 2_000,
                },
                SpeakerSpan {
                    speaker: 1,
                    start_ms: start_ms + 500,
                    end_ms: start_ms + 1_500,
                },
            ]
        };
        write_overlap_metadata(directory.path(), &spans(0), None).unwrap();
        write_overlap_metadata(directory.path(), &spans(5_000), Some(5_000)).unwrap();
        write_overlap_metadata(directory.path(), &spans(6_000), Some(5_000)).unwrap();
        let ranges: Vec<_> = read_overlap_metadata(directory.path())
            .into_iter()
            .map(|r| (r.start_ms, r.end_ms))
            .collect();
        assert_eq!(ranges, [(500, 1_500), (6_500, 7_500)]);
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
        assert_eq!(combined.clips.len(), 2);
        assert_eq!(combined.clips.iter().map(Vec::len).sum::<usize>(), 192_000);
        assert_eq!(
            combined.clips[0][0], 2,
            "the higher-scoring clip comes first"
        );
    }
}
