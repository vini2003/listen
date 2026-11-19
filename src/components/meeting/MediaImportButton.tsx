import { FileInput, LoaderCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { MediaImportFile, Meeting } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { useWorkspace } from "../../store/workspace";

export function MediaImportButton({ meeting, onPick }: { meeting: Meeting; onPick: () => void }) {
  const { pickMeetingMedia, importMeetingMedia, importBusy, importing, progress, busy } = useWorkspace(useShallow((state) => ({
    pickMeetingMedia: state.pickMeetingMedia,
    importMeetingMedia: state.importMeetingMedia,
    importBusy: state.mediaImport !== null,
    importing: state.mediaImport?.meetingId === meeting.id,
    progress: state.mediaImport?.meetingId === meeting.id ? state.mediaImport.progress : null,
    busy: state.busy,
  })));
  const [picking, setPicking] = useState(false);
  const [file, setFile] = useState<MediaImportFile | null>(null);
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function cancel(): void {
    setFile(null);
    trigger.current?.focus();
  }

  const ref = useDismissableLayer<HTMLDivElement>(file !== null, (reason) => {
    if (reason === "escape") cancel();
    else setFile(null);
  });

  async function chooseFile(): Promise<void> {
    onPick();
    setFile(null);
    setPicking(true);
    try {
      const selected = await pickMeetingMedia();
      if (!selected || !mounted.current) return;
      if (meeting.durationMs > 0) setFile(selected);
      else await importMeetingMedia(meeting.id, selected);
    } finally {
      if (mounted.current) setPicking(false);
    }
  }

  function append(): void {
    if (!file) return;
    setFile(null);
    void importMeetingMedia(meeting.id, file);
  }

  const status = progress === null ? "Importing…" : `Importing ${Math.floor(progress * 100)}%`;
  return (
    <div className="media-import" ref={ref}>
      <button
        ref={trigger}
        type="button"
        className="media-import-button"
        onClick={() => void chooseFile()}
        disabled={picking || importBusy || busy}
        aria-label={importing ? status : "Import audio or video"}
        aria-busy={importing}
        title={importBusy && !importing ? "Another import is in progress" : "Import audio or video"}
      >
        {importing ? <LoaderCircle size={15} className="media-import-spinner" /> : <FileInput size={15} />}
        {importing ? status : "Import"}
      </button>
      {file ? (
        <div className="resume-confirm media-import-confirm" role="dialog" aria-labelledby={titleId}>
          <strong id={titleId}>Append {file.name}?</strong>
          <p>The file’s audio will play after this recording.</p>
          <div className="resume-confirm-actions">
            <button autoFocus type="button" className="secondary-button" onClick={cancel}>Cancel</button>
            <button type="button" className="primary-button" disabled={busy || importBusy} onClick={append}>Append audio</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
