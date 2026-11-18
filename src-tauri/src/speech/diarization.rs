use std::path::Path;

use parakeet_rs::sortformer::{DiarizationConfig, Sortformer, StreamingProfile};

use super::{
    audio::{samples_to_ms, MeetingAudio, SAMPLE_RATE},
    pipeline::SpeakerSpan,
    runtime::{execution_config, model_error},
};
use crate::error::AppResult;

/// Ten seconds per read keeps memory flat; the model buffers its own window.
const FEED_SAMPLES: usize = SAMPLE_RATE * 10;
/// Same-speaker spans this close together are one span. Also rejoins spans
/// that the model splits at its 27-second window edges.
const JOIN_GAP_MS: i64 = 200;

/// Who speaks when, streamed through Nemotron 3 Diarization with NVIDIA's
/// offline profile (27 s steps with 3 s look-ahead and a long speaker cache).
pub fn diarize(
    model: &Path,
    audio: &mut MeetingAudio,
    progress: &mut dyn FnMut(f32),
) -> AppResult<Vec<SpeakerSpan>> {
    let mut sortformer = Sortformer::with_config(
        model,
        Some(execution_config()?),
        DiarizationConfig::default(),
    )
    .map_err(|error| model_error("load the speaker separation model", error))?;
    sortformer
        .set_profile(StreamingProfile::offline())
        .map_err(|error| model_error("configure speaker separation", error))?;

    let mut raw = Vec::new();
    let mut position = 0;
    while position < audio.len() {
        let end = (position + FEED_SAMPLES).min(audio.len());
        let block = audio.read(position, end)?;
        raw.extend(
            sortformer
                .feed(&block)
                .map_err(|error| model_error("separate speakers", error))?,
        );
        position = end;
        progress(position as f32 / audio.len().max(1) as f32);
    }
    raw.extend(
        sortformer
            .flush()
            .map_err(|error| model_error("separate speakers", error))?,
    );

    let spans = raw
        .into_iter()
        .map(|segment| SpeakerSpan {
            speaker: segment.speaker_id,
            start_ms: samples_to_ms(segment.start as usize),
            end_ms: samples_to_ms(segment.end as usize).min(audio.duration_ms()),
        })
        .filter(|span| span.end_ms > span.start_ms)
        .collect();
    Ok(renumber(join_spans(spans)))
}

/// Merges each speaker's touching spans and returns them sorted by start.
pub fn join_spans(mut spans: Vec<SpeakerSpan>) -> Vec<SpeakerSpan> {
    spans.sort_by_key(|span| (span.speaker, span.start_ms));
    let mut joined: Vec<SpeakerSpan> = Vec::with_capacity(spans.len());
    for span in spans {
        match joined.last_mut() {
            Some(previous)
                if previous.speaker == span.speaker
                    && span.start_ms <= previous.end_ms + JOIN_GAP_MS =>
            {
                previous.end_ms = previous.end_ms.max(span.end_ms);
            }
            _ => joined.push(span),
        }
    }
    joined.sort_by_key(|span| (span.start_ms, span.speaker));
    joined
}

/// Numbers speakers 0, 1, 2… in order of first appearance.
pub fn renumber(mut spans: Vec<SpeakerSpan>) -> Vec<SpeakerSpan> {
    let mut order = Vec::new();
    for span in &spans {
        if !order.contains(&span.speaker) {
            order.push(span.speaker);
        }
    }
    for span in &mut spans {
        span.speaker = order
            .iter()
            .position(|speaker| *speaker == span.speaker)
            .unwrap_or_default();
    }
    spans
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

    #[test]
    fn joins_window_edge_splits_but_not_real_pauses() {
        let joined = join_spans(vec![
            span(3, 0, 27_200),
            span(3, 27_200, 30_000),
            span(3, 31_000, 32_000),
            span(5, 29_000, 29_500),
        ]);
        assert_eq!(
            joined
                .iter()
                .map(|span| (span.speaker, span.start_ms, span.end_ms))
                .collect::<Vec<_>>(),
            vec![(3, 0, 30_000), (5, 29_000, 29_500), (3, 31_000, 32_000)]
        );
    }

    #[test]
    fn renumbers_by_first_appearance() {
        let spans = renumber(vec![span(4, 0, 1), span(1, 2, 3), span(4, 4, 5)]);
        assert_eq!(
            spans.iter().map(|span| span.speaker).collect::<Vec<_>>(),
            vec![0, 1, 0]
        );
    }
}
