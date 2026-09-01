use std::{
    fs::{self, File},
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        mpsc as std_mpsc, Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::process::{Child, Command, Stdio};

#[cfg(target_os = "macos")]
use crate::macos_system_audio::{
    MacSystemAudioCapture, SYSTEM_AUDIO_CHANNELS, SYSTEM_AUDIO_SAMPLE_RATE,
};
use crate::{
    domain::{AudioDevice, RecordingLevels, RecordingRequest},
    error::{AppError, AppResult},
};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;

const CHUNK_SECONDS: u64 = 90;
const MAX_PCM_BYTES_PER_CHUNK: u64 = 20 * 1024 * 1024;
const METER_FLOOR_DB: f32 = -62.0;
const METER_CEILING_DB: f32 = -12.0;
const METER_RESPONSE: f32 = 0.7;
pub struct RecordingManager {
    active: Mutex<Option<RecordingThread>>,
}

impl Default for RecordingManager {
    fn default() -> Self {
        Self {
            active: Mutex::new(None),
        }
    }
}

impl RecordingManager {
    pub fn start(&self, request: &RecordingRequest, directory: PathBuf) -> AppResult<()> {
        let mut active = self.active.lock();
        if active.is_some() {
            return Err(AppError::Audio("A recording is already active".to_string()));
        }
        if !request.capture_microphone && !request.capture_system {
            return Err(AppError::Validation(
                "Choose at least one available audio source".to_string(),
            ));
        }

        fs::create_dir_all(&directory)?;
        let thread_request = request.clone();
        let paused = Arc::new(AtomicBool::new(false));
        let thread_paused = Arc::clone(&paused);
        let levels = SharedRecordingLevels::default();
        let thread_levels = levels.clone();
        let clock = Arc::new(Mutex::new(RecordingClock::new()));
        let (stop_sender, stop_receiver) = std_mpsc::channel::<()>();
        let (startup_sender, startup_receiver) = std_mpsc::sync_channel::<Result<(), String>>(1);
        let handle = thread::Builder::new()
            .name("listen-audio-capture".to_string())
            .spawn(move || {
                let recording = match ActiveRecording::start(
                    &thread_request,
                    directory,
                    thread_paused,
                    thread_levels,
                ) {
                    Ok(recording) => {
                        let _ = startup_sender.send(Ok(()));
                        recording
                    }
                    Err(error) => {
                        let message = error.to_string();
                        let _ = startup_sender.send(Err(message.clone()));
                        return Err(AppError::Audio(message));
                    }
                };
                let _ = stop_receiver.recv();
                recording.stop()
            })
            .map_err(|error| AppError::Audio(format!("Could not start audio thread: {error}")))?;

        match startup_receiver.recv() {
            Ok(Ok(())) => {
                *active = Some(RecordingThread {
                    meeting_id: request.meeting_id.clone(),
                    stop_sender,
                    paused,
                    levels,
                    clock,
                    handle,
                });
                Ok(())
            }
            Ok(Err(error)) => {
                let _ = handle.join();
                Err(AppError::Audio(error))
            }
            Err(error) => {
                let _ = handle.join();
                Err(AppError::Audio(format!(
                    "Audio thread stopped during startup: {error}"
                )))
            }
        }
    }

    pub fn set_paused(&self, meeting_id: &str, paused: bool) -> AppResult<()> {
        let active = self.active.lock();
        let recording = active
            .as_ref()
            .ok_or_else(|| AppError::Audio("No recording is active".to_string()))?;
        if recording.meeting_id != meeting_id {
            return Err(AppError::Audio(
                "A different meeting is currently recording".to_string(),
            ));
        }
        recording.paused.store(paused, Ordering::Release);
        recording.clock.lock().set_paused(paused);
        if paused {
            recording.levels.clear();
        }
        Ok(())
    }

    pub fn levels(&self, meeting_id: &str) -> AppResult<RecordingLevels> {
        let active = self.active.lock();
        let recording = active
            .as_ref()
            .ok_or_else(|| AppError::Audio("No recording is active".to_string()))?;
        if recording.meeting_id != meeting_id {
            return Err(AppError::Audio(
                "A different meeting is currently recording".to_string(),
            ));
        }
        let elapsed_ms = recording.clock.lock().elapsed_ms();
        Ok(recording.levels.snapshot(elapsed_ms))
    }

    pub fn stop(&self, meeting_id: &str) -> AppResult<i64> {
        let mut active = self.active.lock();
        let recording = active
            .take()
            .ok_or_else(|| AppError::Audio("No recording is active".to_string()))?;
        if recording.meeting_id != meeting_id {
            *active = Some(recording);
            return Err(AppError::Audio(
                "A different meeting is currently recording".to_string(),
            ));
        }
        recording
            .stop_sender
            .send(())
            .map_err(|error| AppError::Audio(format!("Could not stop audio thread: {error}")))?;
        recording
            .handle
            .join()
            .map_err(|_| AppError::Audio("The audio thread crashed".to_string()))?
    }
}

struct RecordingThread {
    meeting_id: String,
    stop_sender: std_mpsc::Sender<()>,
    paused: Arc<AtomicBool>,
    levels: SharedRecordingLevels,
    clock: Arc<Mutex<RecordingClock>>,
    handle: thread::JoinHandle<AppResult<i64>>,
}

struct RecordingClock {
    started_at: Instant,
    paused_at: Option<Instant>,
    paused_duration: Duration,
}

impl RecordingClock {
    fn new() -> Self {
        Self {
            started_at: Instant::now(),
            paused_at: None,
            paused_duration: Duration::ZERO,
        }
    }

    fn set_paused(&mut self, paused: bool) {
        match (paused, self.paused_at) {
            (true, None) => self.paused_at = Some(Instant::now()),
            (false, Some(paused_at)) => {
                self.paused_duration += paused_at.elapsed();
                self.paused_at = None;
            }
            _ => {}
        }
    }

    fn elapsed_ms(&self) -> i64 {
        let end = self.paused_at.unwrap_or_else(Instant::now);
        end.duration_since(self.started_at)
            .saturating_sub(self.paused_duration)
            .as_millis()
            .min(i64::MAX as u128) as i64
    }
}

#[derive(Clone, Default)]
struct SharedRecordingLevels {
    microphone: Arc<AtomicU32>,
    system: Arc<AtomicU32>,
}

impl SharedRecordingLevels {
    fn snapshot(&self, elapsed_ms: i64) -> RecordingLevels {
        RecordingLevels {
            microphone: f32::from_bits(self.microphone.load(Ordering::Relaxed)),
            system: f32::from_bits(self.system.load(Ordering::Relaxed)),
            elapsed_ms,
        }
    }

    fn clear(&self) {
        self.microphone.store(0.0_f32.to_bits(), Ordering::Relaxed);
        self.system.store(0.0_f32.to_bits(), Ordering::Relaxed);
    }
}

struct ActiveRecording {
    streams: Vec<CaptureStream>,
    writers: Vec<Arc<Mutex<SegmentWriter>>>,
}

enum CaptureStream {
    Cpal(cpal::Stream),
    #[cfg(target_os = "macos")]
    ScreenCaptureKit(MacSystemAudioCapture),
    #[cfg(target_os = "linux")]
    Pulse(PulseCapture),
}

impl CaptureStream {
    fn stop(self) -> AppResult<()> {
        match self {
            Self::Cpal(stream) => {
                drop(stream);
                Ok(())
            }
            #[cfg(target_os = "macos")]
            Self::ScreenCaptureKit(stream) => stream.stop().map_err(AppError::Audio),
            #[cfg(target_os = "linux")]
            Self::Pulse(stream) => stream.stop(),
        }
    }
}

impl ActiveRecording {
    fn start(
        request: &RecordingRequest,
        directory: PathBuf,
        paused: Arc<AtomicBool>,
        levels: SharedRecordingLevels,
    ) -> AppResult<Self> {
        let host = cpal::default_host();
        let mut streams = Vec::new();
        let mut writers = Vec::new();
        #[cfg(target_os = "windows")]
        let session_started_at = Instant::now();

        let session_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();

        if request.capture_microphone {
            let prefix = format!("microphone-{session_id}");
            #[cfg(target_os = "linux")]
            let pulse_source = request
                .microphone_device_id
                .as_deref()
                .and_then(pulse_source_name);
            #[cfg(target_os = "linux")]
            let (stream, writer) = if let Some(source) = pulse_source {
                start_pulse_source_stream(
                    source,
                    &directory,
                    &prefix,
                    Arc::clone(&paused),
                    Arc::clone(&levels.microphone),
                )?
            } else {
                start_cpal_microphone_stream(
                    &host,
                    request.microphone_device_id.as_deref(),
                    &directory,
                    &prefix,
                    Arc::clone(&paused),
                    Arc::clone(&levels.microphone),
                )?
            };
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            let (stream, writer) = start_cpal_microphone_stream(
                &host,
                request.microphone_device_id.as_deref(),
                &directory,
                &prefix,
                Arc::clone(&paused),
                Arc::clone(&levels.microphone),
            )?;
            streams.push(stream);
            writers.push(writer);
        }

        if request.capture_system {
            let prefix = format!("system-{session_id}");
            #[cfg(target_os = "linux")]
            let pulse_source = request
                .system_device_id
                .as_deref()
                .and_then(pulse_source_name);
            #[cfg(target_os = "linux")]
            let (stream, writer) = if let Some(source) = pulse_source {
                start_pulse_source_stream(
                    source,
                    &directory,
                    &prefix,
                    Arc::clone(&paused),
                    Arc::clone(&levels.system),
                )?
            } else {
                start_cpal_system_stream(
                    &host,
                    request.system_device_id.as_deref(),
                    &directory,
                    &prefix,
                    Arc::clone(&paused),
                    Arc::clone(&levels.system),
                )?
            };
            #[cfg(target_os = "windows")]
            let (stream, writer) = start_cpal_system_stream(
                &host,
                request.system_device_id.as_deref(),
                &directory,
                &prefix,
                Arc::clone(&paused),
                Arc::clone(&levels.system),
            )?;
            #[cfg(target_os = "macos")]
            let (stream, writer) = start_macos_system_stream(
                request.system_device_id.as_deref(),
                &directory,
                &prefix,
                session_started_at,
                Arc::clone(&paused),
                Arc::clone(&levels.system),
            )?;
            streams.push(stream);
            writers.push(writer);
        }

        Ok(Self { streams, writers })
    }

    fn stop(self) -> AppResult<i64> {
        for stream in self.streams {
            stream.stop()?;
        }
        let mut duration_ms = 0;
        for writer in self.writers {
            duration_ms = duration_ms.max(writer.lock().finish()?);
        }
        Ok(duration_ms)
    }
}

#[cfg(target_os = "macos")]
fn start_macos_system_stream(
    device_id: Option<&str>,
    directory: &Path,
    prefix: &str,
    session_started_at: Instant,
    paused: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> AppResult<(CaptureStream, Arc<Mutex<SegmentWriter>>)> {
    if device_id.is_some_and(|id| id != "macos-system-audio") {
        return Err(AppError::Audio(
            "The selected macOS system audio source is no longer available".to_string(),
        ));
    }
    let writer = Arc::new(Mutex::new(SegmentWriter::new(
        directory.to_path_buf(),
        prefix.to_string(),
        SYSTEM_AUDIO_SAMPLE_RATE as u32,
        SYSTEM_AUDIO_CHANNELS as u16,
    )?));
    let callback_writer = Arc::clone(&writer);
    let aligned = Arc::new(AtomicBool::new(false));
    let stream = MacSystemAudioCapture::start(move |samples| {
        if !aligned.swap(true, Ordering::AcqRel) {
            let leading_frames = (session_started_at.elapsed().as_secs_f64()
                * SYSTEM_AUDIO_SAMPLE_RATE as f64)
                .round() as u64;
            callback_writer.lock().write_silence_frames(leading_frames);
        }
        write_f32(samples, &callback_writer, &paused, &level);
    })
    .map_err(AppError::Audio)?;
    Ok((CaptureStream::ScreenCaptureKit(stream), writer))
}

fn start_cpal_microphone_stream(
    host: &cpal::Host,
    device_id: Option<&str>,
    directory: &Path,
    prefix: &str,
    paused: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> AppResult<(CaptureStream, Arc<Mutex<SegmentWriter>>)> {
    let device = find_input_device(host, device_id)?;
    let supported = device
        .default_input_config()
        .map_err(|error| AppError::Audio(format!("Could not read microphone format: {error}")))?;
    start_source_stream(device, supported, directory, prefix, paused, level)
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn start_cpal_system_stream(
    host: &cpal::Host,
    device_id: Option<&str>,
    directory: &Path,
    prefix: &str,
    paused: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> AppResult<(CaptureStream, Arc<Mutex<SegmentWriter>>)> {
    let device = find_system_device(host, device_id)?;
    let supported = system_input_config(&device)?;
    start_source_stream(device, supported, directory, prefix, paused, level)
}

fn start_source_stream(
    device: cpal::Device,
    supported: cpal::SupportedStreamConfig,
    directory: &Path,
    prefix: &str,
    paused: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> AppResult<(CaptureStream, Arc<Mutex<SegmentWriter>>)> {
    let config: cpal::StreamConfig = supported.clone().into();
    let writer = Arc::new(Mutex::new(SegmentWriter::new(
        directory.to_path_buf(),
        prefix.to_string(),
        config.sample_rate.0,
        config.channels,
    )?));
    let callback_writer = Arc::clone(&writer);
    let callback_paused = paused;
    let error_callback = |error| eprintln!("Listen audio stream error: {error}");

    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config,
            move |data: &[f32], _| write_f32(data, &callback_writer, &callback_paused, &level),
            error_callback,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config,
            move |data: &[i16], _| write_i16(data, &callback_writer, &callback_paused, &level),
            error_callback,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            &config,
            move |data: &[u16], _| write_u16(data, &callback_writer, &callback_paused, &level),
            error_callback,
            None,
        ),
        format => {
            return Err(AppError::Audio(format!(
                "Unsupported microphone sample format: {format:?}"
            )))
        }
    }
    .map_err(|error| AppError::Audio(format!("Could not open microphone: {error}")))?;

    stream
        .play()
        .map_err(|error| AppError::Audio(format!("Could not start microphone: {error}")))?;

    Ok((CaptureStream::Cpal(stream), writer))
}

#[cfg(target_os = "linux")]
struct PulseCapture {
    child: Arc<Mutex<Child>>,
    reader: thread::JoinHandle<()>,
}

#[cfg(target_os = "linux")]
impl PulseCapture {
    fn stop(self) -> AppResult<()> {
        {
            let mut child = self.child.lock();
            let _ = child.kill();
            child.wait().map_err(|error| {
                AppError::Audio(format!("Could not stop PulseAudio capture: {error}"))
            })?;
        }
        self.reader
            .join()
            .map_err(|_| AppError::Audio("The PulseAudio reader thread crashed".to_string()))?;
        Ok(())
    }
}

#[cfg(target_os = "linux")]
fn start_pulse_source_stream(
    source: &str,
    directory: &Path,
    prefix: &str,
    paused: Arc<AtomicBool>,
    level: Arc<AtomicU32>,
) -> AppResult<(CaptureStream, Arc<Mutex<SegmentWriter>>)> {
    const SAMPLE_RATE: u32 = 48_000;
    const CHANNELS: u16 = 2;

    let writer = Arc::new(Mutex::new(SegmentWriter::new(
        directory.to_path_buf(),
        prefix.to_string(),
        SAMPLE_RATE,
        CHANNELS,
    )?));
    let mut child = Command::new("parec")
        .args([
            "--device",
            source,
            "--format=s16le",
            "--rate=48000",
            "--channels=2",
            "--latency-msec=50",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| {
            AppError::Audio(format!(
                "Could not start PulseAudio capture. Install pulseaudio-utils and try again: {error}"
            ))
        })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Audio("PulseAudio did not provide an audio stream".to_string()))?;
    let child = Arc::new(Mutex::new(child));
    let callback_writer = Arc::clone(&writer);
    let reader = thread::Builder::new()
        .name(format!("listen-pulse-{prefix}"))
        .spawn(move || {
            let mut bytes = [0_u8; 8_192];
            loop {
                let read = match stdout.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                let samples = bytes[..read - read % 2]
                    .chunks_exact(2)
                    .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect::<Vec<_>>();
                write_i16(&samples, &callback_writer, &paused, &level);
            }
        })
        .map_err(|error| AppError::Audio(format!("Could not start PulseAudio reader: {error}")))?;

    Ok((CaptureStream::Pulse(PulseCapture { child, reader }), writer))
}

struct SegmentWriter {
    directory: PathBuf,
    prefix: String,
    sample_rate: u32,
    channels: u16,
    part: u32,
    samples_in_part: u64,
    samples_total: u64,
    max_samples_per_part: u64,
    writer: Option<hound::WavWriter<BufWriter<File>>>,
    failed: Option<String>,
}

impl SegmentWriter {
    fn new(directory: PathBuf, prefix: String, sample_rate: u32, channels: u16) -> AppResult<Self> {
        let writer = create_writer(&directory, &prefix, 0, sample_rate, channels)?;
        Ok(Self {
            directory,
            prefix,
            sample_rate,
            channels,
            part: 0,
            samples_in_part: 0,
            samples_total: 0,
            max_samples_per_part: (sample_rate as u64 * channels as u64 * CHUNK_SECONDS)
                .min(MAX_PCM_BYTES_PER_CHUNK / std::mem::size_of::<i16>() as u64),
            writer: Some(writer),
            failed: None,
        })
    }

    fn write(&mut self, sample: i16) {
        if self.failed.is_some() || self.writer.is_none() {
            return;
        }
        if self.samples_in_part >= self.max_samples_per_part {
            self.roll();
        }
        let Some(writer) = self.writer.as_mut() else {
            return;
        };
        if let Err(error) = writer.write_sample(sample) {
            self.failed = Some(error.to_string());
            return;
        }
        self.samples_in_part += 1;
        self.samples_total += 1;
    }

    fn write_samples(&mut self, samples: &[i16]) {
        for sample in samples {
            self.write(*sample);
        }
    }

    #[cfg(target_os = "windows")]
    fn write_silence_frames(&mut self, frames: u64) {
        let samples = frames.saturating_mul(self.channels as u64);
        for _ in 0..samples {
            self.write(0);
        }
    }

    fn roll(&mut self) {
        if let Some(writer) = self.writer.take() {
            if let Err(error) = writer.finalize() {
                self.failed = Some(error.to_string());
                return;
            }
        }
        self.part += 1;
        self.samples_in_part = 0;
        match create_writer(
            &self.directory,
            &self.prefix,
            self.part,
            self.sample_rate,
            self.channels,
        ) {
            Ok(writer) => self.writer = Some(writer),
            Err(error) => self.failed = Some(error.to_string()),
        }
    }

    fn finish(&mut self) -> AppResult<i64> {
        if let Some(writer) = self.writer.take() {
            writer.finalize().map_err(|error| {
                AppError::Audio(format!("Could not finalize recording: {error}"))
            })?;
        }
        if let Some(error) = self.failed.take() {
            return Err(AppError::Audio(format!("Recording write failed: {error}")));
        }
        let frames = self.samples_total / self.channels as u64;
        Ok(((frames as f64 / self.sample_rate as f64) * 1000.0).round() as i64)
    }
}

fn create_writer(
    directory: &Path,
    prefix: &str,
    part: u32,
    sample_rate: u32,
    channels: u16,
) -> AppResult<hound::WavWriter<BufWriter<File>>> {
    let path = directory.join(format!("{prefix}-{part:04}.wav"));
    hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(|error| AppError::Audio(format!("Could not create audio segment: {error}")))
}

fn write_f32(
    data: &[f32],
    writer: &Arc<Mutex<SegmentWriter>>,
    paused: &AtomicBool,
    level: &AtomicU32,
) {
    if paused.load(Ordering::Acquire) {
        level.store(0.0_f32.to_bits(), Ordering::Relaxed);
        return;
    }
    store_level(data.iter().copied(), level);
    let mut writer = writer.lock();
    for sample in data {
        writer.write((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
    }
}

fn write_i16(
    data: &[i16],
    writer: &Arc<Mutex<SegmentWriter>>,
    paused: &AtomicBool,
    level: &AtomicU32,
) {
    if paused.load(Ordering::Acquire) {
        level.store(0.0_f32.to_bits(), Ordering::Relaxed);
        return;
    }
    store_level(
        data.iter().map(|sample| *sample as f32 / i16::MAX as f32),
        level,
    );
    write_samples(data, writer);
}

fn write_u16(
    data: &[u16],
    writer: &Arc<Mutex<SegmentWriter>>,
    paused: &AtomicBool,
    level: &AtomicU32,
) {
    if paused.load(Ordering::Acquire) {
        level.store(0.0_f32.to_bits(), Ordering::Relaxed);
        return;
    }
    store_level(
        data.iter()
            .map(|sample| (*sample as f32 - 32_768.0) / 32_768.0),
        level,
    );
    let mut writer = writer.lock();
    for sample in data {
        writer.write((*sample as i32 - 32_768) as i16);
    }
}

fn store_level(samples: impl Iterator<Item = f32>, target: &AtomicU32) {
    let mut sum = 0.0_f64;
    let mut count = 0_u64;
    for sample in samples {
        let normalized = sample.clamp(-1.0, 1.0) as f64;
        sum += normalized * normalized;
        count += 1;
    }
    let rms = if count == 0 {
        0.0
    } else {
        (sum / count as f64).sqrt() as f32
    };
    let visual_level = visual_level_from_rms(rms);
    target.store(visual_level.to_bits(), Ordering::Relaxed);
}

fn visual_level_from_rms(rms: f32) -> f32 {
    if rms <= 0.0 {
        return 0.0;
    }

    let decibels = 20.0 * rms.log10();
    let normalized =
        ((decibels - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)).clamp(0.0, 1.0);
    normalized.powf(METER_RESPONSE)
}

fn write_samples(samples: &[i16], writer: &Arc<Mutex<SegmentWriter>>) {
    writer.lock().write_samples(samples);
}

fn find_input_device(host: &cpal::Host, device_id: Option<&str>) -> AppResult<cpal::Device> {
    if let Some(id) = device_id {
        for device in host
            .input_devices()
            .map_err(|error| AppError::Audio(format!("Could not list microphones: {error}")))?
        {
            let name = device
                .name()
                .unwrap_or_else(|_| "Unknown microphone".to_string());
            if microphone_id(&name) == id {
                return Ok(device);
            }
        }
    }
    host.default_input_device()
        .ok_or_else(|| AppError::Audio("No microphone is available".to_string()))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn find_system_device(host: &cpal::Host, device_id: Option<&str>) -> AppResult<cpal::Device> {
    #[cfg(target_os = "windows")]
    let devices = host.output_devices();
    #[cfg(not(target_os = "windows"))]
    let devices = host.input_devices();

    for device in devices
        .map_err(|error| AppError::Audio(format!("Could not list speaker sources: {error}")))?
    {
        let name = device
            .name()
            .unwrap_or_else(|_| "Unknown speaker".to_string());
        if device_id.map(|id| system_id(&name) == id).unwrap_or(false) {
            return Ok(device);
        }
    }
    Err(AppError::Audio(
        "The selected speaker is no longer available".to_string(),
    ))
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn system_input_config(device: &cpal::Device) -> AppResult<cpal::SupportedStreamConfig> {
    #[cfg(target_os = "windows")]
    let result = device.default_output_config();
    #[cfg(not(target_os = "windows"))]
    let result = device.default_input_config();

    result.map_err(|error| AppError::Audio(format!("Could not read speaker format: {error}")))
}

pub fn list_devices() -> AppResult<Vec<AudioDevice>> {
    #[cfg(target_os = "linux")]
    if let Ok(devices) = list_pulse_devices() {
        if !devices.is_empty() {
            return Ok(devices);
        }
    }

    let host = cpal::default_host();
    let default_input_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    #[cfg(target_os = "windows")]
    let default_output_name = host
        .default_output_device()
        .and_then(|device| device.name().ok());
    let mut devices = Vec::new();

    for device in host
        .input_devices()
        .map_err(|error| AppError::Audio(format!("Could not list microphones: {error}")))?
    {
        let name = device
            .name()
            .unwrap_or_else(|_| "Unknown microphone".to_string());
        #[cfg(target_os = "linux")]
        if is_low_value_alsa_alias(&name) {
            continue;
        }
        let is_monitor = cfg!(target_os = "linux") && name.to_lowercase().contains("monitor");
        let display_name = friendly_alsa_name(&name);
        devices.push(if is_monitor {
            AudioDevice {
                id: system_id(&name),
                is_default: false,
                name: display_name,
                subtitle: Some("Speaker · ALSA".to_string()),
                kind: "system".to_string(),
                is_available: true,
            }
        } else {
            AudioDevice {
                id: microphone_id(&name),
                is_default: default_input_name.as_deref() == Some(&name),
                name: display_name,
                subtitle: Some(microphone_subtitle().to_string()),
                kind: "microphone".to_string(),
                is_available: true,
            }
        });
    }

    #[cfg(target_os = "windows")]
    for device in host
        .output_devices()
        .map_err(|error| AppError::Audio(format!("Could not list audio outputs: {error}")))?
    {
        let name = device
            .name()
            .unwrap_or_else(|_| "Unknown output".to_string());
        devices.push(AudioDevice {
            id: system_id(&name),
            is_default: default_output_name.as_deref() == Some(&name),
            name,
            subtitle: Some("Speaker".to_string()),
            kind: "system".to_string(),
            is_available: cfg!(target_os = "windows"),
        });
    }

    #[cfg(target_os = "macos")]
    devices.push(AudioDevice {
        id: "macos-system-audio".to_string(),
        name: "System Audio".to_string(),
        subtitle: Some("Calls and application audio".to_string()),
        kind: "system".to_string(),
        is_default: true,
        is_available: true,
    });

    Ok(devices)
}

fn microphone_subtitle() -> &'static str {
    #[cfg(target_os = "linux")]
    return "Microphone · ALSA";
    #[cfg(target_os = "macos")]
    return "Microphone · CoreAudio";
    #[cfg(target_os = "windows")]
    return "Microphone · WASAPI";
}

#[cfg(target_os = "linux")]
fn list_pulse_devices() -> AppResult<Vec<AudioDevice>> {
    let output = Command::new("pactl")
        .args(["--format=json", "list", "sources"])
        .output()
        .map_err(|error| AppError::Audio(format!("Could not query PulseAudio sources: {error}")))?;
    if !output.status.success() {
        return Err(AppError::Audio(
            "PulseAudio source discovery was unavailable".to_string(),
        ));
    }

    let sources: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| AppError::Audio(format!("Could not read PulseAudio sources: {error}")))?;
    let default_source = pactl_name(["get-default-source"]);
    let default_sink = pactl_name(["get-default-sink"]);
    let mut devices = Vec::new();

    for source in sources.as_array().into_iter().flatten() {
        let Some(name) = source.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let description = source
            .get("description")
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                source
                    .get("properties")
                    .and_then(|properties| properties.get("device.description"))
                    .and_then(serde_json::Value::as_str)
            })
            .unwrap_or(name);
        let monitor = name.ends_with(".monitor")
            || source
                .get("monitor_of_sink")
                .is_some_and(|value| !value.is_null() && value.as_i64() != Some(u32::MAX as i64));
        let is_default = if monitor {
            default_sink
                .as_deref()
                .is_some_and(|sink| name == format!("{sink}.monitor"))
        } else {
            default_source.as_deref() == Some(name)
        };
        let display_name = if monitor {
            description
                .strip_prefix("Monitor of ")
                .unwrap_or(description)
                .to_string()
        } else {
            description.to_string()
        };
        devices.push(AudioDevice {
            id: format!("pulse-source:{name}"),
            name: display_name,
            subtitle: Some(
                if monitor {
                    if is_default {
                        "Default speaker · PulseAudio"
                    } else {
                        "Speaker · PulseAudio"
                    }
                } else if is_default {
                    "Default microphone · PulseAudio"
                } else {
                    "Microphone · PulseAudio"
                }
                .to_string(),
            ),
            kind: if monitor { "system" } else { "microphone" }.to_string(),
            is_default,
            is_available: true,
        });
    }

    Ok(devices)
}

#[cfg(target_os = "linux")]
fn pactl_name<const N: usize>(args: [&str; N]) -> Option<String> {
    let output = Command::new("pactl").args(args).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|name| !name.is_empty())
}

#[cfg(target_os = "linux")]
fn pulse_source_name(id: &str) -> Option<&str> {
    id.strip_prefix("pulse-source:")
}

fn friendly_alsa_name(name: &str) -> String {
    match name.to_ascii_lowercase().as_str() {
        "default" => "System default".to_string(),
        "pulse" => "PulseAudio default".to_string(),
        _ => name.to_string(),
    }
}

#[cfg(target_os = "linux")]
fn is_low_value_alsa_alias(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    [
        "sysdefault:",
        "front:",
        "surround21:",
        "surround40:",
        "surround41:",
        "surround50:",
        "surround51:",
        "surround71:",
        "iec958:",
        "hdmi:",
        "dmix:",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn microphone_id(name: &str) -> String {
    format!("microphone:{name}")
}

fn system_id(name: &str) -> String {
    format!("system:{name}")
}

#[cfg(test)]
mod tests {
    use std::{
        sync::Arc,
        time::{Duration, Instant},
    };

    use parking_lot::Mutex;

    use super::{visual_level_from_rms, RecordingClock, SegmentWriter};

    #[test]
    fn meter_makes_conversational_audio_visible() {
        let quiet = visual_level_from_rms(0.003);
        let conversational = visual_level_from_rms(0.01);
        let loud = visual_level_from_rms(0.3);

        assert!(quiet > 0.3);
        assert!(conversational > 0.5);
        assert!(loud > conversational);
        assert_eq!(loud, 1.0);
    }

    #[test]
    fn meter_suppresses_silence_and_clamps_extremes() {
        assert_eq!(visual_level_from_rms(0.0), 0.0);
        assert_eq!(visual_level_from_rms(0.0001), 0.0);
        assert_eq!(visual_level_from_rms(1.0), 1.0);
    }

    #[test]
    fn recording_clock_starts_each_capture_session_at_zero() {
        let clock = RecordingClock::new();

        assert!(clock.elapsed_ms() < 100);
    }

    #[test]
    fn recording_clock_excludes_paused_time() {
        let now = Instant::now();
        let clock = RecordingClock {
            started_at: now - Duration::from_secs(8),
            paused_at: Some(now - Duration::from_secs(3)),
            paused_duration: Duration::from_secs(2),
        };

        assert!((2_900..=3_100).contains(&clock.elapsed_ms()));
    }

    #[test]
    fn finalizes_a_writer_while_a_callback_reference_is_still_alive() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let writer = Arc::new(Mutex::new(
            SegmentWriter::new(
                directory.path().to_path_buf(),
                "system-test".to_string(),
                1_000,
                1,
            )
            .expect("create writer"),
        ));
        let callback_writer = Arc::clone(&writer);
        writer.lock().write_samples(&[100, -100]);

        assert_eq!(writer.lock().finish().expect("finalize writer"), 2);
        callback_writer.lock().write_samples(&[200, -200]);
        assert_eq!(writer.lock().finish().expect("writer stays finalized"), 2);

        let path = directory.path().join("system-test-0000.wav");
        let samples = hound::WavReader::open(path)
            .expect("open finalized recording")
            .into_samples::<i16>()
            .collect::<Result<Vec<_>, _>>()
            .expect("read finalized recording");
        assert_eq!(samples, [100, -100]);
    }
}
