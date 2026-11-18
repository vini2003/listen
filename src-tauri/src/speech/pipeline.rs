use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{
    audio::{ms_to_samples, MeetingAudio},
    diarization::{self, join_spans, renumber},
    embedding::{centroid, SpeakerEmbedder},
    recognition::{self, Word},
    voiceprint::cosine_similarity,
};
use crate::error::AppResult;

/// Stretches of one voice shorter than this are not used to measure it.
const MIN_CLEAN_MS: i64 = 1_000;
const MAX_CLIP_MS: i64 = 10_000;
const MAX_CLIPS_PER_VOICE: usize = 24;
const MAX_MEASURED_MS_PER_VOICE: i64 = 120_000;
/// Nemotron can give one person two labels, typically when a recording is
/// resumed hours later. Two labels whose voices are this similar and who
/// almost never talk at the same time are treated as one person.
const MERGE_SIMILARITY: f32 = 0.72;
const MAX_MERGE_CROSSTALK: f64 = 0.02;
/// A word with no detected speaker under it goes to the closest one nearby.
const NEAREST_SPEAKER_MS: i64 = 1_000;
const TURN_PAUSE_MS: i64 = 2_000;
const SOFT_TURN_MS: i64 = 30_000;
const HARD_TURN_MS: i64 = 60_000;

pub struct ModelPaths {
    pub diarizer: PathBuf,
    pub recognizer: PathBuf,
    pub embedder: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Separating,
    Transcribing,
    Identifying,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeakerSpan {
    pub speaker: usize,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Turn {
    pub speaker: usize,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct Voice {
    pub speaker: usize,
    pub speech_ms: i64,
    /// Speech with nobody else talking, which is what the voiceprint uses.
    pub clean_ms: i64,
    pub embedding: Option<Vec<f32>>,
}

pub struct Transcript {
    pub duration_ms: i64,
    pub spans: Vec<SpeakerSpan>,
    pub turns: Vec<Turn>,
    pub voices: Vec<Voice>,
    /// Voice similarity of each label that was folded into another.
    pub merges: Vec<f32>,
}

pub fn transcribe(
    wav: &Path,
    models: &ModelPaths,
    progress: &mut dyn FnMut(Stage, f32),
) -> AppResult<Transcript> {
    let mut audio = MeetingAudio::open(wav)?;
    progress(Stage::Separating, 0.0);
    let spans = diarization::diarize(&models.diarizer, &mut audio, &mut |fraction| {
        progress(Stage::Separating, fraction)
    })?;
    progress(Stage::Transcribing, 0.0);
    let words = recognition::recognize(&models.recognizer, &mut audio, &spans, &mut |fraction| {
        progress(Stage::Transcribing, fraction)
    })?;
    progress(Stage::Identifying, 0.0);
    let mut embedder = SpeakerEmbedder::load(&models.embedder)?;
    let mut voices = measure_voices(&mut embedder, &mut audio, &spans, &mut |fraction| {
        progress(Stage::Identifying, fraction)
    })?;
    drop(embedder);
    let (spans, merges) = merge_same_voices(spans, &mut voices);
    let (spans, voices) = renumber_voices(spans, voices);
    let speakers = assign_speakers(&words, &spans);
    let turns = build_turns(&words, &speakers);
    progress(Stage::Identifying, 1.0);
    Ok(Transcript {
        duration_ms: audio.duration_ms(),
        spans,
        turns,
        voices,
        merges,
    })
}

/// One voiceprint per detected speaker from their longest solo stretches.
fn measure_voices(
    embedder: &mut SpeakerEmbedder,
    audio: &mut MeetingAudio,
    spans: &[SpeakerSpan],
    progress: &mut dyn FnMut(f32),
) -> AppResult<Vec<Voice>> {
    let mut speakers = spans.iter().map(|span| span.speaker).collect::<Vec<_>>();
    speakers.sort_unstable();
    speakers.dedup();
    let mut voices = Vec::with_capacity(speakers.len());
    for (index, speaker) in speakers.iter().copied().enumerate() {
        let speech_ms = spans
            .iter()
            .filter(|span| span.speaker == speaker)
            .map(|span| span.end_ms - span.start_ms)
            .sum();
        let mut regions = solo_regions(spans, speaker);
        let clean_ms = regions.iter().map(|(start, end)| end - start).sum();
        regions.sort_by_key(|(start, end)| std::cmp::Reverse(end - start));
        let mut measured = Vec::new();
        let mut measured_ms = 0;
        for (start_ms, end_ms) in regions.into_iter().take(MAX_CLIPS_PER_VOICE) {
            if measured_ms >= MAX_MEASURED_MS_PER_VOICE {
                break;
            }
            let (start_ms, end_ms) = centred(start_ms, end_ms, MAX_CLIP_MS);
            let samples = audio.read_pcm(ms_to_samples(start_ms), ms_to_samples(end_ms))?;
            if let Some(embedding) = embedder.embed(&samples)? {
                measured.push((embedding, (end_ms - start_ms) as f32));
                measured_ms += end_ms - start_ms;
            }
        }
        voices.push(Voice {
            speaker,
            speech_ms,
            clean_ms,
            embedding: centroid(
                measured
                    .iter()
                    .map(|(embedding, weight)| (embedding.as_slice(), *weight)),
            ),
        });
        progress((index + 1) as f32 / speakers.len() as f32);
    }
    Ok(voices)
}

/// Parts of `speaker`'s spans where no other speaker is active.
pub fn solo_regions(spans: &[SpeakerSpan], speaker: usize) -> Vec<(i64, i64)> {
    let mut regions = Vec::new();
    for span in spans.iter().filter(|span| span.speaker == speaker) {
        let mut others = spans
            .iter()
            .filter(|other| {
                other.speaker != speaker
                    && other.start_ms < span.end_ms
                    && other.end_ms > span.start_ms
            })
            .map(|other| (other.start_ms, other.end_ms))
            .collect::<Vec<_>>();
        others.sort_unstable();
        let mut cursor = span.start_ms;
        for (start, end) in others {
            if start > cursor {
                regions.push((cursor, start.min(span.end_ms)));
            }
            cursor = cursor.max(end);
        }
        if cursor < span.end_ms {
            regions.push((cursor, span.end_ms));
        }
    }
    regions.retain(|(start, end)| end - start >= MIN_CLEAN_MS);
    regions
}

fn centred(start_ms: i64, end_ms: i64, maximum_ms: i64) -> (i64, i64) {
    if end_ms - start_ms <= maximum_ms {
        return (start_ms, end_ms);
    }
    let middle = start_ms + (end_ms - start_ms) / 2;
    (middle - maximum_ms / 2, middle + maximum_ms / 2)
}

/// Folds labels that are the same voice into one, most similar pair first.
fn merge_same_voices(
    mut spans: Vec<SpeakerSpan>,
    voices: &mut Vec<Voice>,
) -> (Vec<SpeakerSpan>, Vec<f32>) {
    let mut merges = Vec::new();
    loop {
        let mut best: Option<(usize, usize, f32)> = None;
        for (left_index, left) in voices.iter().enumerate() {
            for (right_index, right) in voices.iter().enumerate().skip(left_index + 1) {
                let (Some(left_embedding), Some(right_embedding)) =
                    (left.embedding.as_ref(), right.embedding.as_ref())
                else {
                    continue;
                };
                let similarity = cosine_similarity(left_embedding, right_embedding);
                if similarity < MERGE_SIMILARITY
                    || best.is_some_and(|(_, _, current)| current >= similarity)
                {
                    continue;
                }
                let crosstalk = crosstalk_ms(&spans, left.speaker, right.speaker) as f64;
                let shorter = left.speech_ms.min(right.speech_ms).max(1) as f64;
                if crosstalk / shorter <= MAX_MERGE_CROSSTALK {
                    best = Some((left_index, right_index, similarity));
                }
            }
        }
        let Some((keep_index, fold_index, similarity)) = best else {
            break;
        };
        let folded = voices.remove(fold_index);
        let kept = &mut voices[keep_index];
        for span in &mut spans {
            if span.speaker == folded.speaker {
                span.speaker = kept.speaker;
            }
        }
        kept.embedding = centroid([
            (
                kept.embedding.as_deref().unwrap_or_default(),
                kept.clean_ms as f32,
            ),
            (
                folded.embedding.as_deref().unwrap_or_default(),
                folded.clean_ms as f32,
            ),
        ]);
        kept.speech_ms += folded.speech_ms;
        kept.clean_ms += folded.clean_ms;
        merges.push(similarity);
    }
    (join_spans(spans), merges)
}

fn crosstalk_ms(spans: &[SpeakerSpan], left: usize, right: usize) -> i64 {
    let mut total = 0;
    for a in spans.iter().filter(|span| span.speaker == left) {
        for b in spans.iter().filter(|span| span.speaker == right) {
            total += (a.end_ms.min(b.end_ms) - a.start_ms.max(b.start_ms)).max(0);
        }
    }
    total
}

fn renumber_voices(spans: Vec<SpeakerSpan>, voices: Vec<Voice>) -> (Vec<SpeakerSpan>, Vec<Voice>) {
    let original = spans.iter().map(|span| span.speaker).collect::<Vec<_>>();
    let spans = renumber(spans);
    let voices = voices
        .into_iter()
        .filter_map(|mut voice| {
            let index = original
                .iter()
                .position(|speaker| *speaker == voice.speaker)?;
            voice.speaker = spans[index].speaker;
            Some(voice)
        })
        .collect();
    (spans, voices)
}

/// The speaker for each word: whoever talks over most of it, else the
/// closest speaker within a second, else whoever spoke the previous word.
/// Punctuation always stays with the word before it.
fn assign_speakers(words: &[Word], spans: &[SpeakerSpan]) -> Vec<usize> {
    let mut assigned = Vec::with_capacity(words.len());
    let mut previous: Option<usize> = None;
    let mut first_candidate = 0;
    for word in words {
        if is_punctuation(&word.text) {
            if let Some(speaker) = previous {
                assigned.push(speaker);
                continue;
            }
        }
        while first_candidate < spans.len()
            && spans[first_candidate].end_ms + NEAREST_SPEAKER_MS * 30 < word.start_ms
        {
            first_candidate += 1;
        }
        let mut best_overlap = (0, None);
        let mut nearest = (i64::MAX, None);
        for span in spans[first_candidate..]
            .iter()
            .take_while(|span| span.start_ms <= word.end_ms + NEAREST_SPEAKER_MS)
        {
            let overlap = word.end_ms.min(span.end_ms) - word.start_ms.max(span.start_ms);
            if overlap > best_overlap.0 {
                best_overlap = (overlap, Some(span.speaker));
            }
            let distance = (span.start_ms - word.end_ms)
                .max(word.start_ms - span.end_ms)
                .max(0);
            if distance < nearest.0 {
                nearest = (distance, Some(span.speaker));
            }
        }
        let speaker = best_overlap
            .1
            .or_else(|| {
                (nearest.0 <= NEAREST_SPEAKER_MS)
                    .then_some(nearest.1)
                    .flatten()
            })
            .or(previous)
            .unwrap_or_default();
        assigned.push(speaker);
        previous = Some(speaker);
    }
    assigned
}

fn build_turns(words: &[Word], speakers: &[usize]) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut ends_sentence = false;
    for (word, speaker) in words.iter().zip(speakers) {
        let continues = turns.last().is_some_and(|turn| {
            let length = word.end_ms - turn.start_ms;
            turn.speaker == *speaker
                && word.start_ms - turn.end_ms <= TURN_PAUSE_MS
                && length <= HARD_TURN_MS
                && !(ends_sentence && length > SOFT_TURN_MS)
        });
        if continues || (is_punctuation(&word.text) && !turns.is_empty()) {
            let turn = turns.last_mut().expect("a turn to continue");
            if !is_punctuation(&word.text) {
                turn.text.push(' ');
            }
            turn.text.push_str(&word.text);
            turn.end_ms = turn.end_ms.max(word.end_ms);
        } else {
            turns.push(Turn {
                speaker: *speaker,
                start_ms: word.start_ms,
                end_ms: word.end_ms.max(word.start_ms + 1),
                text: word.text.clone(),
            });
        }
        ends_sentence = word.text.ends_with(['.', '?', '!']);
    }
    turns
}

fn is_punctuation(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|character| character.is_ascii_punctuation())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(speaker: usize, start_ms: i64, end_ms: i64) -> SpeakerSpan {
        SpeakerSpan {
            speaker,
            start_ms,
            end_ms,
        }
    }

    fn word(start_ms: i64, end_ms: i64, text: &str) -> Word {
        Word {
            start_ms,
            end_ms,
            text: text.to_string(),
        }
    }

    #[test]
    fn solo_regions_exclude_crosstalk_and_short_scraps() {
        let spans = vec![
            span(0, 0, 10_000),
            span(1, 4_000, 5_000),
            span(1, 9_500, 12_000),
        ];
        assert_eq!(solo_regions(&spans, 0), vec![(0, 4_000), (5_000, 9_500)]);
        assert_eq!(solo_regions(&spans, 1), vec![(10_000, 12_000)]);
    }

    #[test]
    fn words_follow_overlap_then_proximity_then_context() {
        let spans = vec![span(0, 0, 2_000), span(1, 2_000, 4_000)];
        let words = vec![
            word(100, 400, "Hello"),
            word(400, 450, ","),
            word(1_900, 2_300, "there"),
            word(4_500, 4_800, "friend"),
            word(9_000, 9_400, "again"),
        ];
        assert_eq!(assign_speakers(&words, &spans), vec![0, 0, 1, 1, 1]);
    }

    #[test]
    fn turns_break_on_speaker_and_long_pauses_and_attach_punctuation() {
        let words = vec![
            word(0, 300, "Hi"),
            word(300, 350, "."),
            word(400, 700, "Yes"),
            word(5_000, 5_300, "Later"),
        ];
        let turns = build_turns(&words, &[0, 0, 1, 1]);
        assert_eq!(
            turns
                .iter()
                .map(|turn| (turn.speaker, turn.text.as_str()))
                .collect::<Vec<_>>(),
            vec![(0, "Hi."), (1, "Yes"), (1, "Later")]
        );
    }

    #[test]
    fn long_turns_split_after_a_sentence() {
        let mut words = Vec::new();
        for second in 0..40 {
            let text = if second == 35 { "done." } else { "word" };
            words.push(word(second * 1_000, second * 1_000 + 500, text));
        }
        let turns = build_turns(&words, &vec![0; words.len()]);
        assert_eq!(turns.len(), 2);
        assert!(turns[0].text.ends_with("done."));
    }

    #[test]
    fn merges_similar_voices_that_never_talk_together() {
        let spans = vec![
            span(0, 0, 10_000),
            span(1, 20_000, 30_000),
            span(2, 40_000, 50_000),
        ];
        let mut voices = vec![
            Voice {
                speaker: 0,
                speech_ms: 10_000,
                clean_ms: 10_000,
                embedding: Some(vec![1.0, 0.0]),
            },
            Voice {
                speaker: 1,
                speech_ms: 10_000,
                clean_ms: 10_000,
                embedding: Some(vec![0.0, 1.0]),
            },
            Voice {
                speaker: 2,
                speech_ms: 10_000,
                clean_ms: 10_000,
                embedding: Some(vec![0.99, 0.1]),
            },
        ];
        let (spans, merges) = merge_same_voices(spans, &mut voices);
        assert_eq!(merges.len(), 1);
        assert_eq!(voices.len(), 2);
        assert_eq!(spans.iter().filter(|span| span.speaker == 0).count(), 2);
        let (spans, voices) = renumber_voices(spans, voices);
        assert_eq!(
            spans.iter().map(|span| span.speaker).collect::<Vec<_>>(),
            vec![0, 1, 0]
        );
        assert_eq!(
            voices.iter().map(|voice| voice.speaker).collect::<Vec<_>>(),
            vec![0, 1]
        );
    }

    #[test]
    fn keeps_similar_voices_apart_when_they_overlap() {
        let spans = vec![span(0, 0, 10_000), span(1, 5_000, 15_000)];
        let mut voices = vec![
            Voice {
                speaker: 0,
                speech_ms: 10_000,
                clean_ms: 5_000,
                embedding: Some(vec![1.0, 0.0]),
            },
            Voice {
                speaker: 1,
                speech_ms: 10_000,
                clean_ms: 5_000,
                embedding: Some(vec![1.0, 0.0]),
            },
        ];
        let (_, merges) = merge_same_voices(spans, &mut voices);
        assert!(merges.is_empty());
    }
}
