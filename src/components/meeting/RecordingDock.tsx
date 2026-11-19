import { LiveWaveform, WAVEFORM_FRAME_COUNT, LEVEL_POLL_INTERVAL_MS, type LevelFrame } from "./LiveWaveform";
import { MediaImportButton } from "./MediaImportButton";
import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
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
  compact?: boolean;
}

const BACKGROUND_LEVEL_POLL_INTERVAL_MS = 750;

function RecordingDockImpl({ meeting, compact = false }: RecordingDockProps) {
  const { devices, settings, meetings, segments, segmentsLoading, updateSettings, startRecording, stopRecording, setRecordingPaused, getRecordingLevels, recordingPaused, busy } = useWorkspace(useShallow((state) => ({
    devices: state.devices,
    settings: state.settings,
    meetings: state.meetings,
    segments: state.segments,
    segmentsLoading: state.segmentsLoading,
    updateSettings: state.updateSettings,
    startRecording: state.startRecording,
    stopRecording: state.stopRecording,
    setRecordingPaused: state.setRecordingPaused,
    getRecordingLevels: state.getRecordingLevels,
    recordingPaused: state.recordingPaused,
    busy: state.busy,
  })));
  const importing = useWorkspace((state) => state.mediaImport?.meetingId === meeting.id);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);
  const [resumeConfirmOpen, setResumeConfirmOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [levelHistory, setLevelHistory] = useState<LevelFrame[]>(createSilentLevelFrames);
  const levelFrameId = useRef(0);
  const recording = meeting.status === "recording";
  const processing = meeting.status === "processing";
  const deviceButtonRef = useRef<HTMLButtonElement>(null);
  const recordButtonRef = useRef<HTMLButtonElement>(null);
  const deviceMenuRef = useDismissableLayer<HTMLDivElement>(deviceMenuOpen, (reason) => {
    setDeviceMenuOpen(false);
    if (reason === "escape") deviceButtonRef.current?.focus();
  });
  const resumeConfirmRef = useDismissableLayer<HTMLDivElement>(resumeConfirmOpen, (reason) => {
    setResumeConfirmOpen(false);
    if (reason === "escape") recordButtonRef.current?.focus();
  });
  const hasTranscript = segments.some((segment) => segment.meetingId === meeting.id);
  const activeRecording = meetings.find((candidate) => candidate.status === "recording") ?? null;
  // While segments are still loading, assume a transcript exists so the append confirm is never skipped.
  const buttonState = recordButtonState(meeting, activeRecording, hasTranscript || segmentsLoading);
  const recordLabel = buttonState.kind === "resume" ? "Record more audio" : buttonState.label;

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
        setElapsed(Math.floor(levels.elapsedMs / 1000) * 1000);
        if (!recordingPaused) setLevelHistory((history) => [
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
        if (!cancelled && !recordingPaused) {
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

  const devicePicker = (
    <button
      ref={deviceButtonRef}
      className="device-summary"
      onClick={() => setDeviceMenuOpen((open) => !open)}
      disabled={recording || processing}
      aria-haspopup="dialog"
      aria-expanded={deviceMenuOpen}
      aria-label="Choose recording devices"
      title="Choose recording devices"
    >
      {!compact && <>
        <span className="device-summary-icons">
          {settings.captureMicrophone ? <Mic size={15} /> : null}
          {settings.captureSystem ? <MonitorSpeaker size={15} /> : null}
        </span>
        <span className="device-summary-copy">
          <strong>{settings.captureMicrophone ? microphone?.name || "Choose microphone" : settings.captureSystem ? systemDevice?.name || "Choose output" : "Choose audio sources"}</strong>
          {settings.captureMicrophone && settings.captureSystem ? <small>{systemDevice?.name || "System audio"}</small> : null}
        </span>
      </>}
      <ChevronDown size={15} />
    </button>
  );

  return (
    <div className={`${compact ? "recording-tools" : "recording-dock"} ${recording ? "is-recording" : ""}`} ref={deviceMenuRef}>
      {!compact && devicePicker}

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
              focusOnOpen
              enabled={settings.captureMicrophone}
              onEnabledChange={(captureMicrophone) => void updateSettings({ ...settings, captureMicrophone })}
              devices={microphones}
              selectedId={microphone?.id ?? null}
              onSelect={(microphoneDeviceId) => void updateSettings({ ...settings, microphoneDeviceId })}
            />
            <DeviceSection
              title="System audio"
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
        {!recording && !processing ? (
          <MediaImportButton key={meeting.id} meeting={meeting} onPick={() => { setDeviceMenuOpen(false); setResumeConfirmOpen(false); }} />
        ) : null}
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
              <p>When you stop, Listen transcribes the whole meeting again. Speaker labels may change.</p>
              <div className="resume-confirm-actions">
                <button autoFocus className="secondary-button" onClick={() => { setResumeConfirmOpen(false); recordButtonRef.current?.focus(); }}>Cancel</button>
                <button className="primary-button" disabled={busy} onClick={() => void beginRecording()}>Record</button>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <motion.button
          ref={recordButtonRef}
          data-record-meeting={meeting.id}
          className={`record-button ${processing ? "processing" : recording ? "stop" : "start"}`}
          onClick={() => void toggleRecording()}
          disabled={processing || importing || busy || buttonState.kind === "blocked" || (!settings.captureMicrophone && !settings.captureSystem)}
          aria-label={recordLabel}
          aria-busy={processing}
          aria-keyshortcuts={shortcutAria("r", { shift: true })}
          title={buttonState.kind === "blocked" || buttonState.kind === "processing"
            ? recordLabel
            : `${recordLabel} (${shortcutLabel("r", { shift: true })})`}
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
              {processing ? <span className="record-processing-spinner" /> : recording ? <Square size={16} fill="currentColor" /> : <Mic size={compact ? 14 : 17} />}
            </motion.span>
          </AnimatePresence>
          {!recording && !processing ? <span>Record</span> : null}
        </motion.button>
      </div>
      {compact && devicePicker}
    </div>
  );
}

interface DeviceSectionProps {
  title: string;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  devices: Array<{ id: string; name: string; subtitle?: string | null; isAvailable: boolean }>;
  selectedId: string | null;
  focusOnOpen?: boolean;
  onSelect: (id: string) => void;
}

function DeviceSection({ title, enabled, onEnabledChange, devices, selectedId, onSelect, focusOnOpen }: DeviceSectionProps) {
  return (
    <section className="device-section">
      <label className="device-section-title">
        <span>{title}</span>
        <input autoFocus={focusOnOpen} type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.target.checked)} />
        <span className="switch" />
      </label>
      {enabled ? (
        <div className={`device-options ${devices.length > 4 ? "scrollable" : ""}`}>
          {devices.length ? devices.map((device) => (
            <button
              key={device.id}
              className={selectedId === device.id ? "selected" : ""}
              disabled={!device.isAvailable}
              aria-pressed={selectedId === device.id}
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


export const RecordingDock = memo(RecordingDockImpl);
