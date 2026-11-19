# Architecture

## Boundaries

The codebase is separated by responsibility rather than framework convenience:

- `src/domain` contains serializable product models.
- `src/services` is the desktop command boundary plus a browser-only preview adapter.
- `src/store` coordinates product state without owning persistence or audio details.
- `src/components` contains focused user-interface features.
- `src-tauri/src/database.rs` owns migrations and all SQLite operations.
- `src-tauri/src/audio.rs` owns device discovery, capture threads, and rolling audio files.
- `src-tauri/src/media_decode.rs` streams an audio track from a media file into 16 kHz mono PCM. `media_import.rs` stages the output and publishes it as a meeting session.
- `src-tauri/src/speech_audio.rs` owns normalized streaming renders and source-isolated clips.
- `src-tauri/src/speech/` owns the on-device models: diarization, recognition, voice embeddings, and turning their output into speaker turns. It never touches the database, network, or UI.
- `src-tauri/src/speech_models.rs` owns the pinned model catalogue and the resumable, checksum-verified download.
- `src-tauri/src/transcription.rs` owns transcript and identity orchestration, progress reporting, and matching voices to saved people.
- `src-tauri/src/voice_reference.rs` owns clean-sample selection and voiceprint learning.
- `src-tauri/src/transcript_cleanup.rs` owns bounded, schema-validated text refinement.
- `src-tauri/src/ai_chat.rs` owns bounded transcript context, conversation prompting, and GPT-5.6 Luna responses.
- `src-tauri/src/credentials.rs` is the only module allowed to access the platform credential vault.

## Recording lifecycle

1. The UI creates a draft meeting in SQLite.
2. Starting capture creates a meeting-specific directory and a dedicated native audio thread.
3. Every selected source writes independently to bounded PCM WAV segments.
4. Stopping capture drops every native stream and finalizes each WAV header before the meeting becomes ready.
5. Transcription renders a normalized 16 kHz mono mix (cached as `mixed.wav`) and runs one job at a time on a blocking thread, streaming progress events to the UI:
   - Nemotron 3 Diarization streams the mix in 10-second reads with NVIDIA's offline profile and returns speaker spans (at most eight voices).
   - Parakeet TDT transcribes windows of up to 30 seconds, cut at the quietest moment where nobody is speaking, with word timestamps.
   - Each word goes to the speaker talking over most of it; words are grouped into turns at speaker changes, long pauses, or after a sentence once a turn passes 30 seconds.
   - WeSpeaker embeds up to two minutes of each voice's solo speech. Labels whose voices are near-identical and never talk over each other are folded together, which repairs the split Nemotron makes when a recording is resumed later.
6. Each voice is compared with every saved voiceprint by cosine similarity. A person is named only above 0.6 similarity and 0.1 clear of the runner-up, one person per voice. On four labelled meetings the same person scored 0.83–0.93 across recordings and different people at most 0.39.
7. Manual speaker assignment updates every matching turn immediately. A background task selects isolated, non-overlapping, manually-labeled microphone or speaker passages, embeds each, and stores their weighted average as an encrypted voiceprint — unless automatic labeling was turned off for that person. Voiceprints made by another model (the hosted pyannote service older versions used) are retired at startup and relearned this way.
8. The raw segment text is retained in SQLite while bounded Luna requests conservatively correct likely ASR mistakes and punctuation. Invalid or unavailable cleanup results are discarded without failing the recording.

Keeping microphone and speaker audio as separate tracks avoids realtime resampling and clock-drift corruption. It also prevents a voiceprint from being learned from a mixed passage containing both the local and remote speaker.

Imported audio uses its own system-audio session. When appending to a transcribed meeting, SQLite records where the new audio begins. Transcription processes that part of the recording and offsets the new passages onto the meeting timeline. Existing passages and their speaker assignments keep their IDs.

## Meeting conversations

- Recording and project conversations are separate scopes with independently ordered SQLite histories.
- Editing or resending a user message replaces the later branch before a new answer is generated.
- Transcript material is assembled locally with participant names, recording titles, and timestamps, then bounded before being sent with recent chat history.
- GPT-5.6 Luna runs through the Responses API with remote response storage disabled.
- Failures preserve the user message, surface as toasts, and write a sanitized diagnostic ID without logging transcript contents or credentials.

## Long-running reliability

- No meeting-length audio buffer exists in memory.
- The workspace snapshot contains projects, recordings, people, devices, and settings; transcript segments are loaded only for the selected recording.
- UI mutations apply their returned records locally instead of repeatedly reloading the whole SQLite workspace and rediscovering audio devices.
- Static PNG/JPEG profile photos are stored and rendered as bounded thumbnails. Existing full-resolution photos are retained in a private migration column until the user replaces or removes them; animated or vector formats remain unchanged.
- Segment playback explicitly releases its generated audio source when playback changes, the turn is deleted, or the meeting view closes.
- The speech models read the meeting file in bounded windows, so memory stays near 2 GB regardless of meeting length. Models are loaded per job and released afterwards.
- SQLite uses WAL mode and a busy timeout.
- Audio callbacks do minimal conversion and sequential writes.
- Every chunk has a valid WAV header after rollover.
- A failed transcription leaves original audio untouched and marks the meeting retryable.
- Model downloads resume from partial files, retry transient failures with backoff, and only install files whose SHA-256 matches the pinned catalogue.
- A failed cleanup request leaves the raw diarized transcript available and records a diagnostic without blocking the meeting.
- OpenAI credentials never cross the frontend command boundary after storage.

## Platform capture

- Windows: CPAL/WASAPI microphone capture and output-device loopback.
- Linux: CPAL microphone input plus a PipeWire/PulseAudio monitor source when the host exposes one.
- macOS: CPAL/CoreAudio microphone input plus a ScreenCaptureKit system-audio stream. The app exposes one virtual System Audio source rather than individual output devices, excludes its own process audio, and keeps the resulting track separate until normalization.
