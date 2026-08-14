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
    domain::{AppSettings, Meeting, TranscriptSegment},
    error::{AppError, AppResult},
    pyannote::{
        self, IdentificationSpan, KnownVoiceprint, PyannoteClient, TranscriptionTurn,
        VoiceprintMatch,
    },
    speech_audio,
    transcript_cleanup::{self, CleanupContext},
    voice_profile_store::VoiceProfileStore,
    voice_reference,
};

const MAX_PYANNOTE_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MIN_IDENTITY_CONFIDENCE: f64 = 72.0;
const MIN_IDENTITY_MARGIN: f64 = 12.0;
const MIN_CLUSTER_ALIGNMENT: f64 = 0.60;
const MIN_LOCAL_MICROPHONE_RMS: f64 = 140.0;
const MIN_LOCAL_MICROPHONE_DOMINANCE: f64 = 2.5;

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
    pub warning: Option<String>,
    pub active_sources: Vec<String>,
    pub minimum_speakers: Option<u8>,
    pub detected_speakers: Vec<String>,
    pub transcribed_speakers: Vec<String>,
    pub identity_candidates: usize,
    pub identity_decisions: Vec<IdentityDecisionReport>,
}

pub async fn transcribe_meeting(
    database: &Database,
    voice_profiles: &VoiceProfileStore,
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
    let settings = database.settings()?;
    let candidate_ids = identification_candidate_ids(database, &meeting, &settings)?;
    let mut known_people = Vec::new();
    let mut profile_storage_warnings = Vec::new();
    for profile in database.voice_profiles()?.into_iter().filter(|profile| {
        candidate_ids.contains(&profile.person_id)
            && profile.status == "ready"
            && profile.consent_confirmed_at.is_some()
    }) {
        if known_people.len() >= 50 {
            break;
        }
        match voice_profiles.load(&profile.person_id) {
            Ok(Some(voiceprint)) => known_people.push(KnownVoiceprint {
                label: profile.person_id,
                voiceprint,
            }),
            Ok(None) => {
                if let Some(voiceprint) = profile.voiceprint {
                    known_people.push(KnownVoiceprint {
                        label: profile.person_id,
                        voiceprint,
                    });
                } else {
                    profile_storage_warnings.push(format!(
                        "person={} encrypted profile is missing",
                        profile.person_id
                    ));
                }
            }
            Err(error) => profile_storage_warnings
                .push(format!("person={} detail={error}", profile.person_id)),
        }
    }

    let (transcription, identification, mut identification_error) = if known_people.is_empty() {
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
    if !profile_storage_warnings.is_empty() {
        let storage_warning = format!(
            "voice_profile_storage {}",
            profile_storage_warnings.join("; ")
        );
        identification_error = Some(match identification_error {
            Some(existing) => format!("{existing}; {storage_warning}"),
            None => storage_warning,
        });
    }

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
    let (cluster_identities, mut identity_decisions) = identification
        .as_ref()
        .map(|output| {
            reconcile_identity_clusters(
                &transcription.turn_level_transcription,
                &output.identification,
                &output.voiceprints,
                &valid_person_ids,
            )
        })
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
            let manual_person = person_from_manual_overlap(&existing_segments, start_ms, end_ms);
            let local_person = local_microphone_person(
                &audio_directory,
                &settings,
                &active_sources,
                start_ms,
                end_ms,
            );
            let voice_identity = cluster_identities.get(&turn.speaker);
            let (person_id, identity_source, identity_confidence) =
                if let Some(person_id) = manual_person {
                    (Some(person_id), Some("manual".to_string()), None)
                } else if let Some(person_id) = local_person {
                    (
                        Some(person_id),
                        Some("local_microphone".to_string()),
                        Some(100.0),
                    )
                } else if let Some(identity) = voice_identity {
                    (
                        Some(identity.person_id.clone()),
                        Some("voiceprint".to_string()),
                        Some(identity.confidence),
                    )
                } else {
                    (None, None, None)
                };
            Some(TranscriptSegment {
                id: Uuid::new_v4().to_string(),
                meeting_id: meeting_id.to_string(),
                speaker_label: format!("precision:{}", turn.speaker),
                person_id,
                identity_source,
                identity_confidence,
                start_ms,
                end_ms,
                text: text.to_string(),
            })
        })
        .collect::<Vec<_>>();
    segments.sort_by_key(|segment| segment.start_ms);
    for decision in &mut identity_decisions {
        if segments.iter().any(|segment| {
            segment.speaker_label == format!("precision:{}", decision.speaker)
                && segment.identity_source.as_deref() == Some("local_microphone")
        }) {
            decision.reason = "local_microphone".to_string();
        }
    }
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
        identity_candidates: known_people.len(),
        identity_decisions,
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

#[derive(Debug, Clone)]
struct AcceptedIdentity {
    person_id: String,
    confidence: f64,
}

fn identification_candidate_ids(
    database: &Database,
    meeting: &Meeting,
    settings: &AppSettings,
) -> AppResult<HashSet<String>> {
    if !settings.speaker_identification_enabled || settings.biometric_consent_accepted_at.is_none()
    {
        return Ok(HashSet::new());
    }

    let mut candidates = HashSet::new();
    if let Some(person_id) = settings.local_speaker_person_id.as_ref() {
        candidates.insert(person_id.clone());
    }

    let related_meeting_ids = database
        .meetings()?
        .into_iter()
        .filter(|candidate| {
            candidate.id == meeting.id
                || meeting.project_id.is_some() && candidate.project_id == meeting.project_id
        })
        .map(|candidate| candidate.id)
        .collect::<HashSet<_>>();
    for segment in database.segments()? {
        if related_meeting_ids.contains(&segment.meeting_id) {
            if let Some(person_id) = segment.person_id {
                candidates.insert(person_id);
            }
        }
    }
    Ok(candidates)
}

fn reconcile_identity_clusters(
    transcription: &[TranscriptionTurn],
    identification: &[IdentificationSpan],
    voiceprints: &[VoiceprintMatch],
    valid_person_ids: &HashSet<String>,
) -> (
    HashMap<String, AcceptedIdentity>,
    Vec<IdentityDecisionReport>,
) {
    let mut accepted_by_identification_cluster = HashMap::new();
    let mut score_by_identification_cluster = HashMap::new();

    for result in voiceprints {
        let mut scores = result
            .confidence
            .iter()
            .filter(|(person_id, _)| valid_person_ids.contains(*person_id))
            .map(|(person_id, score)| (person_id.as_str(), *score))
            .collect::<Vec<_>>();
        scores.sort_by(|left, right| right.1.total_cmp(&left.1));
        let Some((best_person, best_score)) = scores.first().copied() else {
            continue;
        };
        let second_score = scores.get(1).map(|(_, score)| *score).unwrap_or(0.0);
        let margin = best_score - second_score;
        score_by_identification_cluster.insert(
            result.speaker.clone(),
            (best_person.to_string(), best_score, margin),
        );
        if result.r#match.as_deref() == Some(best_person)
            && best_score >= MIN_IDENTITY_CONFIDENCE
            && margin >= MIN_IDENTITY_MARGIN
        {
            accepted_by_identification_cluster.insert(
                result.speaker.clone(),
                AcceptedIdentity {
                    person_id: best_person.to_string(),
                    confidence: best_score,
                },
            );
        }
    }

    let mut identities = HashMap::new();
    let mut reports = Vec::new();
    let transcription_speakers = transcription
        .iter()
        .map(|turn| turn.speaker.as_str())
        .collect::<HashSet<_>>();
    for speaker in transcription_speakers {
        let speaker_turns = transcription.iter().filter(|turn| turn.speaker == speaker);
        let mut total_ms = 0i64;
        let mut overlap_by_cluster = HashMap::<&str, i64>::new();
        for turn in speaker_turns {
            let start_ms = seconds_to_ms(turn.start);
            let end_ms = seconds_to_ms(turn.end);
            total_ms += (end_ms - start_ms).max(0);
            for span in identification {
                let Some(cluster) = span.diarization_speaker.as_deref() else {
                    continue;
                };
                let overlap = overlap_ms(
                    start_ms,
                    end_ms,
                    seconds_to_ms(span.start),
                    seconds_to_ms(span.end),
                );
                if overlap > 0 {
                    *overlap_by_cluster.entry(cluster).or_default() += overlap;
                }
            }
        }

        let aligned = overlap_by_cluster
            .into_iter()
            .max_by_key(|(_, overlap)| *overlap)
            .filter(|(_, overlap)| {
                total_ms > 0 && *overlap as f64 / total_ms as f64 >= MIN_CLUSTER_ALIGNMENT
            });
        let Some((identification_cluster, _)) = aligned else {
            reports.push(IdentityDecisionReport {
                speaker: speaker.to_string(),
                person_id: None,
                confidence: None,
                margin: None,
                reason: "cluster_alignment_low".to_string(),
            });
            continue;
        };
        let scores = score_by_identification_cluster.get(identification_cluster);
        if let Some(identity) = accepted_by_identification_cluster.get(identification_cluster) {
            identities.insert(speaker.to_string(), identity.clone());
            reports.push(IdentityDecisionReport {
                speaker: speaker.to_string(),
                person_id: Some(identity.person_id.clone()),
                confidence: Some(identity.confidence),
                margin: scores.map(|(_, _, margin)| *margin),
                reason: "accepted".to_string(),
            });
        } else {
            reports.push(IdentityDecisionReport {
                speaker: speaker.to_string(),
                person_id: None,
                confidence: scores.map(|(_, score, _)| *score),
                margin: scores.map(|(_, _, margin)| *margin),
                reason: if scores.is_some() {
                    "below_threshold"
                } else {
                    "no_candidate_score"
                }
                .to_string(),
            });
        }
    }
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
    audio_directory: &std::path::Path,
    settings: &AppSettings,
    active_sources: &[String],
    start_ms: i64,
    end_ms: i64,
) -> Option<String> {
    if !settings.prefer_local_speaker_for_microphone
        || !settings.speaker_identification_enabled
        || settings.biometric_consent_accepted_at.is_none()
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
    fn maps_confident_identity_by_time_across_request_local_clusters() {
        let turns = vec![TranscriptionTurn {
            speaker: "SPEAKER_00".to_string(),
            start: 10.0,
            end: 15.0,
            text: "Hello".to_string(),
        }];
        let spans = vec![IdentificationSpan {
            start: 10.2,
            end: 14.9,
            diarization_speaker: Some("SPEAKER_17".to_string()),
        }];
        let matches = vec![VoiceprintMatch {
            speaker: "SPEAKER_17".to_string(),
            r#match: Some("nestor".to_string()),
            confidence: HashMap::from([("nestor".to_string(), 91.0), ("freddy".to_string(), 12.0)]),
        }];
        let valid = HashSet::from(["nestor".to_string(), "freddy".to_string()]);

        let (identities, reports) = reconcile_identity_clusters(&turns, &spans, &matches, &valid);
        assert_eq!(identities["SPEAKER_00"].person_id, "nestor");
        assert_eq!(reports[0].reason, "accepted");
    }

    #[test]
    fn rejects_low_confidence_or_ambiguous_voiceprints() {
        let turns = vec![TranscriptionTurn {
            speaker: "SPEAKER_00".to_string(),
            start: 10.0,
            end: 20.0,
            text: "Hello".to_string(),
        }];
        let spans = vec![IdentificationSpan {
            start: 10.0,
            end: 20.0,
            diarization_speaker: Some("SPEAKER_04".to_string()),
        }];
        let matches = vec![VoiceprintMatch {
            speaker: "SPEAKER_04".to_string(),
            r#match: Some("nestor".to_string()),
            confidence: HashMap::from([("nestor".to_string(), 76.0), ("freddy".to_string(), 70.0)]),
        }];
        let valid = HashSet::from(["nestor".to_string(), "freddy".to_string()]);

        let (identities, reports) = reconcile_identity_clusters(&turns, &spans, &matches, &valid);
        assert!(identities.is_empty());
        assert_eq!(reports[0].reason, "below_threshold");
    }

    #[test]
    fn only_preserves_explicit_manual_assignments() {
        let manual = TranscriptSegment {
            id: "one".to_string(),
            meeting_id: "meeting".to_string(),
            speaker_label: "precision:A".to_string(),
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
