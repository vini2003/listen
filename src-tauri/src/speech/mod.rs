//! On-device speech pipeline.
//!
//! Three ONNX models run on the CPU through ONNX Runtime:
//! - Nemotron 3 Diarization separates who speaks when (up to eight voices).
//! - Parakeet TDT 0.6B v3 turns speech into punctuated, word-timed text.
//! - WeSpeaker ResNet34-LM turns a stretch of one voice into a 256-value
//!   voiceprint, used to recognise saved people across recordings.
//!
//! Nothing in this module touches the network, the database or the UI; it
//! reads a 16 kHz mono WAV and returns speaker turns. Each model is loaded for
//! one job and dropped afterwards so an idle app does not hold gigabytes.

mod audio;
mod diarization;
mod embedding;
mod fbank;
mod pipeline;
mod recognition;
mod runtime;
mod voiceprint;

pub use embedding::{centroid, SpeakerEmbedder};
pub use pipeline::{transcribe, ModelPaths, SpeakerSpan, Stage, Voice};
pub use voiceprint::{cosine_similarity, Voiceprint};
