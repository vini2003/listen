import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Mic, MonitorSpeaker, Pause, Play, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Meeting } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { formatDuration } from "../../lib/format";
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

export function RecordingDock({ meeting }: RecordingDockProps) {
  const { devices, settings, updateSettings, startRecording, stopRecording, setRecordingPaused, getRecordingLevels, recordingPaused, busy } = useWorkspace();
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levelHistory, setLevelHistory] = useState<LevelFrame[]>(createSilentLevelFrames);
  const levelFrameId = useRef(0);
  const recording = meeting.status === "recording";
  const processing = meeting.status === "processing";
  const deviceMenuRef = useDismissableLayer<HTMLDivElement>(deviceMenuOpen, () => setDeviceMenuOpen(false));

  useEffect(() => setElapsed(0), [meeting.id, recording]);

  useEffect(() => {
    if (!recording) {
      levelFrameId.current = 0;
      setLevelHistory(createSilentLevelFrames());
      return;
    }

    let cancelled = false;
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
      }
    };
    void updateLevels();
    const timer = window.setInterval(() => void updateLevels(), 72);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [getRecordingLevels, meeting.id, recording, recordingPaused]);

  const microphones = useMemo(() => devices.filter((device) => device.kind === "microphone"), [devices]);
  const systemDevices = useMemo(() => devices.filter((device) => device.kind === "system"), [devices]);
  const microphone = microphones.find((device) => device.id === settings.microphoneDeviceId) || microphones[0];
  const systemDevice = systemDevices.find((device) => device.id === settings.systemDeviceId) || systemDevices[0];

  async function toggleRecording(): Promise<void> {
    setDeviceMenuOpen(false);
    if (recording) {
      await stopRecording(meeting.id);
      return;
    }

    await startRecording({
      meetingId: meeting.id,
      microphoneDeviceId: microphone?.id ?? null,
      systemDeviceId: systemDevice?.id ?? null,
      captureMicrophone: settings.captureMicrophone,
      captureSystem: settings.captureSystem,
    });
  }

  return (
    <div className={`recording-dock ${recording ? "is-recording" : ""}`} ref={deviceMenuRef}>
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

      <div className="recording-primary">
        {recording ? <div className="recording-time"><span className={recordingPaused ? "paused-dot" : "live-dot"} />{formatDuration(elapsed)}</div> : null}
        <AnimatePresence initial={false}>
          {recording ? (
            <motion.button
              className="pause-button"
              initial={{ opacity: 0, width: 0, scale: .85 }}
              animate={{ opacity: 1, width: 38, scale: 1 }}
              exit={{ opacity: 0, width: 0, scale: .85 }}
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
            >
              <LiveWaveform
                frames={levelHistory}
                paused={recordingPaused}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.button
          data-record-meeting={meeting.id}
          className={`record-button ${processing ? "processing" : recording ? "stop" : "start"}`}
          onClick={() => void toggleRecording()}
          disabled={processing || busy || (!settings.captureMicrophone && !settings.captureSystem)}
          aria-label={processing ? "Transcribing recording" : recording ? "Stop recording" : "Start recording"}
          aria-busy={processing}
          aria-keyshortcuts={shortcutAria("r", { shift: true })}
          title={`${recording ? "Stop" : "Start"} recording (${shortcutLabel("r", { shift: true })})`}
          style={meterStyle(levelHistory)}
        >
          {recording && !recordingPaused ? <span className="record-button-meter" /> : null}
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
        <div className="device-options">
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
  return (
    <div className={`live-waveform ${paused ? "is-paused" : ""}`} aria-hidden="true">
      <AnimatePresence initial={false} mode="popLayout">
        {frames.map((frame) => {
          const contour = 0.72 + Math.sin(frame.id * 1.87) * 0.18 + Math.sin(frame.id * 0.47) * 0.1;
          return (
            <motion.span
              className="waveform-column"
              key={frame.id}
              layout="position"
              initial={{ opacity: 0, x: 4, scaleY: 0.45 }}
              animate={{ opacity: 1, x: 0, scaleY: 1 }}
              exit={{ opacity: 0 }}
              transition={{
                layout: { duration: 0.085, ease: "linear" },
                opacity: { duration: 0.12, ease: "linear" },
                scaleY: { duration: 0.1, ease: "easeOut" },
              }}
            >
              <i
                className="waveform-bar waveform-system"
                style={{ height: `${Math.max(2, frame.system * contour * 28)}px` }}
              />
              <i
                className="waveform-bar waveform-microphone"
                style={{ height: `${Math.max(2, frame.microphone * contour * 28)}px` }}
              />
            </motion.span>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
