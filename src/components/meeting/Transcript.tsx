import { Check, ChevronDown, Copy, KeyRound, LoaderCircle, Mic2, Pause, Play, Sparkles, Trash2, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Meeting, Person, TranscriptSegment } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { formatDuration } from "../../lib/format";
import { focusFirstMenuItem, moveMenuFocus } from "../../lib/focus";
import type { MeetingPlayback } from "../../hooks/useMeetingPlayback";
import { mergeSequentialSegments, transcriptStateFor, type TranscriptTurn } from "../../lib/transcript";
import { useWorkspace } from "../../store/workspace";
import type { SettingsSection } from "../dialogs/SettingsDialog";
import { Avatar } from "../ui/Avatar";

interface TranscriptProps {
  meeting: Meeting;
  onOpenPeople: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
  transport: MeetingPlayback;
}

export function Transcript({ meeting, onOpenPeople, onOpenSettings, transport }: TranscriptProps) {
  const {
    segments,
    people,
    assignSpeaker,
    settings,
    transcribeMeeting,
    busy,
    segmentsLoading,
    loadSegmentAudio,
    deleteTranscriptSegments,
  } = useWorkspace();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const meetingSegments = useMemo(
    () => segments
      .filter((segment) => segment.meetingId === meeting.id)
      .sort((a, b) => a.startMs - b.startMs),
    [meeting.id, segments],
  );
  const anonymousNames = useMemo(() => {
    const labels = [...new Set(
      meetingSegments
        .filter((segment) => !segment.personId)
        .map((segment) => segment.speakerLabel),
    )];
    return new Map(labels.map((label, index) => [label, `Speaker ${alphabeticLabel(index)}`]));
  }, [meetingSegments]);
  const meetingTurns = useMemo(() => mergeSequentialSegments(meetingSegments), [meetingSegments]);
  const recording = meeting.status === "recording";
  const processing = meeting.status === "processing";
  const canTranscribe = meeting.durationMs > 0 && settings.pyannoteApiKeyConfigured && !recording && !processing;
  const hasTranscript = meetingSegments.length > 0;

  useEffect(() => {
    return () => {
      disposeAudio(audioRef.current);
      audioRef.current = null;
    };
  }, [meeting.id]);

  useEffect(() => {
    if (!transport.playing) return;
    disposeAudio(audioRef.current);
    audioRef.current = null;
    setPlayingAudioId(null);
  }, [transport.playing]);

  async function togglePlayback(segment: TranscriptSegment): Promise<void> {
    transport.pause();
    const currentAudio = audioRef.current;
    if (playingAudioId === segment.id && currentAudio && !currentAudio.paused) {
      currentAudio.pause();
      setPlayingAudioId(null);
      return;
    }

    disposeAudio(currentAudio);
    audioRef.current = null;
    setPlayingAudioId(null);
    setLoadingAudioId(segment.id);

    const audio = new Audio();
    audioRef.current = audio;
    try {
      const src = await loadSegmentAudio(meeting.id, segment.startMs, segment.endMs);
      if (audioRef.current !== audio) return;
      audio.src = src;
      audio.onended = () => {
        if (audioRef.current === audio) setPlayingAudioId(null);
      };
      audio.onerror = () => {
        if (audioRef.current === audio) setPlayingAudioId(null);
      };
      await audio.play();
      if (audioRef.current === audio) setPlayingAudioId(segment.id);
      else disposeAudio(audio);
    } catch {
      disposeAudio(audio);
      if (audioRef.current === audio) {
        audioRef.current = null;
        setPlayingAudioId(null);
      }
    } finally {
      setLoadingAudioId((current) => current === segment.id ? null : current);
    }
  }

  async function copyTurn(segment: TranscriptTurn): Promise<void> {
    await navigator.clipboard.writeText(segment.text);
    setCopiedId(segment.id);
    window.setTimeout(() => setCopiedId((current) => current === segment.id ? null : current), 1_400);
  }

  async function deleteTurn(segment: TranscriptTurn): Promise<void> {
    if (playingAudioId === segment.id) {
      disposeAudio(audioRef.current);
      audioRef.current = null;
      setPlayingAudioId(null);
    }
    await deleteTranscriptSegments(segment.sourceSegmentIds);
  }

  const transcriptState = transcriptStateFor({
    status: meeting.status,
    durationMs: meeting.durationMs,
    hasTranscript,
    segmentsLoading,
    pyannoteKeyConfigured: settings.pyannoteApiKeyConfigured,
  });

  if (transcriptState === "loading") {
    return (
      <div className="transcript-state quiet" aria-busy="true">
        <span className="notice-spinner" />
      </div>
    );
  }

  if (transcriptState === "recording") {
    return (
      <div className="transcript-state">
        <span className="recording-state-mark"><span className="live-dot" /></span>
        <h3>Recording in progress</h3>
        <p>Listen is capturing audio. The transcript is created after you stop.</p>
      </div>
    );
  }

  if (transcriptState === "processing") {
    return (
      <div className="transcript-state">
        <span className="processing-orbit"><Sparkles size={22} /></span>
        <h3>Building transcript</h3>
        <p>Precision-2 is separating voices and transcribing the saved audio.</p>
      </div>
    );
  }

  if (transcriptState === "failed") {
    return (
      <div className="transcript-state failed-transcript-state">
        <span><Sparkles size={22} /></span>
        <h3>No transcript yet</h3>
        <p>The audio is still saved locally. You can retry whenever you're ready.</p>
        {meeting.errorMessage ? (
          <div className="transcript-notice warning-notice"><span>{meeting.errorMessage}</span></div>
        ) : null}
        {settings.pyannoteApiKeyConfigured ? (
          <button className="primary-button" disabled={busy} onClick={() => void transcribeMeeting(meeting.id)}>
            <Sparkles size={16} /> Try again
          </button>
        ) : null}
      </div>
    );
  }

  if (transcriptState === "awaiting-key" || transcriptState === "ready-to-transcribe" || transcriptState === "empty") {
    return (
      <div className="transcript-state">
        <span><Sparkles size={22} /></span>
        <h3>{transcriptState === "empty" ? "Start a recording" : "Ready to transcribe"}</h3>
        <p>
          {transcriptState === "empty"
            ? "Press the microphone below. Recording continues until you stop."
            : transcriptState === "ready-to-transcribe"
              ? "Create a transcript with Precision-2 speaker labels."
              : "Add a pyannote API key to create the transcript."}
        </p>
        {transcriptState === "ready-to-transcribe" && canTranscribe ? (
          <button className="primary-button" disabled={busy} onClick={() => void transcribeMeeting(meeting.id)}>
            <Sparkles size={16} /> Transcribe
          </button>
        ) : null}
        {transcriptState === "awaiting-key" ? (
          <button className="primary-button" onClick={() => onOpenSettings("transcription")}>
            <KeyRound size={16} /> Add API key
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="transcript-list">
      {meeting.status === "failed" ? (
        <div className="transcript-notice warning-notice">
          <span>{meeting.errorMessage || "The last transcription attempt failed."}</span>
          {settings.pyannoteApiKeyConfigured ? (
            <button disabled={busy} onClick={() => void transcribeMeeting(meeting.id)}>Try again</button>
          ) : null}
        </div>
      ) : null}
      {meetingTurns.map((segment) => (
        <TranscriptRow
          key={segment.id}
          segment={segment}
          people={people}
          anonymousName={anonymousNames.get(segment.speakerLabel) ?? "Speaker"}
          onAssign={(personId) => void assignSpeaker(meeting.id, segment.speakerLabel, personId)}
          onOpenPeople={onOpenPeople}
          canPlay={Boolean(meeting.audioDirectory)}
          loadingAudio={loadingAudioId === segment.id}
          playingAudio={playingAudioId === segment.id}
          isCurrent={transport.playing && segment.startMs <= transport.currentMs && transport.currentMs < segment.endMs}
          copied={copiedId === segment.id}
          onTogglePlayback={() => void togglePlayback(segment)}
          onTimestampPress={() => {
            if (transport.status !== "idle") transport.seek(segment.startMs);
            else void togglePlayback(segment);
          }}
          onCopy={() => void copyTurn(segment)}
          onDelete={() => void deleteTurn(segment)}
        />
      ))}
    </div>
  );
}

function disposeAudio(audio: HTMLAudioElement | null): void {
  if (!audio) return;
  audio.pause();
  audio.onended = null;
  audio.onerror = null;
  audio.removeAttribute("src");
  audio.load();
}

interface TranscriptRowProps {
  segment: TranscriptTurn;
  people: Person[];
  anonymousName: string;
  onAssign: (personId: string | null) => void;
  onOpenPeople: () => void;
  canPlay: boolean;
  loadingAudio: boolean;
  playingAudio: boolean;
  isCurrent: boolean;
  copied: boolean;
  onTogglePlayback: () => void;
  onTimestampPress: () => void;
  onCopy: () => void;
  onDelete: () => void;
}

function TranscriptRow({ segment, people, anonymousName, onAssign, onOpenPeople, canPlay, loadingAudio, playingAudio, isCurrent, copied, onTogglePlayback, onTimestampPress, onCopy, onDelete }: TranscriptRowProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useDismissableLayer<HTMLDivElement>(open, () => setOpen(false));
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const person = people.find((candidate) => candidate.id === segment.personId);
  const speakerName = person?.fullName || anonymousName;

  useEffect(() => {
    if (open) window.requestAnimationFrame(() => focusFirstMenuItem(menuPanelRef.current));
  }, [open]);

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
    if (event.key === "Escape") window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <article
      className={`transcript-row ${isCurrent ? "is-current" : ""}`}
      data-meeting-id={segment.meetingId}
      data-transcript-start-ms={segment.startMs}
    >
      <div className="transcript-speaker-column">
        <Avatar person={person} label={speakerName.charAt(0).toUpperCase()} />
      </div>
      <div className="transcript-copy">
        <div className="transcript-meta">
          <div className="speaker-picker-wrap" ref={menuRef}>
            <button ref={triggerRef} className="speaker-picker" onClick={() => setOpen((current) => !current)} aria-haspopup="menu" aria-expanded={open} aria-label={`Assign speaker for ${speakerName}`}>
              <strong>{speakerName}</strong><ChevronDown size={14} />
            </button>
            {open ? (
              <div ref={menuPanelRef} className="speaker-menu" role="menu" aria-label={`Assign ${speakerName} to a person`} onKeyDown={handleMenuKeyDown}>
                <button role="menuitem" onClick={() => { onAssign(null); setOpen(false); }}>
                  <Avatar label={anonymousName.charAt(0).toUpperCase()} size="small" />
                  <span>{anonymousName}</span>
                </button>
                {people.map((candidate) => (
                  <button role="menuitem" key={candidate.id} onClick={() => { onAssign(candidate.id); setOpen(false); }}>
                    <Avatar person={candidate} size="small" />
                    <span>{candidate.fullName}</span>
                    {candidate.id === segment.personId ? <span className="selection-check">✓</span> : null}
                  </button>
                ))}
                <button role="menuitem" className="speaker-menu-add" onClick={() => { setOpen(false); onOpenPeople(); }}>
                  <span className="avatar avatar-small"><UserPlus size={13} /></span>
                  <span>Add a person</span>
                </button>
              </div>
            ) : null}
          </div>
          {segment.personId && (segment.identitySource === "voiceprint" || segment.identitySource === "local_microphone") ? (
            <span className="identity-auto-badge" title={autoIdentityTitle(segment)} aria-label={autoIdentityTitle(segment)}>
              {segment.identitySource === "local_microphone" ? <Mic2 size={10} /> : <Sparkles size={10} />}
            </span>
          ) : null}
          <button
            type="button"
            className={`timestamp-button ${playingAudio ? "is-playing" : ""} ${loadingAudio ? "is-loading" : ""}`}
            onClick={onTimestampPress}
            disabled={!canPlay || loadingAudio}
            aria-label={playingAudio ? `Pause audio at ${formatDuration(segment.startMs)}` : `Play audio from ${formatDuration(segment.startMs)}`}
            title={canPlay ? (playingAudio ? "Pause passage" : "Play from here") : undefined}
          >
            <span className="timestamp-label">{formatDuration(segment.startMs)}</span>
            {canPlay ? (
              <span className="timestamp-glyph" aria-hidden="true">
                {loadingAudio ? <LoaderCircle className="segment-playback-spinner" size={10} /> : playingAudio ? <Pause size={9} fill="currentColor" /> : <Play size={9} fill="currentColor" />}
              </span>
            ) : null}
          </button>
        </div>
        <p>{segment.text}</p>
      </div>
      <div className="message-action-bar transcript-message-actions" aria-label={`Actions for ${speakerName}'s message`}>
        <button
          type="button"
          onClick={onTogglePlayback}
          aria-label={playingAudio ? `Pause audio for ${speakerName}` : `Play audio for ${speakerName}`}
          title={playingAudio ? "Pause passage" : "Play passage"}
          disabled={!canPlay || loadingAudio}
          className={playingAudio ? "is-playing" : ""}
        >
          {loadingAudio ? <LoaderCircle className="segment-playback-spinner" size={13} /> : playingAudio ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
        </button>
        <button type="button" onClick={onCopy} aria-label={copied ? "Message copied" : "Copy message"} title="Copy">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <button className="danger-action" type="button" onClick={onDelete} aria-label="Delete message" title="Delete · Ctrl+Z to undo">
          <Trash2 size={13} />
        </button>
      </div>
    </article>
  );
}

function autoIdentityTitle(segment: TranscriptSegment): string {
  if (segment.identitySource === "local_microphone") return "Labeled automatically from your microphone";
  const confidence = segment.identityConfidence ? ` · ${Math.round(segment.identityConfidence)}% confident` : "";
  return `Labeled automatically by voice match${confidence}`;
}

function alphabeticLabel(index: number): string {
  let label = "";
  for (let value = index; value >= 0; value = Math.floor(value / 26) - 1) {
    label = String.fromCharCode(65 + value % 26) + label;
  }
  return label;
}
