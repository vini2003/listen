use std::{
    collections::HashMap,
    collections::VecDeque,
    fs::{self, File},
    io::{BufReader, Cursor, Read},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use crate::error::{AppError, AppResult};

pub const SPEECH_SAMPLE_RATE: u32 = 16_000;
const MIX_BUFFER_DURATION_MS: i64 = 30 * 1_000;

pub struct SpeechWavPart {
    pub bytes: Vec<u8>,
    pub duration_ms: i64,
}

pub struct SpeechWavParts {
    paths: VecDeque<PathBuf>,
    current: Option<SourceWav>,
    max_samples: usize,
    finished: bool,
}

pub struct MixedSpeechWavParts {
    sources: Vec<SpeechWavParts>,
}

struct SourceWav {
    samples: hound::WavIntoSamples<BufReader<File>, i16>,
    channels: usize,
    resampler: MonoResampler,
}

struct MonoResampler {
    input_rate: u32,
    phase: u64,
    sample_sum: i64,
    sample_count: u32,
}

impl SpeechWavParts {
    pub fn new(paths: Vec<PathBuf>, max_duration_ms: i64) -> Self {
        let max_samples = (i64::from(SPEECH_SAMPLE_RATE) * max_duration_ms / 1_000)
            .max(1)
            .try_into()
            .unwrap_or(usize::MAX);
        Self {
            paths: paths.into(),
            current: None,
            max_samples,
            finished: false,
        }
    }
}

impl MixedSpeechWavParts {
    pub fn new(tracks: Vec<Vec<PathBuf>>, max_duration_ms: i64) -> Self {
        Self {
            sources: tracks
                .into_iter()
                .map(|paths| SpeechWavParts::new(paths, max_duration_ms))
                .collect(),
        }
    }
}

impl Iterator for MixedSpeechWavParts {
    type Item = AppResult<SpeechWavPart>;

    fn next(&mut self) -> Option<Self::Item> {
        let mut sources = Vec::new();
        for source in &mut self.sources {
            match source.next() {
                Some(Ok(part)) => match decode_wav(&part.bytes) {
                    Ok(samples) => sources.push((samples, part.duration_ms)),
                    Err(error) => return Some(Err(error)),
                },
                Some(Err(error)) => return Some(Err(error)),
                None => {}
            }
        }
        if sources.is_empty() {
            return None;
        }

        let sample_count = sources
            .iter()
            .map(|(samples, _)| samples.len())
            .max()
            .unwrap_or_default();
        let mut mixed = vec![0_i32; sample_count];
        for (samples, _) in &sources {
            for (output, sample) in mixed.iter_mut().zip(samples) {
                *output = output.saturating_add(i32::from(*sample));
            }
        }
        let peak = mixed
            .iter()
            .map(|sample| sample.unsigned_abs())
            .max()
            .unwrap_or_default();
        let scale = if peak > i16::MAX as u32 {
            i16::MAX as f64 / peak as f64
        } else {
            1.0
        };
        let mixed = mixed
            .into_iter()
            .map(|sample| (sample as f64 * scale).round() as i16)
            .collect::<Vec<_>>();

        let duration_ms = sources
            .iter()
            .map(|(_, duration)| *duration)
            .max()
            .unwrap_or_default();
        Some(encode_wav(&mixed).map(|bytes| SpeechWavPart { bytes, duration_ms }))
    }
}

pub fn recording_sessions(directory: &Path) -> AppResult<Vec<Vec<Vec<PathBuf>>>> {
    Ok(recording_session_tracks(directory)?
        .into_iter()
        .map(|(_, tracks)| {
            let mut tracks = tracks.into_iter().collect::<Vec<_>>();
            tracks.sort_by(|(left, _), (right, _)| left.cmp(right));
            tracks
                .into_iter()
                .map(|(_, mut paths)| {
                    paths.sort();
                    paths
                })
                .collect()
        })
        .collect())
}

pub fn recording_duration_ms(directory: &Path) -> AppResult<i64> {
    recording_session_tracks(directory)?
        .into_iter()
        .try_fold(0_i64, |total, (_, tracks)| {
            let session_duration = tracks
                .values()
                .map(|paths| track_duration_ms(paths))
                .collect::<AppResult<Vec<_>>>()?
                .into_iter()
                .max()
                .unwrap_or_default();
            Ok(total.saturating_add(session_duration))
        })
}

fn recording_session_tracks(
    directory: &Path,
) -> AppResult<Vec<(String, HashMap<String, Vec<PathBuf>>)>> {
    let mut sessions: HashMap<String, HashMap<String, Vec<PathBuf>>> = HashMap::new();
    for entry in fs::read_dir(directory)? {
        let path = entry?.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("wav") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        let pieces = stem.split('-').collect::<Vec<_>>();
        let source = pieces.first().copied().unwrap_or("audio").to_string();
        if !matches!(source.as_str(), "microphone" | "system") {
            continue;
        }
        let session = if pieces.len() >= 3 {
            pieces[1].to_string()
        } else {
            "legacy".to_string()
        };
        sessions
            .entry(session)
            .or_default()
            .entry(source)
            .or_default()
            .push(path);
    }

    let mut sessions = sessions.into_iter().collect::<Vec<_>>();
    sessions.sort_by(|(left, _), (right, _)| session_sort_key(left).cmp(&session_sort_key(right)));
    for (_, tracks) in &mut sessions {
        for paths in tracks.values_mut() {
            paths.sort();
        }
    }
    Ok(sessions)
}

pub fn write_mixed_recording(directory: &Path, output_path: &Path) -> AppResult<i64> {
    let sessions = recording_sessions(directory)?;
    let mut writer = hound::WavWriter::create(
        output_path,
        hound::WavSpec {
            channels: 1,
            sample_rate: SPEECH_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|error| AppError::Audio(format!("Could not prepare meeting audio: {error}")))?;

    let mut duration_ms = 0_i64;
    for tracks in sessions {
        for part in MixedSpeechWavParts::new(tracks, MIX_BUFFER_DURATION_MS) {
            let part = part?;
            for sample in decode_wav(&part.bytes)? {
                writer.write_sample(sample).map_err(|error| {
                    AppError::Audio(format!("Could not write meeting audio: {error}"))
                })?;
            }
            duration_ms += part.duration_ms;
        }
    }
    writer
        .finalize()
        .map_err(|error| AppError::Audio(format!("Could not finish meeting audio: {error}")))?;
    Ok(duration_ms)
}

pub fn active_capture_sources(directory: &Path) -> AppResult<Vec<String>> {
    const ANALYSIS_SAMPLES: usize = SPEECH_SAMPLE_RATE as usize;
    const MIN_ACTIVE_RMS: f64 = 120.0;
    const MIN_LOUD_SAMPLES: u64 = SPEECH_SAMPLE_RATE as u64 / 4;
    const LOUD_SAMPLE_LEVEL: i16 = 220;

    let mut source_stats = HashMap::<String, (f64, u64)>::new();
    for (_, tracks) in recording_session_tracks(directory)? {
        for (source_name, paths) in tracks {
            let stats = source_stats.entry(source_name).or_default();
            for path in paths {
                let mut source = SourceWav::open(&path)?;
                loop {
                    let mut samples = Vec::with_capacity(ANALYSIS_SAMPLES);
                    let finished = source.fill(&mut samples, ANALYSIS_SAMPLES)?;
                    if !samples.is_empty() {
                        stats.0 = stats.0.max(rms(&samples));
                        stats.1 += samples
                            .iter()
                            .filter(|sample| sample.unsigned_abs() >= LOUD_SAMPLE_LEVEL as u16)
                            .count() as u64;
                    }
                    if finished {
                        break;
                    }
                }
            }
        }
    }
    let mut active = source_stats
        .into_iter()
        .filter_map(|(source, (maximum_rms, loud_samples))| {
            (maximum_rms >= MIN_ACTIVE_RMS && loud_samples >= MIN_LOUD_SAMPLES).then_some(source)
        })
        .collect::<Vec<_>>();
    active.sort();
    Ok(active)
}

pub fn mixed_recording_clip_data_url(
    directory: &Path,
    start_ms: i64,
    end_ms: i64,
) -> AppResult<String> {
    const MAX_PLAYBACK_MS: i64 = 5 * 60 * 1_000;
    if start_ms < 0 || end_ms <= start_ms || end_ms - start_ms > MAX_PLAYBACK_MS {
        return Err(AppError::Validation(
            "Audio playback must cover between 1 ms and 5 minutes".to_string(),
        ));
    }

    let mut timeline_ms = 0_i64;
    let mut clip = Vec::new();
    for tracks in recording_sessions(directory)? {
        for part in MixedSpeechWavParts::new(tracks, MIX_BUFFER_DURATION_MS) {
            let part = part?;
            let part_end_ms = timeline_ms + part.duration_ms;
            if end_ms > timeline_ms && start_ms < part_end_ms {
                let samples = decode_wav(&part.bytes)?;
                let local_start_ms = (start_ms - timeline_ms).max(0);
                let local_end_ms = (end_ms - timeline_ms).min(part.duration_ms);
                let first = (local_start_ms * i64::from(SPEECH_SAMPLE_RATE) / 1_000) as usize;
                let last = (local_end_ms * i64::from(SPEECH_SAMPLE_RATE) / 1_000) as usize;
                clip.extend_from_slice(&samples[first.min(samples.len())..last.min(samples.len())]);
            }
            timeline_ms = part_end_ms;
            if timeline_ms >= end_ms {
                break;
            }
        }
        if timeline_ms >= end_ms {
            break;
        }
    }
    if clip.is_empty() {
        return Err(AppError::Audio(
            "No saved audio was found for this transcript passage".to_string(),
        ));
    }
    Ok(format!(
        "data:audio/wav;base64,{}",
        BASE64.encode(encode_wav(&clip)?)
    ))
}

pub fn recording_source_clip(
    directory: &Path,
    source: &str,
    start_ms: i64,
    end_ms: i64,
) -> AppResult<Vec<i16>> {
    let mut timeline_ms = 0_i64;
    let mut output = Vec::new();
    for (_, tracks) in recording_session_tracks(directory)? {
        let session_duration_ms = tracks
            .values()
            .map(|paths| track_duration_ms(paths))
            .collect::<AppResult<Vec<_>>>()?
            .into_iter()
            .max()
            .unwrap_or_default();
        let session_end_ms = timeline_ms + session_duration_ms;
        if end_ms > timeline_ms && start_ms < session_end_ms {
            let local_start_ms = (start_ms - timeline_ms).max(0);
            let local_end_ms = (end_ms - timeline_ms).min(session_duration_ms);
            if let Some(paths) = tracks.get(source) {
                output.extend(source_clip(paths, local_start_ms, local_end_ms)?);
            } else {
                let missing_ms = (local_end_ms - local_start_ms).max(0);
                output.resize(
                    output.len() + (missing_ms * i64::from(SPEECH_SAMPLE_RATE) / 1_000) as usize,
                    0,
                );
            }
        }
        timeline_ms = session_end_ms;
        if timeline_ms >= end_ms {
            break;
        }
    }
    Ok(output)
}

pub fn write_normalized_wav(path: &Path, samples: &[i16]) -> AppResult<()> {
    fs::write(path, encode_wav(samples)?)?;
    Ok(())
}

pub fn rms(samples: &[i16]) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let energy = samples
        .iter()
        .map(|sample| {
            let value = f64::from(*sample);
            value * value
        })
        .sum::<f64>()
        / samples.len() as f64;
    energy.sqrt()
}

fn source_clip(paths: &[PathBuf], start_ms: i64, end_ms: i64) -> AppResult<Vec<i16>> {
    let mut timeline_ms = 0_i64;
    let mut output = Vec::new();
    for path in paths {
        let duration_ms = wav_duration_ms(path)?;
        let part_end_ms = timeline_ms + duration_ms;
        if end_ms > timeline_ms && start_ms < part_end_ms {
            let local_start_ms = (start_ms - timeline_ms).max(0);
            let local_end_ms = (end_ms - timeline_ms).min(duration_ms);
            let mut reader = hound::WavReader::open(path).map_err(|error| {
                AppError::Audio(format!("Could not read {}: {error}", path.display()))
            })?;
            let rate = i64::from(reader.spec().sample_rate);
            let first = (local_start_ms * rate / 1_000) as u64;
            let last = (local_end_ms * rate / 1_000) as u64;
            let max_samples = ((local_end_ms - local_start_ms).max(0)
                * i64::from(SPEECH_SAMPLE_RATE)
                / 1_000) as usize;
            output.extend(normalize_reader(&mut reader, first, last, max_samples)?);
        }
        timeline_ms = part_end_ms;
        if timeline_ms >= end_ms {
            break;
        }
    }
    Ok(output)
}

fn track_duration_ms(paths: &[PathBuf]) -> AppResult<i64> {
    paths
        .iter()
        .try_fold(0_i64, |total, path| Ok(total + wav_duration_ms(path)?))
}

fn wav_duration_ms(path: &Path) -> AppResult<i64> {
    let reader = hound::WavReader::open(path)
        .map_err(|error| AppError::Audio(format!("Could not inspect audio: {error}")))?;
    Ok(((reader.duration() as f64 / reader.spec().sample_rate as f64) * 1_000.0).round() as i64)
}

impl Iterator for SpeechWavParts {
    type Item = AppResult<SpeechWavPart>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }

        let mut output = Vec::with_capacity(self.max_samples);
        while output.len() < self.max_samples {
            if self.current.is_none() {
                let Some(path) = self.paths.pop_front() else {
                    self.finished = true;
                    break;
                };
                match SourceWav::open(&path) {
                    Ok(source) => self.current = Some(source),
                    Err(error) => return Some(Err(error)),
                }
            }

            let source_finished = match self
                .current
                .as_mut()
                .expect("audio source is present")
                .fill(&mut output, self.max_samples)
            {
                Ok(finished) => finished,
                Err(error) => return Some(Err(error)),
            };
            if source_finished {
                self.current = None;
            }
        }

        if output.is_empty() {
            return None;
        }

        let duration_ms = samples_to_ms(output.len());
        Some(encode_wav(&output).map(|bytes| SpeechWavPart { bytes, duration_ms }))
    }
}

impl SourceWav {
    fn open(path: &Path) -> AppResult<Self> {
        let reader = hound::WavReader::open(path).map_err(|error| {
            AppError::Audio(format!("Could not read {}: {error}", path.display()))
        })?;
        let spec = reader.spec();
        validate_pcm16(spec)?;
        Ok(Self {
            samples: reader.into_samples::<i16>(),
            channels: usize::from(spec.channels),
            resampler: MonoResampler::new(spec.sample_rate),
        })
    }

    fn fill(&mut self, output: &mut Vec<i16>, limit: usize) -> AppResult<bool> {
        while output.len() < limit {
            let Some(first) = self.samples.next() else {
                return Ok(true);
            };
            let mut sum = i64::from(first.map_err(decode_error)?);
            for _ in 1..self.channels {
                let sample = self.samples.next().ok_or_else(|| {
                    AppError::Audio("The recording ended inside an audio frame".to_string())
                })?;
                sum += i64::from(sample.map_err(decode_error)?);
            }
            let mono = (sum / self.channels as i64) as i16;
            self.resampler.push(mono, output);
        }
        Ok(false)
    }
}

impl MonoResampler {
    fn new(input_rate: u32) -> Self {
        Self {
            input_rate: input_rate.max(1),
            phase: 0,
            sample_sum: 0,
            sample_count: 0,
        }
    }

    fn push(&mut self, sample: i16, output: &mut Vec<i16>) {
        self.sample_sum += i64::from(sample);
        self.sample_count += 1;
        self.phase += u64::from(SPEECH_SAMPLE_RATE);
        while self.phase >= u64::from(self.input_rate) {
            let filtered = if self.sample_count == 0 {
                sample
            } else {
                (self.sample_sum / i64::from(self.sample_count)) as i16
            };
            output.push(filtered);
            self.phase -= u64::from(self.input_rate);
            self.sample_sum = 0;
            self.sample_count = 0;
        }
    }
}

fn normalize_reader<R: Read>(
    reader: &mut hound::WavReader<R>,
    start_frame: u64,
    end_frame: u64,
    max_output_samples: usize,
) -> AppResult<Vec<i16>> {
    let spec = reader.spec();
    validate_pcm16(spec)?;
    let channels = usize::from(spec.channels);
    let mut samples = reader.samples::<i16>();
    let mut resampler = MonoResampler::new(spec.sample_rate);
    let mut output = Vec::with_capacity(max_output_samples);
    let mut frame = 0_u64;

    while frame < end_frame && output.len() < max_output_samples {
        let Some(first) = samples.next() else {
            break;
        };
        let mut sum = i64::from(first.map_err(decode_error)?);
        for _ in 1..channels {
            let sample = samples.next().ok_or_else(|| {
                AppError::Audio("The voice reference ended inside an audio frame".to_string())
            })?;
            sum += i64::from(sample.map_err(decode_error)?);
        }
        if frame >= start_frame {
            resampler.push((sum / channels as i64) as i16, &mut output);
        }
        frame += 1;
    }
    Ok(output)
}

fn encode_wav(samples: &[i16]) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(samples) + 44);
    {
        let cursor = Cursor::new(&mut bytes);
        let mut writer = hound::WavWriter::new(
            cursor,
            hound::WavSpec {
                channels: 1,
                sample_rate: SPEECH_SAMPLE_RATE,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .map_err(|error| AppError::Audio(format!("Could not prepare speech audio: {error}")))?;
        for sample in samples {
            writer.write_sample(*sample).map_err(|error| {
                AppError::Audio(format!("Could not encode speech audio: {error}"))
            })?;
        }
        writer
            .finalize()
            .map_err(|error| AppError::Audio(format!("Could not finish speech audio: {error}")))?;
    }
    Ok(bytes)
}

fn decode_wav(bytes: &[u8]) -> AppResult<Vec<i16>> {
    let reader = hound::WavReader::new(Cursor::new(bytes)).map_err(|error| {
        AppError::Audio(format!("Could not read normalized speech audio: {error}"))
    })?;
    reader
        .into_samples::<i16>()
        .map(|sample| sample.map_err(decode_error))
        .collect()
}

fn session_sort_key(value: &str) -> (u8, u128, &str) {
    match value.parse::<u128>() {
        Ok(timestamp) => (1, timestamp, value),
        Err(_) => (0, 0, value),
    }
}

fn validate_pcm16(spec: hound::WavSpec) -> AppResult<()> {
    if spec.channels == 0 || spec.sample_rate == 0 {
        return Err(AppError::Audio(
            "The recording has an invalid audio format".to_string(),
        ));
    }
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(AppError::Audio(
            "Listen expected 16-bit PCM audio in the saved recording".to_string(),
        ));
    }
    Ok(())
}

fn decode_error(error: hound::Error) -> AppError {
    AppError::Audio(format!("Could not decode saved audio: {error}"))
}

fn samples_to_ms(samples: usize) -> i64 {
    (samples as i64 * 1_000) / i64::from(SPEECH_SAMPLE_RATE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo_wav(path: &Path, duration_seconds: u32) {
        let mut writer = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels: 2,
                sample_rate: 48_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .expect("wav writer");
        for frame in 0..48_000 * duration_seconds {
            writer.write_sample((frame % 2_000) as i16).unwrap();
            writer.write_sample((frame % 1_000) as i16).unwrap();
        }
        writer.finalize().expect("finalize wav");
    }

    fn mono_wav(path: &Path, samples: &[i16]) {
        let mut writer = hound::WavWriter::create(
            path,
            hound::WavSpec {
                channels: 1,
                sample_rate: SPEECH_SAMPLE_RATE,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .expect("wav writer");
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().expect("finalize wav");
    }

    #[test]
    fn splits_and_compacts_long_recordings() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("long.wav");
        stereo_wav(&path, 12);

        let parts = SpeechWavParts::new(vec![path], 5_000)
            .collect::<AppResult<Vec<_>>>()
            .unwrap();

        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].duration_ms, 5_000);
        assert_eq!(parts[1].duration_ms, 5_000);
        assert_eq!(parts[2].duration_ms, 2_000);
        assert!(parts.iter().all(|part| part.bytes.len() < 200_000));
    }

    #[test]
    fn mixes_parallel_capture_tracks_into_one_timeline() {
        let directory = tempfile::tempdir().unwrap();
        let microphone = directory.path().join("microphone-123-0000.wav");
        let system = directory.path().join("system-123-0000.wav");
        stereo_wav(&microphone, 3);
        stereo_wav(&system, 3);

        let sessions = recording_sessions(directory.path()).unwrap();
        let parts = sessions
            .into_iter()
            .flat_map(|tracks| MixedSpeechWavParts::new(tracks, 5_000))
            .collect::<AppResult<Vec<_>>>()
            .unwrap();

        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].duration_ms, 3_000);
    }

    #[test]
    fn measures_sessions_without_double_counting_parallel_tracks() {
        let directory = tempfile::tempdir().unwrap();
        stereo_wav(&directory.path().join("microphone-123-0000.wav"), 2);
        stereo_wav(&directory.path().join("system-123-0000.wav"), 3);
        stereo_wav(&directory.path().join("microphone-456-0000.wav"), 4);

        assert_eq!(recording_duration_ms(directory.path()).unwrap(), 7_000);
    }

    #[test]
    fn ignores_generated_audio_when_scanning_recording_tracks() {
        let directory = tempfile::tempdir().unwrap();
        let microphone = directory.path().join("microphone-123-0000.wav");
        let generated = directory.path().join("precision-upload-abcd.wav");
        mono_wav(&microphone, &[1_000; 16_000]);
        mono_wav(&generated, &[2_000; 16_000]);

        let sessions = recording_sessions(directory.path()).unwrap();

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].len(), 1);
        assert_eq!(sessions[0][0], vec![microphone]);
    }

    #[test]
    fn detects_independently_active_capture_sources() {
        let directory = tempfile::tempdir().unwrap();
        let microphone = directory.path().join("microphone-123-0000.wav");
        let system = directory.path().join("system-123-0000.wav");
        mono_wav(&microphone, &[800; 16_000]);
        mono_wav(&system, &[1_200; 16_000]);

        assert_eq!(
            active_capture_sources(directory.path()).unwrap(),
            vec!["microphone".to_string(), "system".to_string()]
        );
    }

    #[test]
    fn ignores_silent_capture_sources() {
        let directory = tempfile::tempdir().unwrap();
        let microphone = directory.path().join("microphone-123-0000.wav");
        let system = directory.path().join("system-123-0000.wav");
        mono_wav(&microphone, &[800; 16_000]);
        mono_wav(&system, &[0; 16_000]);

        assert_eq!(
            active_capture_sources(directory.path()).unwrap(),
            vec!["microphone".to_string()]
        );
    }

    #[test]
    fn extracts_timestamped_playback_from_the_mixed_timeline() {
        let directory = tempfile::tempdir().unwrap();
        let microphone = directory.path().join("microphone-123-0000.wav");
        mono_wav(&microphone, &[600; 32_000]);

        let audio = mixed_recording_clip_data_url(directory.path(), 500, 1_500).unwrap();

        assert!(audio.starts_with("data:audio/wav;base64,UklGR"));
        assert!(audio.len() > 40_000);
    }

    #[test]
    fn preserves_waveform_shape_when_parallel_tracks_need_headroom() {
        let directory = tempfile::tempdir().unwrap();
        let microphone = directory.path().join("microphone.wav");
        let system = directory.path().join("system.wav");
        mono_wav(&microphone, &[30_000, 15_000]);
        mono_wav(&system, &[30_000, 15_000]);

        let part = MixedSpeechWavParts::new(vec![vec![microphone], vec![system]], 1_000)
            .next()
            .unwrap()
            .unwrap();
        let mixed = decode_wav(&part.bytes).unwrap();

        assert_eq!(mixed[0], i16::MAX);
        assert!((16_383..=16_384).contains(&mixed[1]));
    }

    #[test]
    fn averages_samples_while_downsampling_instead_of_decimating() {
        let mut resampler = MonoResampler::new(48_000);
        let mut output = Vec::new();
        for sample in [30_000, -30_000, 30_000] {
            resampler.push(sample, &mut output);
        }

        assert_eq!(output, vec![10_000]);
    }
}
