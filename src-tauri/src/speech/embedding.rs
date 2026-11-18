use std::path::Path;

use parakeet_rs::ort::{session::Session, value::Tensor};

use super::{
    fbank::{Fbank, MEL_BINS},
    runtime::{execution_config, model_error},
};
use crate::error::AppResult;

/// Clips shorter than this carry too little voice to embed reliably.
pub const MIN_EMBEDDING_SAMPLES: usize = 16_000;
/// Beyond ten seconds a clip adds little to the voiceprint but still costs time.
pub const MAX_EMBEDDING_SAMPLES: usize = 16_000 * 10;

/// WeSpeaker ResNet34-LM speaker embeddings (256 values per clip).
pub struct SpeakerEmbedder {
    session: Session,
    input: String,
    fbank: Fbank,
}

impl SpeakerEmbedder {
    pub fn load(model: &Path) -> AppResult<Self> {
        let session = execution_config()?
            .build_session(model)
            .map_err(|error| model_error("load the voice matching model", error))?;
        let input = session
            .inputs()
            .first()
            .map(|input| input.name().to_string())
            .ok_or_else(|| model_error("load the voice matching model", "it has no inputs"))?;
        Ok(Self {
            session,
            input,
            fbank: Fbank::new(),
        })
    }

    /// L2-normalised embedding of 16 kHz samples in int16 scale, or `None`
    /// when the clip is too short to carry a usable voice.
    pub fn embed(&mut self, samples: &[i16]) -> AppResult<Option<Vec<f32>>> {
        if samples.len() < MIN_EMBEDDING_SAMPLES {
            return Ok(None);
        }
        let samples = &samples[..samples.len().min(MAX_EMBEDDING_SAMPLES)];
        let scaled = samples
            .iter()
            .map(|sample| *sample as f32)
            .collect::<Vec<_>>();
        let (frames, features) = self.fbank.compute(&scaled);
        let tensor = Tensor::from_array(([1usize, frames, MEL_BINS], features))
            .map_err(|error| model_error("prepare a voice sample", error))?;
        let outputs = self
            .session
            .run(parakeet_rs::ort::inputs![self.input.as_str() => tensor])
            .map_err(|error| model_error("measure a voice", error))?;
        let (_, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| model_error("read a voice measurement", error))?;
        Ok(normalised(values.to_vec()))
    }
}

/// Duration-weighted mean of unit embeddings, renormalised.
pub fn centroid<'a>(embeddings: impl IntoIterator<Item = (&'a [f32], f32)>) -> Option<Vec<f32>> {
    let mut sum: Option<Vec<f32>> = None;
    for (embedding, weight) in embeddings {
        let sum = sum.get_or_insert_with(|| vec![0.0; embedding.len()]);
        if sum.len() != embedding.len() {
            return None;
        }
        for (total, value) in sum.iter_mut().zip(embedding) {
            *total += value * weight;
        }
    }
    sum.and_then(normalised)
}

fn normalised(mut values: Vec<f32>) -> Option<Vec<f32>> {
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= f32::EPSILON {
        return None;
    }
    for value in &mut values {
        *value /= norm;
    }
    Some(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centroid_weights_and_normalises() {
        let left = [1.0, 0.0];
        let right = [0.0, 1.0];
        let mean = centroid([(&left[..], 3.0), (&right[..], 1.0)]).expect("centroid");
        let norm = mean.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
        assert!(mean[0] > mean[1] * 2.9);
    }

    #[test]
    fn centroid_rejects_mismatched_lengths() {
        assert!(centroid([(&[1.0, 0.0][..], 1.0), (&[1.0][..], 1.0)]).is_none());
    }
}
