//! Kaldi-compatible log-mel filterbank features, matching what WeSpeaker was
//! trained on (`torchaudio.compliance.kaldi.fbank` with 80 bins, 25 ms Hamming
//! windows every 10 ms, no dither), followed by per-utterance mean removal.

use std::{f32::consts::PI, sync::Arc};

use realfft::{num_complex::Complex32, RealFftPlanner, RealToComplex};

pub const MEL_BINS: usize = 80;
const FRAME_LENGTH: usize = 400;
const FRAME_SHIFT: usize = 160;
const FFT_SIZE: usize = 512;
const PREEMPHASIS: f32 = 0.97;
const LOW_FREQUENCY: f32 = 20.0;
const SAMPLE_RATE: f32 = 16_000.0;

pub struct Fbank {
    window: Vec<f32>,
    /// Sparse triangular filters: (first FFT bin, weights).
    filters: Vec<(usize, Vec<f32>)>,
    fft: Arc<dyn RealToComplex<f32>>,
}

impl Fbank {
    pub fn new() -> Self {
        let window = (0..FRAME_LENGTH)
            .map(|index| 0.54 - 0.46 * (2.0 * PI * index as f32 / (FRAME_LENGTH - 1) as f32).cos())
            .collect();
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        Self {
            window,
            filters: mel_filters(),
            fft,
        }
    }

    /// Features for `samples` at int16 scale, row-major `[frames, MEL_BINS]`.
    pub fn compute(&self, samples: &[f32]) -> (usize, Vec<f32>) {
        if samples.len() < FRAME_LENGTH {
            return (0, Vec::new());
        }
        let frames = 1 + (samples.len() - FRAME_LENGTH) / FRAME_SHIFT;
        let mut features = vec![0.0f32; frames * MEL_BINS];
        let mut buffer = self.fft.make_input_vec();
        let mut spectrum: Vec<Complex32> = self.fft.make_output_vec();
        let mut power = vec![0.0f32; spectrum.len()];

        for frame in 0..frames {
            let input = &samples[frame * FRAME_SHIFT..frame * FRAME_SHIFT + FRAME_LENGTH];
            let mean = input.iter().sum::<f32>() / FRAME_LENGTH as f32;
            // Remove DC, then pre-emphasise with the first sample repeated.
            let mut previous = input[0] - mean;
            for (index, sample) in input.iter().enumerate() {
                let centred = sample - mean;
                buffer[index] = (centred - PREEMPHASIS * previous) * self.window[index];
                previous = centred;
            }
            buffer[FRAME_LENGTH..].fill(0.0);
            // The FFT only fails on mismatched buffer lengths, which are fixed here.
            let _ = self.fft.process(&mut buffer, &mut spectrum);
            for (bin, value) in spectrum.iter().enumerate() {
                power[bin] = value.norm_sqr();
            }
            let row = &mut features[frame * MEL_BINS..(frame + 1) * MEL_BINS];
            for (mel, (first, weights)) in self.filters.iter().enumerate() {
                let energy = weights
                    .iter()
                    .zip(&power[*first..])
                    .map(|(weight, value)| weight * value)
                    .sum::<f32>();
                row[mel] = energy.max(f32::EPSILON).ln();
            }
        }

        for mel in 0..MEL_BINS {
            let mean = (0..frames)
                .map(|frame| features[frame * MEL_BINS + mel])
                .sum::<f32>()
                / frames as f32;
            for frame in 0..frames {
                features[frame * MEL_BINS + mel] -= mean;
            }
        }
        (frames, features)
    }
}

fn mel(frequency: f32) -> f32 {
    1127.0 * (1.0 + frequency / 700.0).ln()
}

fn mel_filters() -> Vec<(usize, Vec<f32>)> {
    let bin_width = SAMPLE_RATE / FFT_SIZE as f32;
    let low = mel(LOW_FREQUENCY);
    let high = mel(SAMPLE_RATE / 2.0);
    let delta = (high - low) / (MEL_BINS + 1) as f32;
    (0..MEL_BINS)
        .map(|bin| {
            let left = low + bin as f32 * delta;
            let centre = left + delta;
            let right = centre + delta;
            // Kaldi weighs FFT bins 0..N/2 and leaves the Nyquist bin at zero.
            let weights = (0..FFT_SIZE / 2)
                .map(|fft_bin| {
                    let value = mel(bin_width * fft_bin as f32);
                    let up = (value - left) / (centre - left);
                    let down = (right - value) / (right - centre);
                    up.min(down).max(0.0)
                })
                .collect::<Vec<_>>();
            let first = weights.iter().position(|weight| *weight > 0.0).unwrap_or(0);
            let last = weights
                .iter()
                .rposition(|weight| *weight > 0.0)
                .unwrap_or(first);
            (first, weights[first..=last].to_vec())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_follow_kaldi_snip_edges() {
        let fbank = Fbank::new();
        assert_eq!(fbank.compute(&[0.0; 399]).0, 0);
        assert_eq!(fbank.compute(&[0.0; 400]).0, 1);
        assert_eq!(fbank.compute(&[0.0; 16_000]).0, 98);
    }

    #[test]
    fn features_are_mean_normalised_per_bin() {
        let fbank = Fbank::new();
        let tone = (0..16_000)
            .map(|index| 8_000.0 * (2.0 * PI * 440.0 * index as f32 / SAMPLE_RATE).sin())
            .collect::<Vec<_>>();
        let (frames, features) = fbank.compute(&tone);
        for mel in 0..MEL_BINS {
            let mean = (0..frames)
                .map(|frame| features[frame * MEL_BINS + mel])
                .sum::<f32>()
                / frames as f32;
            assert!(mean.abs() < 1e-3);
        }
    }

    #[test]
    fn filters_cover_the_speech_band() {
        let filters = mel_filters();
        assert_eq!(filters.len(), MEL_BINS);
        assert!(filters[0].0 >= 1, "the lowest filter starts above 20 Hz");
        let (first, weights) = filters.last().expect("filters");
        assert!(first + weights.len() <= FFT_SIZE / 2);
    }
}
