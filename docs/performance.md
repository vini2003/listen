# Performance work — 2026-09-14

## Implemented

- Replaced every whole-workspace React subscription with shallow selectors for the consumed fields.
- Memoized the meeting shell, recording dock, chat panel, and transcript rows. Stable event callbacks retain current committed state without invalidating every row during playback.
- Separated waveform rendering from the recording controls. It sleeps after interpolation, stops when hidden, redraws once when paused, wakes for new samples/visibility/resize, and cancels pending work on unmount.
- Paused recordings take one final meter sample instead of polling continuously. The elapsed label updates at second precision.
- Removed background blur and transparency from the two large overlapping dock/chat surfaces.
- Moved workspace loading, assistant context/segment loading, clip preparation, recording start/stop/pause/meter commands, and diagnostics opening off Tauri's window event loop. Recording meter and pause commands can otherwise block on the same lock held during start/stop.
- Reused the Linux PCM conversion buffer, preserved samples split between pipe reads, and retried interrupted reads.
- Added a Linux process-tree CPU/RSS sampler and regression tests for render isolation, fresh event callbacks, waveform scheduling, and PCM read boundaries.

## Verification and evidence

- Original HEAD, isolated source copy: a playback transition in a synthetic 1,000-row transcript renders all 1,000 rows.
- Modified source, identical test: only the old and new active rows render (2). Further progress inside the same row and unrelated chat state changes render zero rows.
- These are React render counts, not an FPS or total CPU speedup. Parent reconciliation still traverses the transcript.
- Frontend: 72 tests pass; TypeScript and Vite production build pass.
- Rust: 52 tests pass, including all PCM read split sizes for a signed sample fixture.
- Native Linux release executable builds successfully with `npm run build:portable`.
- Isolated native launch on this NVIDIA/X11 machine with `WEBKIT_DISABLE_DMABUF_RENDERER=0` reports `Failed to create GBM buffer ... Invalid argument`. The existing compatibility default is retained. Both temporary test instances were closed; the user's original AppImage was not restarted.
- A five-second sample of the existing AppImage while no interaction was being performed recorded 0.0% CPU and approximately 580.5 MiB summed RSS. This is not a before/after comparison; summed RSS counts shared mappings multiple times. The earlier `ps` CPU numbers were lifetime averages.
- Native screenshot capture did not produce usable visual evidence. No claim of native visual QA, scroll FPS improvement, or full recording validation is made.

## Reproduce

```sh
npm test
npm run build:portable
cargo test --manifest-path src-tauri/Cargo.toml --lib
python3 scripts/profile-linux.py <listen-pid> --seconds 30
```

Use the same release, dataset, window size, visibility, and workload for comparisons. The sampler reads `/proc` process statistics only, not recordings, transcripts, or environment secrets. CPU 100% denotes one occupied core; RSS is a summed process metric rather than unique physical memory. Very short-lived processes can be missed.

For the renderer comparison, use `WEBKIT_DISABLE_DMABUF_RENDERER=0` versus `1` when launching the same executable, with isolated `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` directories. Do not treat enabling the option as proof of successful GPU rendering. Compare AppImage versus its extracted payload separately from a system-WebKit build, because changing both packaging and WebKit confounds the result.

WebKit documents its environment check in [AcceleratedBackingStore.cpp](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp). The source retains the existing renderer workaround because local testing produced allocation errors without it.

## Remaining work from the broader plan

- Measure scroll frame times, interaction latency, startup milestones, recording CPU, and two-hour memory/audio integrity on representative libraries.
- Full transcript virtualization, including variable heights, keyboard navigation, text search, and timestamp references. This pass preserves the full DOM and current navigation behavior.
- A bounded recording writer queue to remove file writes from audio callbacks, with tested overflow, drain, slow-disk, and device-disconnect behavior. This pass fixes Linux read conversion, not the capture architecture.
- Separate initial workspace data from device/keyring discovery if startup traces show those operations dominate.
- Profile database queries and size-versus-speed compiler settings before altering indexes or release flags. Existing code already loads segments per meeting and caches a streamed full-meeting audio mix; neither was replaced speculatively.
- Cross-platform and packaged-release testing. The local native release uses system libraries; it is not an updated AppImage and does not replace the running copy.
