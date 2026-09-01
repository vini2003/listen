import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Mic, MonitorSpeaker, Pause, Play, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Meeting } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { formatDuration } from "../../lib/format";
import { EASE_STANDARD } from "../../lib/motion";
import { recordButtonState } from "../../lib/recording";
import { shortcutAria, shortcutLabel } from "../../lib/shortcuts";
import { useWorkspace } from "../../store/workspace";

interface RecordingDockProps {
  meeting: Meeting;
}

interface LevelFrame {
  id: number;
  microphone: number;
  system: number;
}

const WAVEFORM_FRAME_COUNT = 30;
const LEVEL_POLL_INTERVAL_MS = 80;
const BACKGROUND_LEVEL_POLL_INTERVAL_MS = 750;

export function RecordingDock({ meeting }: RecordingDockProps) {
  const { devices, settings, meetings, segments, segmentsLoading, updateSettings, startRecording, stopRecording, setRecordingPaused, getRecordingLevels, recordingPaused, busy } = useWorkspace();
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [resumeConfirmOpen, setResumeConfirmOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levelHistory, setLevelHistory] = useState<LevelFrame[]>(createSilentLevelFrames);
  const levelFrameId = useRef(0);
  const recording = meeting.status === "recording";
  const processing = meeting.status === "processing";
  const deviceMenuRef = useDismissableLayer<HTMLDivElement>(deviceMenuOpen, () => setDeviceMenuOpen(false));
  const resumeConfirmRef = useDismissableLayer<HTMLDivElement>(resumeConfirmOpen, () => setResumeConfirmOpen(false));
  const hasTranscript = segments.some((segment) => segment.meetingId === meeting.id);
  const activeRecording = meetings.find((candidate) => candidate.status === "recording") ?? null;
  // While segments are still loading, assume a transcript exists so the append confirm is never skipped.
  const buttonState = recordButtonState(meeting, activeRecording, hasTranscript || segmentsLoading);
  const idle = meeting.status === "ready" && hasTranscript && !recording;

  useEffect(() => setResumeConfirmOpen(false), [meeting.id]);

  useEffect(() => setElapsed(0), [meeting.id, recording]);

  useEffect(() => {
    if (!recording) {
      levelFrameId.current = 0;
      setLevelHistory(createSilentLevelFrames());
      return;
    }

    let cancelled = false;
    let timer: number | null = null;
    const updateLevels = async (): Promise<void> => {
      try {
        const levels = await getRecordingLevels(meeting.id);
        if (cancelled) return;
        setElapsed(levels.elapsedMs);
        setLevelHistory((history) => [
          ...history.slice(1),
          {
            id: ++levelFrameId.current,
            microphone: levels.microphone,
            system: levels.system,
          },
        ]);
      } catch {
        // Stopping a recording can race with the final meter poll.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(
            () => void updateLevels(),
            document.visibilityState === "visible"
              ? LEVEL_POLL_INTERVAL_MS
              : BACKGROUND_LEVEL_POLL_INTERVAL_MS,
          );
        }
      }
    };
    void updateLevels();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [getRecordingLevels, meeting.id, recording, recordingPaused]);

  const microphones = useMemo(() => devices.filter((device) => device.kind === "microphone"), [devices]);
  const systemDevices = useMemo(() => devices.filter((device) => device.kind === "system"), [devices]);
  const microphone = microphones.find((device) => device.id === settings.microphoneDeviceId) || microphones[0];
  const systemDevice = systemDevices.find((device) => device.id === settings.systemDeviceId) || systemDevices[0];

  async function beginRecording(): Promise<void> {
    setResumeConfirmOpen(false);
    await startRecording({
      meetingId: meeting.id,
      microphoneDeviceId: microphone?.id ?? null,
      systemDeviceId: systemDevice?.id ?? null,
      captureMicrophone: settings.captureMicrophone,
      captureSystem: settings.captureSystem,
    });
  }

  async function toggleRecording(): Promise<void> {
    setDeviceMenuOpen(false);
    if (recording) {
      await stopRecording(meeting.id);
      return;
    }
    if (buttonState.kind === "blocked") return;
    if (buttonState.kind === "resume" && buttonState.confirm) {
      setResumeConfirmOpen((open) => !open);
      return;
    }
    await beginRecording();
  }

  return (
    <div className={`recording-dock ${recording ? "is-recording" : ""} ${idle ? "is-idle" : ""}`} ref={deviceMenuRef}>
      <button
        className="device-summary"
        onClick={() => setDeviceMenuOpen((open) => !open)}
        disabled={recording || processing}
        aria-haspopup="dialog"
        aria-expanded={deviceMenuOpen}
        aria-label="Choose recording devices"
      >
        <span className="device-summary-icons">
          <Mic size={15} />
          {settings.captureSystem ? <MonitorSpeaker size={15} /> : null}
        </span>
        <span className="device-summary-copy">
          <strong>{settings.captureMicrophone ? microphone?.name || "Choose microphone" : systemDevice?.name || "Choose speaker"}</strong>
          <small>{settings.captureMicrophone && settings.captureSystem ? systemDevice?.name || "Speaker" : settings.captureMicrophone ? "Microphone only" : "Speaker only"}</small>
        </span>
        <ChevronDown size={15} />
      </button>

      <AnimatePresence>
        {deviceMenuOpen ? (
          <motion.div
            className="device-menu"
            role="dialog"
            aria-label="Recording devices"
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 5, scale: 0.99 }}
            transition={{ duration: 0.14, ease: EASE_STANDARD }}
          >
            <DeviceSection
              title="Microphone"
              enabled={settings.captureMicrophone}
              onEnabledChange={(captureMicrophone) => void updateSettings({ ...settings, captureMicrophone })}
              devices={microphones}
              selectedId={microphone?.id ?? null}
              onSelect={(microphoneDeviceId) => void updateSettings({ ...settings, microphoneDeviceId })}
            />
            <DeviceSection
              title="Speaker"
              enabled={settings.captureSystem}
              onEnabledChange={(captureSystem) => void updateSettings({ ...settings, captureSystem })}
              devices={systemDevices}
              selectedId={systemDevice?.id ?? null}
              onSelect={(systemDeviceId) => void updateSettings({ ...settings, systemDeviceId })}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="recording-primary" ref={resumeConfirmRef}>
        {recording ? <div className="recording-time"><span className={recordingPaused ? "paused-dot" : "live-dot"} />{formatDuration(elapsed)}</div> : null}
        <AnimatePresence initial={false}>
          {recording ? (
            <motion.button
              className="pause-button"
              initial={{ opacity: 0, width: 0, scale: .85 }}
              animate={{ opacity: 1, width: 38, scale: 1 }}
              exit={{ opacity: 0, width: 0, scale: .85 }}
              transition={{ duration: 0.16, ease: EASE_STANDARD }}
              onClick={() => void setRecordingPaused(meeting.id, !recordingPaused)}
              aria-label={recordingPaused ? "Resume recording" : "Pause recording"}
            >
              {recordingPaused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}
            </motion.button>
          ) : null}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {recording ? (
            <motion.div
              className="live-waveform-wrap"
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 132 }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.16, ease: EASE_STANDARD }}
            >
              <LiveWaveform
                frames={levelHistory}
                paused={recordingPaused}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
        <AnimatePresence>
          {resumeConfirmOpen ? (
            <motion.div
              className="resume-confirm"
              role="dialog"
              aria-label="Add to this recording?"
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 5, scale: 0.99 }}
              transition={{ duration: 0.14, ease: EASE_STANDARD }}
            >
              <strong>Add to this recording?</strong>
              <p>New audio is appended and the whole meeting is re-transcribed when you stop. Speaker assignments may need review.</p>
              <div className="resume-confirm-actions">
                <button className="secondary-button" onClick={() => setResumeConfirmOpen(false)}>Cancel</button>
                <button className="primary-button" disabled={busy} onClick={() => void beginRecording()}><Mic size={14} /> Resume recording</button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.button
          data-record-meeting={meeting.id}
          className={`record-button ${processing ? "processing" : recording ? "stop" : "start"}`}
          onClick={() => void toggleRecording()}
          disabled={processing || busy || buttonState.kind === "blocked" || (!settings.captureMicrophone && !settings.captureSystem)}
          aria-label={buttonState.label}
          aria-busy={processing}
          aria-keyshortcuts={shortcutAria("r", { shift: true })}
          title={buttonState.kind === "blocked" || buttonState.kind === "processing"
            ? buttonState.label
            : `${buttonState.label} (${shortcutLabel("r", { shift: true })})`}
          style={meterStyle(levelHistory)}
        >
          {recording && !recordingPaused ? <span className="record-button-meter" /> : null}
          {buttonState.kind === "resume" ? <span className="record-plus-badge" aria-hidden="true">+</span> : null}
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              className="record-button-symbol"
              key={processing ? "processing" : recording ? "stop" : "record"}
              initial={{ opacity: 0, scale: 0.65, rotate: processing ? -45 : 0 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.65 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
              {processing ? <span className="record-processing-spinner" /> : recording ? <Square size={18} fill="currentColor" /> : <Mic size={21} />}
            </motion.span>
          </AnimatePresence>
        </motion.button>
      </div>
    </div>
  );
}

interface DeviceSectionProps {
  title: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  devices: Array<{ id: string; name: string; subtitle?: string | null; isAvailable: boolean }>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function DeviceSection({ title, enabled, onEnabledChange, devices, selectedId, onSelect }: DeviceSectionProps) {
  return (
    <section className="device-section">
      <label className="device-section-title">
        <span>{title}</span>
        <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        <span className="switch" />
      </label>
      {enabled ? (
        <div className={`device-options ${devices.length > 4 ? "scrollable" : ""}`}>
          {devices.length ? devices.map((device) => (
            <button
              key={device.id}
              className={selectedId === device.id ? "selected" : ""}
              disabled={!device.isAvailable}
              onClick={() => onSelect(device.id)}
            >
              <span className="device-option-copy">
                <strong>{device.name}</strong>
                {device.subtitle ? <small>{device.subtitle}</small> : null}
              </span>
              {selectedId === device.id ? <span className="selection-check">✓</span> : null}
            </button>
          )) : <p>No devices available</p>}
        </div>
      ) : null}
    </section>
  );
}

function createSilentLevelFrames(): LevelFrame[] {
  return Array.from({ length: WAVEFORM_FRAME_COUNT }, (_, index) => ({
    id: index - WAVEFORM_FRAME_COUNT,
    microphone: 0,
    system: 0,
  }));
}

function meterStyle(levelHistory: LevelFrame[]): CSSProperties {
  const current = levelHistory[levelHistory.length - 1];
  const level = Math.max(current?.microphone ?? 0, current?.system ?? 0);
  return {
    "--meter-inset": `${-2 - level * 4}px`,
    "--meter-scale": 1 + level * 0.13,
    "--meter-opacity": 0.35 + level * 0.45,
  } as CSSProperties;
}

function LiveWaveform({ frames, paused }: {
  frames: LevelFrame[];
  paused: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef(frames);
  const outgoingFrameRef = useRef<LevelFrame | null>(null);
  const frameStartedAtRef = useRef(performance.now());
  const pausedRef = useRef(paused);

  useEffect(() => {
    const previousFrames = framesRef.current;
    const previousLatest = previousFrames[previousFrames.length - 1]?.id;
    const nextLatest = frames[frames.length - 1]?.id;
    if (previousLatest !== nextLatest) {
      outgoingFrameRef.current = previousFrames[0] ?? null;
      frameStartedAtRef.current = performance.now();
    }
    framesRef.current = frames;
  }, [frames]);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;

    const resize = (): void => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const nextWidth = Math.max(1, Math.round(width * pixelRatio));
      const nextHeight = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== nextWidth) canvas.width = nextWidth;
      if (canvas.height !== nextHeight) canvas.height = nextHeight;
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    const draw = (now: number): void => {
      const context = canvas.getContext("2d");
      if (!context || width <= 0 || height <= 0) {
        animationFrame = window.requestAnimationFrame(draw);
        return;
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const currentFrames = framesRef.current;
      const step = width / Math.max(1, WAVEFORM_FRAME_COUNT);
      const progress = pausedRef.current
        ? 1
        : Math.min(1, Math.max(0, (now - frameStartedAtRef.current) / LEVEL_POLL_INTERVAL_MS));

      const outgoing = outgoingFrameRef.current;
      if (outgoing && progress < 1) {
        drawWaveformFrame(context, outgoing, (progress - 1) * step, step, width, height, 1 - progress);
      }
      currentFrames.forEach((frame, index) => {
        const x = (index + 1 - progress) * step;
        drawWaveformFrame(context, frame, x, step, width, height, 1);
      });

      animationFrame = window.requestAnimationFrame(draw);
    };

    animationFrame = window.requestAnimationFrame(draw);
    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div className={`live-waveform ${paused ? "is-paused" : ""}`} aria-hidden="true">
      <canvas className="live-waveform-canvas" ref={canvasRef} />
    </div>
  );
}

function drawWaveformFrame(
  context: CanvasRenderingContext2D,
  frame: LevelFrame,
  x: number,
  step: number,
  width: number,
  height: number,
  opacity: number,
): void {
  if (x < -step || x > width) return;
  const contour = 0.72 + Math.sin(frame.id * 1.87) * 0.18 + Math.sin(frame.id * 0.47) * 0.1;
  const edgeFade = Math.min(1, Math.max(0, x / Math.max(1, width * 0.2)));
  const centerX = x + step / 2;
  /* keep in sync with --drop-target / --recording in styles.css */
  drawWaveformBar(context, centerX, frame.system * contour, height, 3, `rgba(110, 140, 240, ${0.42 * opacity * edgeFade})`);
  drawWaveformBar(context, centerX, frame.microphone * contour, height, 2, `rgba(210, 76, 64, ${opacity * edgeFade})`);
}

function drawWaveformBar(
  context: CanvasRenderingContext2D,
  x: number,
  level: number,
  height: number,
  width: number,
  color: string,
): void {
  const barHeight = Math.max(2, level * (height - 10));
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.moveTo(x, height / 2 - barHeight / 2);
  context.lineTo(x, height / 2 + barHeight / 2);
  context.stroke();
}
