# Linux rendering investigation — 2026-09-14

The broad fallback is not the only working option. On this machine, enabling WebKit's renderer while forcing shared-memory buffer transport rendered Listen correctly in both the native executable and the existing AppImage. The normal hardware-buffer path still failed. The investigation initially left application defaults unchanged. The shared-memory mode has since been integrated as the Linux startup default; explicit environment overrides are preserved and installed desktop entries are unchanged.

## Tested environment

- Arch Linux, X11; NVIDIA RTX 3080 and AMD Granite Ridge integrated graphics.
- NVIDIA driver 615.71.09; Mesa 26.2.2.
- System WebKitGTK 2.52.6. The existing `Listen_0.2.0_amd64.AppImage` bundles WebKitGTK 2.50.4 (verified from its version getter functions, not inferred from its filename).
- No running Wayland session was available.

## Controlled frontend measurements

The production Listen frontend was loaded in an ephemeral GTK3/WebKitGTK 2.52.6 window with a synthetic 1,000-row transcript at 1180×780. Each run programmatically scrolled the transcript for six seconds. Tests were sequential. CPU is process-tree CPU normalized to one core; 100% means one occupied core. This harness uses browser-preview services rather than the Tauri backend.

| Configuration | Scrolling CPU, two runs | p95 animation callback interval | Outcome |
| --- | --- | --- | --- |
| Broad fallback: `WEBKIT_DISABLE_DMABUF_RENDERER=1` | 59.47%, 52.35% | 17 ms, 17 ms | Rendered; WebKit policy reported `never` |
| Narrower fallback: disable=0, force shared memory=1 | 45.14%, 46.30% | 17 ms, 18 ms | Rendered; WebKit policy reported `always` |
| Explicit AMD/Mesa selection, disable=0 | 27.44%, 27.28% | 17 ms, 17 ms | Rendered in harness; AMD render device was open |
| Default GPU, disable=0, no forced shared memory | No completed sample | No completed sample | GBM allocation errors; timed out |

The narrower fallback used approximately 18% less CPU averaged across these short runs. Callback timing was similar. These measurements do not establish displayed-frame FPS, battery savings, long-term reliability, recording performance, or identical gains in the AppImage. The WebGL renderer string returned `Apple GPU` even on this Linux machine and was not used to identify hardware; device file descriptors and loaded libraries were inspected instead.

## Full application checks

- Native release + narrower shared-memory mode: the synthetic transcript rendered correctly; screenshot inspected; no GBM errors observed.
- Existing AppImage + narrower shared-memory mode: the synthetic transcript rendered correctly; screenshot inspected; the WebKit process inherited both settings.
- Native release + AMD/Mesa route: the WebKit process opened the AMD render node and loaded Mesa, but native window captures were black, including a follow-up with shared-memory transport. This configuration is not validated for use.
- AppImage + AMD/Mesa route: emitted `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`. The main app process remained alive; that is not a successful launch.

The GPU-selection experiment is therefore promising only in the standalone harness. It is not recommended as a production launcher configuration. All isolated app instances were closed. The user's original running AppImage and real database were left alone.

## Recommended next setting to try

Use the narrower shared-memory mode for the next normal Listen session:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=0 WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 /path/to/listen
```

These values are now the built-in Linux defaults, so the command is only needed for older builds. This retains WebKit's accelerated infrastructure while choosing shared-memory transport instead of its failing hardware-buffer allocation path; shared-memory transport still incurs copies. It does not guarantee that every drawing operation runs on the GPU.

A session-scoped launcher was saved with the investigation outputs. It defaults to the optimized native executable from the previous pass and accepts an alternative Listen executable/AppImage as its first argument. Close the existing Listen session before using it against the normal database. The launcher does not alter global environment settings, the AppImage, or installed desktop entries.

The startup comment now distinguishes shared-memory transport from the old broad disable flag. In the tested system WebKit, the broad flag produced a `never` acceleration policy; `FORCE_SHM` left it at `always`. Set `WEBKIT_DISABLE_DMABUF_RENDERER=1` to recover the older compatibility mode. Set `WEBKIT_DMABUF_RENDERER_FORCE_SHM=0` to opt out of forced shared-memory transport. Existing values of either variable are never overwritten.

## Reproduce the controlled test

Requires Python with PyGObject, GTK3 and WebKit2 4.1, plus an X11/Wayland desktop. The probe opens a temporary window and closes it automatically; it uses synthetic browser-preview data.

```sh
npm run build
WEBKIT_DISABLE_DMABUF_RENDERER=1 python3 scripts/graphics-probe.py /tmp/listen-probe-compat
WEBKIT_DISABLE_DMABUF_RENDERER=0 WEBKIT_DMABUF_RENDERER_FORCE_SHM=1 python3 scripts/graphics-probe.py /tmp/listen-probe-shm
```

The explicit AMD experiment additionally used `WEBKIT_WEB_RENDER_DEVICE_FILE=/dev/dri/renderD129`, `DRI_PRIME=pci-0000_0c_00_0`, and `__EGL_VENDOR_LIBRARY_FILENAMES=/usr/share/glvnd/egl_vendor.d/50_mesa.json`. Those addresses are machine-specific and are recorded for reproducibility, not recommended defaults.

## Primary references

- [WebKitGTK 2.52.6 buffer transport and acceleration checks](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp#L76-L132)
- [WebKitGTK 2.50.4 equivalent checks](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp#L76-L132)
- [Mesa environment-variable documentation](https://docs.mesa3d.org/envvars.html)
