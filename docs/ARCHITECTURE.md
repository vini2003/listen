# Architecture

## Boundaries

The codebase is separated by responsibility rather than framework convenience:

- `src/domain` contains serializable product models.
- `src/services` is the desktop command boundary plus a browser-only preview adapter.
- `src/store` coordinates product state without owning persistence or audio details.
- `src/components` contains focused user-interface features.
- `src-tauri/src/database.rs` owns migrations and all SQLite operations.
- `src-tauri/src/audio.rs` owns device discovery, capture threads, and rolling audio files.
- `src-tauri/src/speech_audio.rs` owns normalized streaming renders and source-isolated clips.
- `src-tauri/src/pyannote.rs` owns temporary media upload plus Precision-2 jobs.
- `src-tauri/src/transcription.rs` owns transcript and identity orchestration.
- `src-tauri/src/voice_reference.rs` owns clean-sample selection and voiceprint learning.
- `src-tauri/src/transcript_cleanup.rs` owns bounded, schema-validated text refinement.
- `src-tauri/src/ai_chat.rs` owns bounded transcript context, conversation prompting, and GPT-5.6 Luna responses.
- `src-tauri/src/credentials.rs` is the only module allowed to access the platform credential vault.

## Recording lifecycle

1. The UI creates a draft meeting in SQLite.
2. Starting capture creates a meeting-specific directory and a dedicated native audio thread.
3. Every selected source writes independently to bounded PCM WAV segments.
4. Stopping capture drops every native stream and finalizes each WAV header before the meeting becomes ready.
5. Transcription streams a normalized 16 kHz mono render to temporary pyannote media storage and runs Precision-2 with speaker-attributed STT.
6. When voiceprints exist, identification runs in parallel. Candidates are every person with a learned profile — people from the current meeting and project fill the capped voiceprint slots first, then everyone else by recency. Identities are joined to transcript turns by timestamp overlap, never by a job-local `SPEAKER_XX` label.
7. Manual speaker assignment updates every matching turn immediately. A background task selects an isolated, non-overlapping, manually-labeled microphone or speaker passage and learns one voiceprint for future meetings — unless automatic labeling was turned off for that person.
8. The raw segment text is retained in SQLite while bounded Luna requests conservatively correct likely ASR mistakes and punctuation. Invalid or unavailable cleanup results are discarded without failing the recording.

Keeping microphone and speaker audio as separate tracks avoids realtime resampling and clock-drift corruption. It also prevents a voiceprint from being learned from a mixed passage containing both the local and remote speaker.

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
- Normalized uploads are streamed from disk and practical multi-hour meetings remain far below pyannote's 1 GiB media limit.
- SQLite uses WAL mode and a busy timeout.
- Audio callbacks do minimal conversion and sequential writes.
- Every chunk has a valid WAV header after rollover.
- A failed API request leaves original audio untouched and marks the meeting retryable.
- A failed cleanup request leaves the raw diarized transcript available and records a diagnostic without blocking the meeting.
- pyannote and OpenAI credentials never cross the frontend command boundary after storage.

## Platform capture

- Windows: CPAL/WASAPI microphone capture and output-device loopback.
- Linux: CPAL microphone input plus a PipeWire/PulseAudio monitor source when the host exposes one.
- macOS: CPAL/CoreAudio microphone input plus a ScreenCaptureKit system-audio stream. The app exposes one virtual System Audio source rather than individual output devices, excludes its own process audio, and keeps the resulting track separate until normalization.
