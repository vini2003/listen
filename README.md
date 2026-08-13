# Listen

Listen is a minimal, local-first desktop application for recording, organizing, and transcribing long meetings. It uses a Tauri 2 shell, a React and TypeScript interface, and a Rust audio and persistence layer.

## What works

- Projects and uncategorized recordings with drag-and-drop organization
- Disk-backed microphone recording with bounded WAV segments; completed chunks survive an interrupted session
- Simultaneous microphone and WASAPI loopback capture on Windows
- PipeWire/PulseAudio monitor-source capture on Linux when exposed by the host
- SQLite persistence for projects, recordings, speakers, and transcript segments
- Speaker profiles with automatic, source-isolated Precision-2 voiceprints
- Speaker-attributed transcription through pyannoteAI `precision-2` with its default Parakeet STT model
- Conservative transcript cleanup through `gpt-5.6-luna` with strict structured output
- Persistent recording- and project-scoped meeting conversations through `gpt-5.6-luna`
- Persistent known-speaker identification through up to 50 pyannote voiceprints
- pyannote and optional OpenAI credentials stored in the operating system credential vault
- Light, dark, and system themes
- Tauri packaging configuration for Windows, macOS, and Linux

Listen renders a normalized, streaming 16 kHz meeting file after recording stops and sends it to Precision-2 for diarization and transcription. When known voiceprints exist, a separate identification job runs in parallel and is joined to the transcript by time overlap rather than request-local speaker labels. A bounded Luna pass can then correct likely recognition mistakes and punctuation without changing timestamps or speaker identities. macOS system-audio capture still needs its ScreenCaptureKit adapter; microphone recording and the rest of the app are cross-platform today.

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

The database, conversation history, and audio chunks are stored in the operating system's application-data directory. Audio remains local until the user explicitly requests transcription, when a normalized copy is uploaded to pyannoteAI's temporary media storage. Transcript context is sent to OpenAI only when the user asks a meeting or project question, with remote response storage disabled. API keys are stored in Windows Credential Manager, macOS Keychain, or the platform keyring rather than SQLite or frontend storage.

Meeting participants should be informed and consent to recording where required by local law and organizational policy.
