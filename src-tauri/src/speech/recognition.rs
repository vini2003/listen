use std::path::Path;

use parakeet_rs::{ParakeetTDT, TimestampMode, Transcriber};

use super::{
    audio::{ms_to_samples, MeetingAudio, SAMPLES_PER_MS, SAMPLE_RATE},
    pipeline::SpeakerSpan,
    runtime::{execution_config, model_error},
};
use crate::error::AppResult;

/// Parakeet attends over its whole input, so long meetings are cut into
/// windows. 30 s measured best: 2-minute windows dropped more words and ran
/// slower, while shorter ones lose sentence context.
const MAX_WINDOW_MS: i64 = 30_000;
/// Cuts are placed at the quietest moment in the last ten seconds of a window.
const CUT_SEARCH_MS: i64 = 10_000;
const FRAME_MS: i64 = 100;
/// A window with no detected speaker and nothing louder than this is skipped.
const SILENT_PEAK_RMS: f32 = 300.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Word {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Word-timed text for the whole meeting, in order.
pub fn recognize(
    model: &Path,
    audio: &mut MeetingAudio,
    spans: &[SpeakerSpan],
    progress: &mut dyn FnMut(f32),
) -> AppResult<Vec<Word>> {
    let envelope = loudness_envelope(audio)?;
    let speech = speech_frames(spans, envelope.len());
    let windows = plan_windows(&envelope, &speech);
    let total_ms = windows.last().map(|(_, end)| *end).unwrap_or(1).max(1);

    let mut recognizer = ParakeetTDT::from_pretrained(model, Some(execution_config()?))
        .map_err(|error| model_error("load the speech recognition model", error))?;
    let mut words = Vec::new();
    for (start_ms, end_ms) in windows {
        if is_silent(&envelope, &speech, start_ms, end_ms) {
            progress(end_ms as f32 / total_ms as f32);
            continue;
        }
        let samples = audio.read(ms_to_samples(start_ms), ms_to_samples(end_ms))?;
        let result = recognizer
            .transcribe_samples(samples, SAMPLE_RATE as u32, 1, Some(TimestampMode::Words))
            .map_err(|error| model_error("transcribe speech", error))?;
        words.extend(
            result
                .tokens
                .into_iter()
                .filter(|token| !token.text.trim().is_empty())
                .map(|token| Word {
                    start_ms: start_ms + (token.start * 1_000.0).round() as i64,
                    end_ms: start_ms + (token.end * 1_000.0).round() as i64,
                    text: token.text.trim().to_string(),
                }),
        );
        progress(end_ms as f32 / total_ms as f32);
    }
    Ok(words)
}

/// RMS per 100 ms frame, at int16 scale.
fn loudness_envelope(audio: &mut MeetingAudio) -> AppResult<Vec<f32>> {
    let frame = FRAME_MS as usize * SAMPLES_PER_MS;
    let block = frame * 600;
    let mut envelope = Vec::with_capacity(audio.len() / frame + 1);
    let mut position = 0;
    while position < audio.len() {
        let samples = audio.read_pcm(position, position + block)?;
        envelope.extend(samples.chunks(frame).map(|chunk| {
            (chunk
                .iter()
                .map(|sample| (*sample as f32).powi(2))
                .sum::<f32>()
                / chunk.len() as f32)
                .sqrt()
        }));
        position += block;
    }
    Ok(envelope)
}

fn speech_frames(spans: &[SpeakerSpan], frames: usize) -> Vec<bool> {
    let mut speech = vec![false; frames];
    for span in spans {
        let first = (span.start_ms / FRAME_MS).max(0) as usize;
        let last = ((span.end_ms + FRAME_MS - 1) / FRAME_MS) as usize;
        for frame in speech.iter_mut().take(last.min(frames)).skip(first) {
            *frame = true;
        }
    }
    speech
}

/// Splits the meeting into windows of at most 30 s, cutting where nobody is
/// speaking and the audio is quietest so words are not sliced in half.
fn plan_windows(envelope: &[f32], speech: &[bool]) -> Vec<(i64, i64)> {
    let total_ms = envelope.len() as i64 * FRAME_MS;
    let mut windows = Vec::new();
    let mut start_ms = 0;
    while start_ms < total_ms {
        if total_ms - start_ms <= MAX_WINDOW_MS {
            windows.push((start_ms, total_ms));
            break;
        }
        let first = ((start_ms + MAX_WINDOW_MS - CUT_SEARCH_MS) / FRAME_MS) as usize;
        let last = ((start_ms + MAX_WINDOW_MS) / FRAME_MS) as usize;
        let cut = (first..last)
            .min_by(|left, right| {
                cut_cost(envelope, speech, *left).total_cmp(&cut_cost(envelope, speech, *right))
            })
            .unwrap_or(last);
        let end_ms = cut as i64 * FRAME_MS + FRAME_MS / 2;
        windows.push((start_ms, end_ms));
        start_ms = end_ms;
    }
    windows
}

fn cut_cost(envelope: &[f32], speech: &[bool], frame: usize) -> f32 {
    let loudness = envelope.get(frame).copied().unwrap_or_default();
    if speech.get(frame).copied().unwrap_or_default() {
        loudness + 1_000.0
    } else {
        loudness
    }
}

fn is_silent(envelope: &[f32], speech: &[bool], start_ms: i64, end_ms: i64) -> bool {
    let first = (start_ms / FRAME_MS) as usize;
    let last = ((end_ms / FRAME_MS) as usize).min(envelope.len());
    !speech[first.min(last)..last].iter().any(|active| *active)
        && envelope[first.min(last)..last]
            .iter()
            .all(|loudness| *loudness < SILENT_PEAK_RMS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_cut_at_the_quietest_unspoken_frame() {
        let mut envelope = vec![900.0; 700];
        envelope[250] = 10.0; // quiet but someone is speaking
        envelope[260] = 40.0; // quiet and nobody speaking
        let mut speech = vec![true; 700];
        speech[260] = false;
        let windows = plan_windows(&envelope, &speech);
        assert_eq!(windows[0], (0, 26_050));
        assert!(windows
            .iter()
            .all(|(start, end)| end - start <= MAX_WINDOW_MS));
        assert_eq!(windows.last().map(|window| window.1), Some(70_000));
    }

    #[test]
    fn skips_only_windows_without_speech_or_sound() {
        let envelope = vec![50.0; 100];
        let mut speech = vec![false; 100];
        assert!(is_silent(&envelope, &speech, 0, 10_000));
        speech[40] = true;
        assert!(!is_silent(&envelope, &speech, 0, 10_000));
        let loud = vec![2_000.0; 100];
        assert!(!is_silent(&loud, &[false; 100], 0, 10_000));
    }
}
