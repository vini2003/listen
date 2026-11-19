use std::{fs::File, io::ErrorKind, path::Path};

use symphonia::core::{
    codecs::{
        audio::{well_known::CODEC_ID_AAC, AudioDecoder, AudioDecoderOptions},
        registry::CodecRegistry,
    },
    common::Limit,
    errors::Error as MediaError,
    formats::{
        probe::Hint,
        well_known::{FORMAT_ID_ISOMP4, FORMAT_ID_MKV},
        FormatReader, Track, TrackType,
    },
    io::MediaSourceStream,
    meta::MetadataOptions,
};

use crate::{
    error::{AppError, AppResult},
    speech_audio::{MonoResampler, SPEECH_SAMPLE_RATE},
};

/// Decode the default playable audio track into the caller's private staging file.
pub(crate) fn decode_to_wav(
    input: &Path,
    output: &Path,
    mut progress: impl FnMut(f32),
) -> AppResult<i64> {
    let source = File::open(input)?;
    if !source.metadata()?.is_file() {
        return Err(AppError::Audio("Choose a media file to import.".into()));
    }
    let mut hint = Hint::new();
    if let Some(extension) = input.extension().and_then(|ext| ext.to_str()) {
        hint.with_extension(extension);
    }
    // Album art and metadata are not part of the imported recording.
    let metadata = MetadataOptions::default()
        .limit_visual_bytes(Limit::Maximum(0))
        .limit_tag_bytes(Limit::Maximum(0));
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            MediaSourceStream::new(Box::new(source), Default::default()),
            Default::default(),
            metadata,
        )
        .map_err(|_| {
            AppError::Audio(
                "Couldn’t read this media format. Try an MP4 with AAC audio, MP3, or WAV.".into(),
            )
        })?;
    let (track, mut decoder) = choose_audio_track(format.as_ref())?;
    let track_id = track.id;
    let open_ended_mkv = format.format_info().format == FORMAT_ID_MKV
        && format.media_info().duration.is_none()
        && track.duration.is_none();
    let aac_packet_rate = track
        .time_base
        .filter(|clock| {
            format.format_info().format == FORMAT_ID_ISOMP4
                && decoder.codec_params().codec == CODEC_ID_AAC
                && clock.numer.get() == 1
        })
        .map(|clock| clock.denom.get());
    let expected_seconds = track
        .duration
        .zip(track.time_base)
        .and_then(|(ticks, base)| base.calc_duration(ticks))
        .map(|time| time.as_secs_f64())
        .filter(|seconds| *seconds > 0.0);
    let mut writer = hound::WavWriter::create(
        output,
        hound::WavSpec {
            channels: 1,
            sample_rate: SPEECH_SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )
    .map_err(write_error)?;
    let mut input_rate = 0;
    let mut resampler = MonoResampler::new(SPEECH_SAMPLE_RATE);
    let mut channels_data = Vec::<i16>::new();
    let mut mono = Vec::new();
    let mut frames_written = 0_u64;
    let mut last_percent = 0;
    if expected_seconds.is_some() {
        progress(0.0);
    }

    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            // A live WebM may leave its segment and final cluster open. In
            // this case Symphonia reports physical EOF after the last packet.
            Err(MediaError::IoError(error))
                if open_ended_mkv
                    && frames_written > 0
                    && error.kind() == ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(error) => return Err(decode_error(error)),
        };
        if packet.track_id != track_id {
            continue;
        }
        let audio = decoder.decode(&packet).map_err(decode_error)?;
        let channels = audio.spec().channels().count();
        let rate = audio.spec().rate();
        if rate == 0 || channels == 0 {
            return Err(AppError::Audio(
                "The audio track has no sample rate or channels.".into(),
            ));
        }
        if rate != input_rate {
            resampler = MonoResampler::new(rate);
            input_rate = rate;
        }
        channels_data.resize(audio.samples_interleaved(), 0);
        audio.copy_to_slice_interleaved(&mut channels_data);
        // AAC decodes whole frames even when the MP4 sample table marks a
        // shorter packet. Only interpret ticks as frames when the rates match.
        if aac_packet_rate == Some(rate) && packet.dur.get() > 0 {
            let frames = usize::try_from(packet.dur.get()).unwrap_or(usize::MAX);
            channels_data.truncate(frames.saturating_mul(channels));
        }
        // Bound resampled buffers even for unusually low-rate source audio.
        let block_size = channels.saturating_mul(rate as usize);
        for input in channels_data.chunks(block_size) {
            mono.clear();
            for frame in input.chunks_exact(channels) {
                let sum: i64 = frame.iter().map(|&sample| i64::from(sample)).sum();
                resampler.push((sum / channels as i64) as i16, &mut mono);
            }
            frames_written += mono.len() as u64;
            // RIFF stores its chunk size in 32 bits, including the format header.
            if frames_written > (u64::from(u32::MAX) - 36) / 2 {
                return Err(AppError::Audio(
                    "This recording is too long for a single WAV file.".into(),
                ));
            }
            let mut block = writer.get_i16_writer(mono.len() as u32);
            for &sample in &mono {
                block.write_sample(sample);
            }
            block.flush().map_err(write_error)?;
        }
        if let Some(seconds) = expected_seconds {
            let fraction = frames_written as f64 / (seconds * f64::from(SPEECH_SAMPLE_RATE));
            let percent = (100.0 * fraction).min(99.0) as u32;
            if percent > last_percent {
                progress(percent as f32 / 100.0);
                last_percent = percent;
            }
        }
    }
    if frames_written == 0 {
        return Err(AppError::Audio("The audio track is empty.".into()));
    }
    if decoder.finalize().verify_ok == Some(false) {
        return Err(AppError::Audio(
            "The recording’s audio checksum is invalid.".into(),
        ));
    }
    writer.finalize().map_err(write_error)?;
    progress(1.0);
    Ok(
        ((frames_written * 1_000 + u64::from(SPEECH_SAMPLE_RATE) / 2)
            / u64::from(SPEECH_SAMPLE_RATE))
        .max(1) as i64,
    )
}

fn choose_audio_track(format: &dyn FormatReader) -> AppResult<(&Track, Box<dyn AudioDecoder>)> {
    let mut codecs = CodecRegistry::new();
    symphonia::default::register_enabled_codecs(&mut codecs);
    codecs.register_audio_decoder::<symphonia_opus::OpusDecoder>();
    let preferred = format.default_track(TrackType::Audio);
    let remaining = format
        .tracks()
        .iter()
        .filter(|track| Some(track.id) != preferred.map(|t| t.id));
    let mut has_audio = false;
    let options = AudioDecoderOptions::default().verify(true);
    for track in preferred.into_iter().chain(remaining) {
        if let Some(params) = track.codec_params.as_ref().and_then(|p| p.audio()) {
            has_audio = true;
            if let Ok(decoder) = codecs.make_audio_decoder(params, &options) {
                return Ok((track, decoder));
            }
        }
    }
    Err(AppError::Audio(if has_audio {
        "Listen can’t decode the audio codec in this file. Export the audio as AAC, MP3, or WAV."
            .into()
    } else {
        "No audio track was found in this file.".into()
    }))
}

fn decode_error(error: symphonia::core::errors::Error) -> AppError {
    AppError::Audio(format!("Couldn’t decode this recording: {error}."))
}

fn write_error(error: hound::Error) -> AppError {
    AppError::Audio(format!("Couldn’t save the imported audio: {error}."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{path::PathBuf, process::Command};

    // Half a second of 440 Hz stereo AAC with a video stream first.
    fn video() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tone-video.mp4")
    }

    fn check_tone(source: &Path, output: &Path) {
        let mut reported = Vec::new();
        let duration = decode_to_wav(source, output, |fraction| reported.push(fraction)).unwrap();
        assert!((470..600).contains(&duration), "{source:?}: {duration} ms");
        assert_eq!(reported.last(), Some(&1.0));
        if reported.len() > 1 {
            assert_eq!(reported.first(), Some(&0.0));
        }
        assert!(reported.windows(2).all(|pair| pair[0] < pair[1]));

        let mut decoded = hound::WavReader::open(output).unwrap();
        assert_eq!(decoded.spec().channels, 1);
        assert_eq!(decoded.spec().sample_rate, SPEECH_SAMPLE_RATE);
        assert_eq!(decoded.spec().bits_per_sample, 16);
        let samples: Vec<i16> = decoded.samples().collect::<Result<_, _>>().unwrap();
        let middle = &samples[2_400..5_600];
        assert!(middle.iter().any(|&s| s > 700), "{source:?} is silent");
        let cycles = middle
            .windows(2)
            .filter(|frame| frame[0] <= 0 && frame[1] > 0)
            .count();
        assert!(
            (85..=91).contains(&cycles),
            "{source:?}: {cycles} cycles in 200 ms"
        );
    }

    #[test]
    fn imports_the_audio_from_a_video_first_mp4() {
        let sandbox = tempfile::tempdir().unwrap();
        let wav = sandbox.path().join("audio.wav");
        check_tone(&video(), &wav);
        // At 48 kHz this track has 24,000 samples plus 1,024 encoder
        // priming samples. Its last AAC packet contains only 448 valid samples.
        let frames = hound::WavReader::open(wav).unwrap().duration();
        assert!((8_000..=(24_000 + 1_024) / 3).contains(&frames), "{frames}");
    }

    #[test]
    #[ignore = "uses FFmpeg to generate a WebM with no duration"]
    fn leaves_progress_indeterminate_for_unknown_duration() {
        let sandbox = tempfile::tempdir().unwrap();
        let source = sandbox.path().join("live.webm");
        assert!(Command::new("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-i"])
            .arg(video())
            .args(["-vn", "-c:a", "libopus", "-live", "1"])
            .arg(&source)
            .status()
            .unwrap()
            .success());
        let mut reported = Vec::new();
        decode_to_wav(&source, &sandbox.path().join("audio.wav"), |p| {
            reported.push(p)
        })
        .unwrap();
        assert_eq!(reported, [1.0]);
    }

    #[test]
    #[ignore = "uses FFmpeg to generate additional media fixtures"]
    fn imports_common_codecs_and_rejects_silent_video() {
        let sandbox = tempfile::tempdir().unwrap();
        let output = sandbox.path().join("import.wav");
        for (name, codec, video_codec) in [
            ("recording.mov", "aac", Some("copy")),
            ("recording.m4a", "alac", None),
            ("voice-memo.m4a", "aac", None),
            ("recording.mkv", "aac", Some("copy")),
            ("recording.webm", "libopus", Some("libvpx")),
            ("recording.opus", "libopus", None),
            ("recording.ogg", "libvorbis", None),
            ("recording.mp3", "libmp3lame", None),
            ("recording.aac", "aac", None),
            ("recording.wav", "pcm_f32le", None),
            ("recording.aiff", "pcm_s24be", None),
            ("recording.flac", "flac", None),
            ("recording.caf", "pcm_s16le", None),
        ] {
            let encoded = sandbox.path().join(name);
            let mut ffmpeg = Command::new("ffmpeg");
            ffmpeg
                .args(["-nostdin", "-loglevel", "error", "-i"])
                .arg(video());
            if let Some(video_codec) = video_codec {
                ffmpeg.args(["-c:v", video_codec]);
            } else {
                ffmpeg.arg("-vn");
            }
            assert!(ffmpeg
                .args(["-c:a", codec])
                .arg(&encoded)
                .status()
                .unwrap()
                .success());
            check_tone(&encoded, &output);
        }

        let truncated = sandbox.path().join("recording.webm");
        let file = File::options().write(true).open(&truncated).unwrap();
        file.set_len(file.metadata().unwrap().len() / 2).unwrap();
        drop(file);
        assert!(decode_to_wav(&truncated, &output, |_| {}).is_err());

        let silent = sandbox.path().join("video-only.mp4");
        assert!(Command::new("ffmpeg")
            .args(["-nostdin", "-loglevel", "error", "-i"])
            .arg(video())
            .args(["-an", "-c:v", "copy"])
            .arg(&silent)
            .status()
            .unwrap()
            .success());
        let error = decode_to_wav(&silent, &output, |_| {}).unwrap_err();
        assert!(error.to_string().contains("No audio track"));
    }
}
