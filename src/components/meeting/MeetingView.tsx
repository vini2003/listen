import { Mic, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { Meeting } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { formatDuration } from "../../lib/format";
import { useWorkspace } from "../../store/workspace";
import { Modal } from "../ui/Modal";
import { MeetingChat } from "./MeetingChat";
import { RecordingDock } from "./RecordingDock";
import { Transcript } from "./Transcript";

interface MeetingViewProps {
  meeting: Meeting;
  onOpenPeople: () => void;
}

export function MeetingView({ meeting, onOpenPeople }: MeetingViewProps) {
  const { busy, renameMeeting, deleteMeeting } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(meeting.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const menuRef = useDismissableLayer<HTMLDivElement>(menuOpen, () => setMenuOpen(false));

  useEffect(() => setTitle(meeting.title), [meeting.title]);

  async function commitTitle(): Promise<void> {
    const cleanTitle = title.trim();
    setEditing(false);
    if (cleanTitle && cleanTitle !== meeting.title) await renameMeeting(meeting.id, cleanTitle);
    else setTitle(meeting.title);
  }

  return (
    <motion.main
      className="meeting-view"
      key={meeting.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <header className="meeting-header">
        <div className="meeting-actions" ref={menuRef}>
          <button className="icon-button" onClick={() => setMenuOpen((open) => !open)} aria-label="Meeting options">
            <MoreHorizontal size={19} />
          </button>
          <AnimatePresence>
            {menuOpen ? (
              <motion.div className="meeting-menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
                <button onClick={() => { setEditing(true); setMenuOpen(false); }}><Pencil size={15} /> Rename</button>
                <button
                  disabled={busy || meeting.status === "recording" || meeting.status === "processing"}
                  onClick={() => {
                    setMenuOpen(false);
                    document.querySelector<HTMLButtonElement>(`[data-record-meeting="${meeting.id}"]`)?.click();
                  }}
                ><Mic size={15} /> Record</button>
                <div className="menu-divider" />
                <button className="danger-menu-item" onClick={() => { setMenuOpen(false); setDeleteOpen(true); }}><Trash2 size={15} /> Delete</button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>

        <div className="meeting-title-row">
          {editing ? (
            <input
              className="meeting-title-input"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitTitle();
                if (event.key === "Escape") { setTitle(meeting.title); setEditing(false); }
              }}
            />
          ) : (
            <button className="meeting-title-button" onClick={() => setEditing(true)}>
              <h1>{meeting.title}</h1>
            </button>
          )}
        </div>
        <div className="meeting-subtitle">
          <span>{meeting.startedAt ? new Date(meeting.startedAt).toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" }) : "Not recorded yet"}</span>
          {meeting.durationMs > 0 ? <><span className="meta-separator" /> <span>{formatDuration(meeting.durationMs)}</span></> : null}
        </div>
      </header>

      <section className="transcript-container">
        <Transcript meeting={meeting} onOpenPeople={onOpenPeople} />
      </section>

      <RecordingDock meeting={meeting} />
      <MeetingChat meeting={meeting} />

      <Modal open={deleteOpen} title="Delete?" description="You can undo this action with Ctrl+Z." onClose={() => setDeleteOpen(false)} size="small">
        <div className="confirmation-content">
          <p><strong>{meeting.title}</strong> will be removed from the sidebar.</p>
          <div className="dialog-actions">
            <button className="secondary-button" onClick={() => setDeleteOpen(false)}>Cancel</button>
            <button className="danger-button" disabled={busy} onClick={() => { setDeleteOpen(false); void deleteMeeting(meeting.id); }}>Delete</button>
          </div>
        </div>
      </Modal>
    </motion.main>
  );
}
