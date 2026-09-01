import { Folder, LoaderCircle, Pause, Pencil, Play } from "lucide-react";
import { useEffect, useState } from "react";
import type { Meeting } from "../../domain/models";
import type { MeetingPlayback } from "../../hooks/useMeetingPlayback";
import { formatDuration, formatMeetingDate } from "../../lib/format";
import { useWorkspace } from "../../store/workspace";

interface MeetingHeaderProps {
  meeting: Meeting;
  playback: MeetingPlayback;
}

const STATUS_BADGES: Partial<Record<Meeting["status"], string>> = {
  recording: "Recording",
  processing: "Transcribing",
  failed: "Transcription failed",
};

export function MeetingHeader({ meeting, playback }: MeetingHeaderProps) {
  const { projects, renameMeeting } = useWorkspace();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(meeting.title);
  const projectName = projects.find((project) => project.id === meeting.projectId)?.name ?? null;
  const badgeLabel = STATUS_BADGES[meeting.status];

  useEffect(() => {
    setTitle(meeting.title);
    setRenaming(false);
  }, [meeting.id, meeting.title]);

  async function commitRename(): Promise<void> {
    const nextTitle = title.trim();
    setRenaming(false);
    if (!nextTitle || nextTitle === meeting.title) {
      setTitle(meeting.title);
      return;
    }
    if (!(await renameMeeting(meeting.id, nextTitle))) setTitle(meeting.title);
  }

  function cancelRename(): void {
    setTitle(meeting.title);
    setRenaming(false);
  }

  return (
    <header className="meeting-header">
      <div className="meeting-header-inner">
        <div className="meeting-header-title">
          {renaming ? (
            <form onSubmit={(event) => { event.preventDefault(); void commitRename(); }}>
              <input
                autoFocus
                aria-label={`Rename ${meeting.title}`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") cancelRename();
                }}
              />
            </form>
          ) : (
            <>
              <h1 onDoubleClick={() => setRenaming(true)}>{meeting.title}</h1>
              <button
                className="icon-button meeting-rename-button"
                title="Rename"
                aria-label={`Rename ${meeting.title}`}
                onClick={() => setRenaming(true)}
              >
                <Pencil size={13} />
              </button>
            </>
          )}
        </div>
        <div className="meeting-header-meta">
          {projectName ? <span className="meeting-header-project"><Folder size={12} /> {projectName}</span> : null}
          <span>{formatMeetingDate(meeting.startedAt ?? meeting.createdAt)}</span>
          {meeting.durationMs > 0 ? <span>{formatDuration(meeting.durationMs)}</span> : null}
          {badgeLabel ? (
            <span className={`meeting-status-badge status-${meeting.status}`}>
              <span className={`status-dot status-${meeting.status}`} /> {badgeLabel}
            </span>
          ) : null}
        </div>
        {playback.available ? (
          <div className="meeting-transport">
            <button
              className="transport-play-button"
              onClick={playback.toggle}
              disabled={playback.status === "preparing"}
              aria-label={playback.playing ? "Pause recording playback" : "Play recording"}
              title={playback.playing ? "Pause" : "Play recording"}
            >
              {playback.status === "preparing"
                ? <LoaderCircle className="segment-playback-spinner" size={13} />
                : playback.playing
                  ? <Pause size={12} fill="currentColor" />
                  : <Play size={12} fill="currentColor" />}
            </button>
            <span className="transport-time">{formatDuration(playback.currentMs)}</span>
            <input
              className="transport-scrubber"
              type="range"
              min={0}
              max={Math.max(playback.durationMs, 1)}
              step={250}
              value={Math.min(playback.currentMs, playback.durationMs)}
              onChange={(event) => playback.seek(Number(event.target.value))}
              disabled={playback.status === "preparing"}
              aria-label="Seek recording"
            />
            <span className="transport-time">{formatDuration(playback.durationMs)}</span>
          </div>
        ) : null}
      </div>
    </header>
  );
}
