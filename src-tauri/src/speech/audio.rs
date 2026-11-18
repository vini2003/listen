use std::{fs::File, io::BufReader, path::Path};

use crate::error::{AppError, AppResult};

pub const SAMPLE_RATE: usize = 16_000;
pub const SAMPLES_PER_MS: usize = SAMPLE_RATE / 1_000;

/// Random-access reader over a 16 kHz mono 16-bit WAV, so a multi-hour
/// meeting is streamed through the models instead of held in memory.
pub struct MeetingAudio {
    reader: hound::WavReader<BufReader<File>>,
    len: usize,
}

impl MeetingAudio {
    pub fn open(path: &Path) -> AppResult<Self> {
        let reader = hound::WavReader::open(path)
            .map_err(|error| AppError::Audio(format!("Could not open meeting audio: {error}")))?;
        let spec = reader.spec();
        if spec.channels != 1
            || spec.sample_rate as usize != SAMPLE_RATE
            || spec.bits_per_sample != 16
            || spec.sample_format != hound::SampleFormat::Int
        {
            return Err(AppError::Audio(format!(
                "Meeting audio must be 16 kHz mono 16-bit PCM, found {} Hz × {} channel(s) at {} bits",
                spec.sample_rate, spec.channels, spec.bits_per_sample
            )));
        }
        let len = reader.len() as usize;
        Ok(Self { reader, len })
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn duration_ms(&self) -> i64 {
        (self.len / SAMPLES_PER_MS) as i64
    }

    /// Samples in `[start, end)` as integers at the recorded scale.
    pub fn read_pcm(&mut self, start: usize, end: usize) -> AppResult<Vec<i16>> {
        let end = end.min(self.len);
        if start >= end {
            return Ok(Vec::new());
        }
        self.reader
            .seek(start as u32)
            .map_err(|error| AppError::Audio(format!("Could not seek meeting audio: {error}")))?;
        self.reader
            .samples::<i16>()
            .take(end - start)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| AppError::Audio(format!("Could not read meeting audio: {error}")))
    }

    /// Samples in `[start, end)` scaled to `[-1, 1)`, as the speech models expect.
    pub fn read(&mut self, start: usize, end: usize) -> AppResult<Vec<f32>> {
        Ok(self
            .read_pcm(start, end)?
            .into_iter()
            .map(|sample| sample as f32 / 32_768.0)
            .collect())
    }
}

pub fn ms_to_samples(ms: i64) -> usize {
    ms.max(0) as usize * SAMPLES_PER_MS
}

pub fn samples_to_ms(samples: usize) -> i64 {
    (samples / SAMPLES_PER_MS) as i64
}
