use serde::{Deserialize, Serialize};

/// Identifies the embedding space. Voiceprints from another model (including
/// the hosted pyannote ones older versions used) cannot be compared and
/// are relearned from the person's labelled speech.
pub const VOICEPRINT_MODEL: &str = "wespeaker-voxceleb-resnet34-lm";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Voiceprint {
    pub model: String,
    pub embedding: Vec<f32>,
}

impl Voiceprint {
    pub fn new(embedding: Vec<f32>) -> Self {
        Self {
            model: VOICEPRINT_MODEL.to_string(),
            embedding,
        }
    }

    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// `None` for anything that is not a current local voiceprint.
    pub fn decode(value: &str) -> Option<Self> {
        serde_json::from_str::<Self>(value)
            .ok()
            .filter(|voiceprint| voiceprint.model == VOICEPRINT_MODEL)
            .filter(|voiceprint| !voiceprint.embedding.is_empty())
    }
}

pub fn cosine_similarity(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let dot = left.iter().zip(right).map(|(a, b)| a * b).sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
    if left_norm <= f32::EPSILON || right_norm <= f32::EPSILON {
        return 0.0;
    }
    dot / (left_norm * right_norm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_rejects_foreign_voiceprints() {
        let voiceprint = Voiceprint::new(vec![0.6, 0.8]);
        assert_eq!(Voiceprint::decode(&voiceprint.encode()), Some(voiceprint));
        assert!(Voiceprint::decode("precision-voiceprint-base64").is_none());
        assert!(Voiceprint::decode(r#"{"model":"other","embedding":[1.0]}"#).is_none());
    }

    #[test]
    fn cosine_handles_degenerate_vectors() {
        assert!((cosine_similarity(&[1.0, 0.0], &[2.0, 0.0]) - 1.0).abs() < 1e-6);
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 0.0]), 0.0);
        assert_eq!(cosine_similarity(&[1.0], &[1.0, 0.0]), 0.0);
    }
}
