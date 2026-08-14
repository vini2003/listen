import { ChevronDown, LoaderCircle, Pause, Play, Sparkles, UserPlus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Meeting, Person, TranscriptSegment } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { formatDuration } from "../../lib/format";
import { focusFirstMenuItem, moveMenuFocus } from "../../lib/focus";
import { mergeSequentialSegments } from "../../lib/transcript";
import { useWorkspace } from "../../store/workspace";
import { Avatar } from "../ui/Avatar";

interface TranscriptProps {
  meeting: Meeting;
  onOpenPeople: () => void;
}

export function Transcript({ meeting, onOpenPeople }: TranscriptProps) {
  const {
    segments,
    people,
    assignSpeaker,
    settings,
    transcribeMeeting,
    busy,
    loadSegmentAudio,
  } = useWorkspace();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [loadingAudioId, setLoadingAudioId] = useState<string | null>(null);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
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
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [meeting.id]);

  async function togglePlayback(segment: TranscriptSegment): Promise<void> {
    const currentAudio = audioRef.current;
    if (playingAudioId === segment.id && currentAudio && !currentAudio.paused) {
      currentAudio.pause();
      setPlayingAudioId(null);
      return;
    }

    currentAudio?.pause();
    audioRef.current = null;
    setPlayingAudioId(null);
    setLoadingAudioId(segment.id);

    try {
      const audio = new Audio();
      audioRef.current = audio;
      audio.src = await loadSegmentAudio(meeting.id, segment.startMs, segment.endMs);
      audio.onended = () => {
        if (audioRef.current === audio) setPlayingAudioId(null);
      };
      audio.onerror = () => {
        if (audioRef.current === audio) setPlayingAudioId(null);
      };
      await audio.play();
      if (audioRef.current === audio) setPlayingAudioId(segment.id);
    } catch {
      audioRef.current?.pause();
      audioRef.current = null;
      setPlayingAudioId(null);
    } finally {
      setLoadingAudioId((current) => current === segment.id ? null : current);
    }
  }

  if (processing && !hasTranscript) {
    return (
      <div className="transcript-state">
        <span className="processing-orbit"><Sparkles size={22} /></span>
        <h3>Building transcript</h3>
        <p>Precision-2 is separating voices and transcribing the saved audio.</p>
      </div>
    );
  }

  if (!hasTranscript && !recording) {
    return (
      <div className="transcript-state">
        <span><Sparkles size={22} /></span>
        <h3>{meeting.status === "failed" ? "No transcript yet" : meeting.durationMs > 0 ? "Ready to transcribe" : "Start a recording"}</h3>
        <p>
          {meeting.status === "failed"
            ? "The audio is still saved locally. You can retry whenever you're ready."
            : meeting.durationMs > 0
              ? settings.pyannoteApiKeyConfigured
                ? "Create a transcript with Precision-2 speaker labels."
                : "Add a pyannote API key in Settings first."
              : "Press the microphone below. Recording continues until you stop."}
        </p>
        {(canTranscribe || meeting.status === "failed" && settings.pyannoteApiKeyConfigured) ? (
          <button className="primary-button" disabled={busy} onClick={() => void transcribeMeeting(meeting.id)}>
            <Sparkles size={16} /> {meeting.status === "failed" ? "Try again" : "Transcribe"}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="transcript-list">
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
          onTogglePlayback={() => void togglePlayback(segment)}
        />
      ))}
    </div>
  );
}

interface TranscriptRowProps {
  segment: TranscriptSegment;
  people: Person[];
  anonymousName: string;
  onAssign: (personId: string | null) => void;
  onOpenPeople: () => void;
  canPlay: boolean;
  loadingAudio: boolean;
  playingAudio: boolean;
  onTogglePlayback: () => void;
}

function TranscriptRow({ segment, people, anonymousName, onAssign, onOpenPeople, canPlay, loadingAudio, playingAudio, onTogglePlayback }: TranscriptRowProps) {
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
    <article className="transcript-row">
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
          <span className="timestamp-label">{formatDuration(segment.startMs)}</span>
          {canPlay ? (
            <button
              className={`segment-playback-button ${playingAudio ? "is-playing" : ""}`}
              type="button"
              onClick={onTogglePlayback}
              aria-label={playingAudio ? `Pause audio for ${speakerName}` : `Play audio for ${speakerName}`}
              title={playingAudio ? "Pause passage" : "Play passage"}
              disabled={loadingAudio}
            >
              {loadingAudio ? <LoaderCircle className="segment-playback-spinner" size={14} /> : playingAudio ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
            </button>
          ) : null}
        </div>
        <p>{segment.text}</p>
      </div>
    </article>
  );
}

function alphabeticLabel(index: number): string {
  let label = "";
  for (let value = index; value >= 0; value = Math.floor(value / 26) - 1) {
    label = String.fromCharCode(65 + value % 26) + label;
  }
  return label;
}
