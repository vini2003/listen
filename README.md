# Listen

Listen is a minimal, local-first desktop application for recording, organizing, and transcribing long meetings. It uses a Tauri 2 shell, a React and TypeScript interface, and a Rust audio and persistence layer.

## What works

- Projects and uncategorized recordings with drag-and-drop organization
- Disk-backed microphone recording with bounded WAV segments; completed chunks survive an interrupted session
- Simultaneous microphone and WASAPI loopback capture on Windows
- PipeWire/PulseAudio monitor-source capture on Linux when exposed by the host
- Native microphone and ScreenCaptureKit system-audio capture on macOS 13 or newer
- SQLite persistence for projects, recordings, speakers, and transcript segments
- On-device, speaker-attributed transcription: NVIDIA Nemotron 3 Diarization separates speakers and Parakeet TDT 0.6B v3 transcribes, both on the CPU through ONNX Runtime
- Speaker profiles with automatic, source-isolated WeSpeaker voiceprints, matched locally against every saved person
- Whole-meeting playback with a transport bar, plus play-from-timestamp and per-passage clips in the transcript
- Conservative transcript cleanup through `gpt-5.6-luna` with strict structured output
- Persistent recording- and project-scoped meeting conversations through `gpt-5.6-luna`
- A one-time, resumable, checksum-verified download of the speech models (1.1 GB), managed in Settings
- Optional OpenAI credentials stored in the operating system credential vault
- Light, dark, and system themes
- Tauri packaging configuration for Windows, macOS, and Linux

Listen renders a normalized 16 kHz meeting file after recording stops and runs it through three local models: Nemotron 3 Diarization finds who speaks when, Parakeet TDT transcribes 30-second windows cut at pauses, and each word is attributed to the speaker talking over it. WeSpeaker then measures every detected voice, folds labels that turn out to be the same person, and names voices that clearly match a saved person. On a Ryzen 9 9950X3D an hour of audio takes about two and a half minutes using four threads. A bounded Luna pass can then correct likely recognition mistakes and punctuation without changing timestamps or speaker identities. On macOS, system audio uses ScreenCaptureKit and requires permission under Privacy & Security > Screen & System Audio Recording.

## Development

Prerequisites:

- Node.js 22 or newer
- Rust 1.85 or newer
- Tauri platform prerequisites for the target operating system

```sh
npm install
npm run tauri dev
```

For a fast interface-only preview:

```sh
npm run dev
```

The browser preview uses a local in-browser adapter with sample data. The packaged application always uses the Rust and SQLite services.

## Distribution

```sh
npm run build:desktop  # native installers and updater artifacts
npm run build:portable # raw executable for local development
```

Cross-platform releases are built and published through GitHub Actions. See [the release guide](docs/RELEASING.md) for updater signing, required repository secrets, versioning, and the release workflow.

### Linux rendering

Listen defaults to WebKit's shared-memory frame transport on Linux. This keeps
the accelerated renderer available while avoiding hardware-buffer allocation
failures seen with some graphics drivers. No wrapper script is required.

Explicit environment settings take precedence. To restore the older compatibility
mode if rendering fails:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 /path/to/listen
```

To test hardware-buffer transport instead:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=0 WEBKIT_DMABUF_RENDERER_FORCE_SHM=0 /path/to/listen
```

These options also work with the AppImage. Windows and macOS rendering defaults
are unaffected. See [the graphics investigation](docs/graphics-investigation.md)
for measurements and limitations.

## Verification

```sh
npm test
npm run build
cd src-tauri
cargo fmt --all -- --check
cargo check
cargo test
```

## Data and privacy

The database, conversation history, audio chunks, and speech models are stored in the operating system's application-data directory. Audio never leaves the computer: transcription, speaker separation, and voice matching all run locally. The only network traffic for speech is the model download from Hugging Face, pinned to exact commits and verified against SHA-256 checksums. When an OpenAI key is configured, transcript text is sent to OpenAI for optional cleanup and when the user asks a meeting or project question, with remote response storage disabled. API keys are stored in Windows Credential Manager, macOS Keychain, or the platform keyring rather than SQLite or frontend storage.

Labeling a speaker as a person automatically learns an encrypted, locally stored voice profile so that person is named automatically in future recordings. Automatic labeling can be turned off per person in People, and every stored profile can be erased at once in Settings.

### Model licences

- Nemotron 3 Diarization: NVIDIA OpenMDW 1.1 (ONNX export by the parakeet-rs project)
- Parakeet TDT 0.6B v3: CC BY 4.0, NVIDIA (int8 ONNX export by istupakov)
- WeSpeaker ResNet34-LM: CC BY 4.0, WeNet community, trained on VoxCeleb

Meeting participants should be informed and consent to recording where required by local law and organizational policy.
