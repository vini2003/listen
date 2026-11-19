use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use serde::Serialize;
use uuid::Uuid;

use crate::{
    credentials,
    database::Database,
    domain::{AppSettings, TranscriptSegment},
    error::{AppError, AppResult},
    speech::{self, Stage, Voice, Voiceprint},
    speech_audio,
    speech_models::SpeechModels,
    transcript_cleanup::{self, CleanupContext},
    voice_profile_store::VoiceProfileStore,
    voice_reference,
};

/// Calibrated on four labelled team meetings with two to fifteen speakers:
/// the same person in different recordings scored 0.83–0.93, different people
/// at most 0.39. A match also has to beat the runner-up clearly.
const MIN_IDENTITY_SIMILARITY: f32 = 0.6;
const MIN_IDENTITY_MARGIN: f32 = 0.1;
/// Voices with less solo speech than this are too uncertain to name.
const MIN_IDENTITY_CLEAN_MS: i64 = 3_000;
const MIN_LOCAL_MICROPHONE_RMS: f64 = 140.0;
const MIN_LOCAL_MICROPHONE_DOMINANCE: f64 = 2.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Queued,
    Preparing,
    Separating,
    Transcribing,
    Identifying,
    Polishing,
}

impl Phase {
    /// Share of the whole job each phase ends at, from measured run times.
    fn span(self) -> (f32, f32) {
        match self {
            Phase::Queued => (0.0, 0.0),
            Phase::Preparing => (0.0, 0.04),
            Phase::Separating => (0.04, 0.32),
            Phase::Transcribing => (0.32, 0.88),
            Phase::Identifying => (0.88, 0.94),
            Phase::Polishing => (0.94, 1.0),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionProgress {
    pub meeting_id: String,
    pub phase: Phase,
    /// Whole-job progress from 0 to 1.
    pub progress: f32,
}

impl TranscriptionProgress {
    pub fn new(meeting_id: &str, phase: Phase, fraction: f32) -> Self {
        let (start, end) = phase.span();
        Self {
            meeting_id: meeting_id.to_string(),
            phase,
            progress: start + (end - start) * fraction.clamp(0.0, 1.0),
        }
    }
}

pub type ProgressSink = Arc<dyn Fn(Phase, f32) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct IdentityDecisionReport {
    pub speaker: String,
    pub person_id: Option<String>,
    pub confidence: Option<f64>,
    pub margin: Option<f64>,
    pub reason: String,
}

pub struct TranscriptionReport {
    pub cleanup_error: Option<String>,
    pub identification_error: Option<String>,
    pub active_sources: Vec<String>,
    pub speaker_count: usize,
    pub merged_labels: Vec<f32>,
    pub audio_ms: i64,
    pub elapsed: Duration,
    pub identity_candidates: usize,
    pub identity_decisions: Vec<IdentityDecisionReport>,
}

struct Candidate {
    person_id: String,
    embedding: Vec<f32>,
}

#[derive(Debug, Clone)]
struct AcceptedIdentity {
    person_id: String,
    similarity: f32,
}

pub async fn transcribe_meeting(
    database: &Database,
    voice_profiles: &VoiceProfileStore,
    models: &SpeechModels,
    meeting_id: &str,
    progress: ProgressSink,
) -> AppResult<TranscriptionReport> {
    let started = Instant::now();
    let meeting = database.meeting(meeting_id)?;
    let audio_directory = meeting
        .audio_directory
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Validation("This meeting has no saved audio".to_string()))?;
    let model_paths = models.paths()?;
    let boundary = database.import_transcription_boundary(meeting_id)?;

    progress(Phase::Preparing, 0.0);
    let directory = audio_directory.clone();
    let pipeline_progress = progress.clone();
    let (active_sources, mut transcript) = tauri::async_runtime::spawn_blocking(move || {
        let mut preparing = |fraction| pipeline_progress(Phase::Preparing, fraction * 0.9);
        let staging;
        let (wav, active_sources) = if let Some((session, _)) = boundary {
            staging = tempfile::tempdir()?;
            speech_audio::prepare_imported_recording(
                &directory,
                session,
                staging.path(),
                &mut preparing,
            )?
        } else {
            (
                speech_audio::export_mixed_recording_with_progress(&directory, &mut preparing)?,
                speech_audio::active_capture_sources(&directory)?,
            )
        };
        pipeline_progress(Phase::Preparing, 1.0);
        let transcript = speech::transcribe(&wav, &model_paths, &mut |stage, fraction| {
            let phase = match stage {
                Stage::Separating => Phase::Separating,
                Stage::Transcribing => Phase::Transcribing,
                Stage::Identifying => Phase::Identifying,
            };
            pipeline_progress(phase, fraction);
        })?;
        Ok::<_, AppError>((active_sources, transcript))
    })
    .await
    .map_err(|error| AppError::Speech(format!("The speech worker stopped: {error}")))??;
    if transcript.turns.is_empty() && boundary.is_none() {
        return Err(AppError::Validation(
            "No speech was found in this recording".to_string(),
        ));
    }

    let import_session = boundary.map(|(session, _)| session);
    let append_from_ms = boundary.map(|(_, offset)| offset);
    if let Some(offset) = append_from_ms {
        for turn in &mut transcript.turns {
            turn.start_ms += offset;
            turn.end_ms += offset;
        }
        for span in &mut transcript.spans {
            span.start_ms += offset;
            span.end_ms += offset;
        }
    }
    let people = database.people()?;
    let settings = database.settings()?;
    let profiles = database.voice_profiles()?;
    // "Label this person automatically" off also turns off local-microphone attribution.
    let local_speaker_disabled =
        settings
            .local_speaker_person_id
            .as_ref()
            .is_some_and(|person_id| {
                profiles
                    .iter()
                    .any(|profile| &profile.person_id == person_id && profile.status == "disabled")
            });
    let mut candidates = Vec::new();
    let mut storage_warnings = Vec::new();
    for profile in profiles.iter().filter(|profile| profile.status == "ready") {
        match voice_profiles.load(&profile.person_id) {
            Ok(Some(stored)) => match Voiceprint::decode(&stored) {
                Some(voiceprint) => candidates.push(Candidate {
                    person_id: profile.person_id.clone(),
                    embedding: voiceprint.embedding,
                }),
                None => storage_warnings.push(format!(
                    "person={} voiceprint is from another model",
                    profile.person_id
                )),
            },
            Ok(None) => storage_warnings.push(format!(
                "person={} encrypted profile is missing",
                profile.person_id
            )),
            Err(error) => {
                storage_warnings.push(format!("person={} detail={error}", profile.person_id))
            }
        }
    }
    let valid_person_ids = people
        .iter()
        .map(|person| person.id.clone())
        .collect::<HashSet<_>>();
    candidates.retain(|candidate| valid_person_ids.contains(&candidate.person_id));
    let (identities, mut identity_decisions) = identify_voices(&transcript.voices, &candidates);
    progress(Phase::Identifying, 1.0);

    voice_reference::write_overlap_metadata(&audio_directory, &transcript.spans, append_from_ms)?;
    let existing_segments = database.segments_for_meeting(meeting_id)?;
    let mut segments = Vec::with_capacity(transcript.turns.len());
    for turn in &transcript.turns {
        let manual_person =
            person_from_manual_overlap(&existing_segments, turn.start_ms, turn.end_ms);
        let local_person = if local_speaker_disabled || manual_person.is_some() {
            None
        } else {
            local_microphone_person(
                &audio_directory,
                &settings,
                &active_sources,
                turn.start_ms,
                turn.end_ms,
            )
        };
        let (person_id, identity_source, identity_confidence) = if let Some(person) = manual_person
        {
            (Some(person), Some("manual".to_string()), None)
        } else if let Some(person) = local_person {
            (
                Some(person),
                Some("local_microphone".to_string()),
                Some(100.0),
            )
        } else if let Some(identity) = identities.get(&turn.speaker) {
            (
                Some(identity.person_id.clone()),
                Some("voiceprint".to_string()),
                Some(f64::from(identity.similarity) * 100.0),
            )
        } else {
            (None, None, None)
        };
        segments.push(TranscriptSegment {
            id: Uuid::new_v4().to_string(),
            meeting_id: meeting_id.to_string(),
            speaker_label: recording_speaker_label(import_session, speaker_label(turn.speaker)),
            person_id,
            identity_source,
            identity_confidence,
            start_ms: turn.start_ms,
            end_ms: turn.end_ms,
            text: turn.text.clone(),
        });
    }
    for decision in &mut identity_decisions {
        decision.speaker =
            recording_speaker_label(import_session, std::mem::take(&mut decision.speaker));
        if segments.iter().any(|segment| {
            segment.speaker_label == decision.speaker
                && segment.identity_source.as_deref() == Some("local_microphone")
        }) {
            decision.reason = "local_microphone".to_string();
        }
    }
    // People can be deleted while the job runs; a stale id would violate the
    // person_id foreign key and roll back the whole insert.
    let fresh_person_ids = database
        .people()?
        .into_iter()
        .map(|person| person.id)
        .collect::<HashSet<_>>();
    for segment in &mut segments {
        if segment
            .person_id
            .as_ref()
            .is_some_and(|person_id| !fresh_person_ids.contains(person_id))
        {
            segment.person_id = None;
            segment.identity_source = None;
            segment.identity_confidence = None;
        }
    }
    database.store_transcription_segments(meeting_id, &segments, import_session)?;

    let cleanup_error = if credentials::has_openai_key().unwrap_or(false) {
        progress(Phase::Polishing, 0.0);
        let project_name = meeting.project_id.as_ref().and_then(|project_id| {
            database
                .projects()
                .ok()?
                .into_iter()
                .find(|project| &project.id == project_id)
                .map(|project| project.name)
        });
        let context = CleanupContext {
            meeting_id: meeting_id.to_string(),
            meeting_title: meeting.title,
            project_name,
            people,
        };
        let polishing = progress.clone();
        optional_cleanup(database, &context, &segments, &move |fraction| {
            polishing(Phase::Polishing, fraction)
        })
        .await
    } else {
        None
    };
    progress(Phase::Polishing, 1.0);

    Ok(TranscriptionReport {
        cleanup_error,
        identification_error: (!storage_warnings.is_empty())
            .then(|| format!("voice_profile_storage {}", storage_warnings.join("; "))),
        active_sources,
        speaker_count: transcript.voices.len(),
        merged_labels: transcript.merges,
        audio_ms: transcript.duration_ms,
        elapsed: started.elapsed(),
        identity_candidates: candidates.len(),
        identity_decisions,
    })
}

pub fn speaker_label(speaker: usize) -> String {
    format!("voice:{}", speaker + 1)
}

/// Diarization starts numbering speakers again for each independently processed file.
fn recording_speaker_label(session: Option<i64>, label: String) -> String {
    match session {
        Some(session) => format!("import:{session}:{label}"),
        None => label,
    }
}

async fn optional_cleanup(
    database: &Database,
    context: &CleanupContext,
    segments: &[TranscriptSegment],
    progress: &(dyn Fn(f32) + Sync),
) -> Option<String> {
    let api_key = credentials::openai_key().ok()?;
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(5 * 60))
        .build()
    {
        Ok(client) => client,
        Err(error) => return Some(format!("Could not prepare transcript cleanup: {error}")),
    };
    match transcript_cleanup::refine_transcript(&client, &api_key, context, segments, progress)
        .await
    {
        Ok(refined) => database
            .update_segment_texts(&context.meeting_id, &refined)
            .err()
            .map(|error| error.to_string()),
        Err(error) => Some(error.to_string()),
    }
}

/// Names each detected voice after the saved person it clearly sounds like.
/// One person per voice and one voice per person, strongest match first.
fn identify_voices(
    voices: &[Voice],
    candidates: &[Candidate],
) -> (
    HashMap<usize, AcceptedIdentity>,
    Vec<IdentityDecisionReport>,
) {
    struct Scored<'a> {
        speaker: usize,
        best: Option<(&'a str, f32)>,
        margin: f32,
        reason: &'static str,
    }

    let mut scored = voices
        .iter()
        .map(|voice| {
            let mut scores = voice
                .embedding
                .as_ref()
                .filter(|_| voice.clean_ms >= MIN_IDENTITY_CLEAN_MS)
                .map(|embedding| {
                    candidates
                        .iter()
                        .map(|candidate| {
                            (
                                candidate.person_id.as_str(),
                                speech::cosine_similarity(embedding, &candidate.embedding),
                            )
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            scores.sort_by(|left, right| right.1.total_cmp(&left.1));
            let best = scores.first().copied();
            let margin = match (best, scores.get(1)) {
                (Some((_, first)), Some((_, second))) => first - second,
                (Some((_, first)), None) => first,
                _ => 0.0,
            };
            let reason = if voice.embedding.is_none() || voice.clean_ms < MIN_IDENTITY_CLEAN_MS {
                "too_little_solo_speech"
            } else if best.is_none() {
                "no_saved_voices"
            } else if best.is_some_and(|(_, score)| score < MIN_IDENTITY_SIMILARITY) {
                "below_threshold"
            } else if margin < MIN_IDENTITY_MARGIN {
                "ambiguous"
            } else {
                "accepted"
            };
            Scored {
                speaker: voice.speaker,
                best,
                margin,
                reason,
            }
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| {
        let score = |entry: &Scored| entry.best.map(|(_, score)| score).unwrap_or(f32::MIN);
        score(right).total_cmp(&score(left))
    });

    let mut identities = HashMap::new();
    let mut taken = HashSet::new();
    let mut reports = Vec::with_capacity(scored.len());
    for entry in scored {
        let mut reason = entry.reason;
        if reason == "accepted" {
            if let Some((person_id, similarity)) = entry.best {
                if taken.insert(person_id) {
                    identities.insert(
                        entry.speaker,
                        AcceptedIdentity {
                            person_id: person_id.to_string(),
                            similarity,
                        },
                    );
                } else {
                    reason = "person_already_matched";
                }
            }
        }
        reports.push(IdentityDecisionReport {
            speaker: speaker_label(entry.speaker),
            person_id: (reason == "accepted")
                .then(|| entry.best.map(|(person_id, _)| person_id.to_string()))
                .flatten(),
            confidence: entry.best.map(|(_, score)| f64::from(score) * 100.0),
            margin: entry.best.map(|_| f64::from(entry.margin) * 100.0),
            reason: reason.to_string(),
        });
    }
    reports.sort_by(|left, right| left.speaker.cmp(&right.speaker));
    (identities, reports)
}

fn person_from_manual_overlap(
    existing_segments: &[TranscriptSegment],
    start_ms: i64,
    end_ms: i64,
) -> Option<String> {
    let duration_ms = (end_ms - start_ms).max(1);
    let (person_id, overlap_ms) = existing_segments
        .iter()
        .filter_map(|segment| {
            if segment.identity_source.as_deref() != Some("manual") {
                return None;
            }
            let person_id = segment.person_id.as_ref()?;
            let overlap_ms = overlap_ms(start_ms, end_ms, segment.start_ms, segment.end_ms);
            (overlap_ms > 0).then_some((person_id, overlap_ms))
        })
        .max_by_key(|(_, overlap_ms)| *overlap_ms)?;
    (overlap_ms * 2 >= duration_ms).then(|| person_id.clone())
}

fn local_microphone_person(
    audio_directory: &Path,
    settings: &AppSettings,
    active_sources: &[String],
    start_ms: i64,
    end_ms: i64,
) -> Option<String> {
    if !settings.prefer_local_speaker_for_microphone
        || !active_sources.iter().any(|source| source == "microphone")
    {
        return None;
    }
    let person_id = settings.local_speaker_person_id.as_ref()?;
    let microphone =
        speech_audio::recording_source_clip(audio_directory, "microphone", start_ms, end_ms)
            .ok()?;
    let microphone_rms = speech_audio::rms(&microphone);
    if microphone_rms < MIN_LOCAL_MICROPHONE_RMS {
        return None;
    }
    if !active_sources.iter().any(|source| source == "system") {
        return Some(person_id.clone());
    }
    let system =
        speech_audio::recording_source_clip(audio_directory, "system", start_ms, end_ms).ok()?;
    let system_rms = speech_audio::rms(&system);
    (system_rms < 1.0 || microphone_rms / system_rms >= MIN_LOCAL_MICROPHONE_DOMINANCE)
        .then(|| person_id.clone())
}

fn overlap_ms(left_start: i64, left_end: i64, right_start: i64, right_end: i64) -> i64 {
    left_end.min(right_end) - left_start.max(right_start)
}

/// A short category for the log and a message the person can act on.
pub fn failure_summary(error: &AppError) -> (&'static str, String) {
    match error {
        AppError::Validation(message) => ("validation", message.clone()),
        AppError::Speech(_) => (
            "speech_model",
            "The speech models could not process this recording. Open the log for details."
                .to_string(),
        ),
        AppError::Audio(_) | AppError::Io(_) => (
            "local_audio",
            "Listen could not read the saved recording. Open the log for details.".to_string(),
        ),
        _ => (
            "unexpected",
            "Listen could not create this transcript. Open the log for the exact reason."
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn voice(speaker: usize, embedding: Vec<f32>) -> Voice {
        Voice {
            speaker,
            speech_ms: 60_000,
            clean_ms: 30_000,
            embedding: Some(embedding),
        }
    }

    fn candidate(person_id: &str, embedding: Vec<f32>) -> Candidate {
        Candidate {
            person_id: person_id.to_string(),
            embedding,
        }
    }

    #[test]
    fn names_clear_matches_and_leaves_uncertain_voices_unknown() {
        let voices = vec![
            voice(0, vec![1.0, 0.0, 0.0]),
            voice(1, vec![0.0, 1.0, 0.0]),
            voice(2, vec![0.0, -1.0, 0.0]),
        ];
        let candidates = vec![
            candidate("nestor", vec![0.95, 0.1, 0.0]),
            candidate("freddy", vec![0.1, 0.7, 0.7]),
            candidate("amy", vec![0.0, 0.75, 0.66]),
        ];
        let (identities, reports) = identify_voices(&voices, &candidates);
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[&0].person_id, "nestor");
        assert_eq!(reports[0].reason, "accepted");
        assert_eq!(reports[1].reason, "ambiguous", "0.75 against 0.70");
        assert_eq!(reports[2].reason, "below_threshold");
    }

    #[test]
    fn one_person_per_voice_strongest_first() {
        let voices = vec![voice(0, vec![0.8, 0.6]), voice(1, vec![1.0, 0.0])];
        let candidates = vec![candidate("nestor", vec![1.0, 0.0])];
        let (identities, reports) = identify_voices(&voices, &candidates);
        assert_eq!(identities.len(), 1);
        assert_eq!(identities[&1].person_id, "nestor");
        assert_eq!(reports[0].reason, "person_already_matched");
    }

    #[test]
    fn short_voices_are_never_named() {
        let mut short = voice(0, vec![1.0, 0.0]);
        short.clean_ms = 1_000;
        let (identities, reports) =
            identify_voices(&[short], &[candidate("nestor", vec![1.0, 0.0])]);
        assert!(identities.is_empty());
        assert_eq!(reports[0].reason, "too_little_solo_speech");
    }

    #[test]
    fn progress_spans_cover_the_whole_job() {
        assert_eq!(
            TranscriptionProgress::new("m", Phase::Preparing, 0.0).progress,
            0.0
        );
        assert!(
            (TranscriptionProgress::new("m", Phase::Transcribing, 0.5).progress - 0.6).abs() < 1e-6
        );
        assert_eq!(
            TranscriptionProgress::new("m", Phase::Polishing, 1.0).progress,
            1.0
        );
    }

    #[test]
    fn only_preserves_explicit_manual_assignments() {
        let manual = TranscriptSegment {
            id: "one".to_string(),
            meeting_id: "meeting".to_string(),
            speaker_label: "voice:1".to_string(),
            person_id: Some("vini".to_string()),
            identity_source: Some("manual".to_string()),
            identity_confidence: None,
            start_ms: 0,
            end_ms: 5_000,
            text: "Hello".to_string(),
        };
        let automatic = TranscriptSegment {
            id: "two".to_string(),
            person_id: Some("freddy".to_string()),
            identity_source: Some("voiceprint".to_string()),
            start_ms: 5_000,
            end_ms: 10_000,
            ..manual.clone()
        };

        assert_eq!(
            person_from_manual_overlap(&[manual], 0, 5_000),
            Some("vini".to_string())
        );
        assert_eq!(
            person_from_manual_overlap(&[automatic], 5_000, 10_000),
            None
        );
    }
}
