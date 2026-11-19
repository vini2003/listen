import { useShallow } from "zustand/react/shallow";
import { FileAudio, FileUp, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { MediaImportFile } from "../../domain/models";
import { defaultMeetingTitle } from "../../lib/format";
import { useWorkspace } from "../../store/workspace";
import { CustomSelect } from "../ui/CustomSelect";
import { Modal } from "../ui/Modal";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const { createProject, busy } = useWorkspace(useShallow((state) => ({
    createProject: state.createProject,
    busy: state.busy,
  })));
  const [name, setName] = useState("");

  useEffect(() => { if (open) setName(""); }, [open]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim()) return;
    if (await createProject({ name: name.trim() })) onClose();
  }

  return (
    <Modal open={open} title="New project" onClose={onClose} size="small">
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <label><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!name.trim() || busy}>Create project</button></div>
      </form>
    </Modal>
  );
}

interface CreateMeetingDialogProps {
  open: boolean;
  initialProjectId: string | null;
  onClose: () => void;
}

export function CreateMeetingDialog({ open, initialProjectId, onClose }: CreateMeetingDialogProps) {
  const { projects, createMeeting, pickMeetingMedia, importMeetingMedia, mediaImport, busy } = useWorkspace(useShallow((state) => ({
    projects: state.projects,
    createMeeting: state.createMeeting,
    pickMeetingMedia: state.pickMeetingMedia,
    importMeetingMedia: state.importMeetingMedia,
    mediaImport: state.mediaImport,
    busy: state.busy,
  })));
  const [title, setTitle] = useState(defaultMeetingTitle());
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [file, setFile] = useState<MediaImportFile | null>(null);
  const titleEdited = useRef(false);
  const dialogInstance = useRef(0);
  const importing = mediaImport?.meetingId === null;

  useEffect(() => {
    if (open) {
      setTitle(defaultMeetingTitle());
      setProjectId(initialProjectId);
      setFile(null);
      titleEdited.current = false;
    }
    return () => { dialogInstance.current += 1; };
  }, [initialProjectId, open]);

  async function chooseFile(): Promise<void> {
    const instance = dialogInstance.current;
    const chosen = await pickMeetingMedia();
    if (!chosen || instance !== dialogInstance.current) return;
    setFile(chosen);
    const suggested = chosen.name.replace(/\.[^.]+$/, "").trim() || chosen.name;
    setTitle((current) => titleEdited.current && current.trim() ? current : suggested);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim() || importing) return;
    const instance = dialogInstance.current;
    const draft = { title: title.trim(), projectId };
    const success = file ? await importMeetingMedia(draft, file) : await createMeeting(draft);
    if (success && dialogInstance.current === instance) onClose();
  }

  return (
    <Modal open={open} title={importing ? "Importing meeting" : "New meeting"} onClose={onClose} size="small">
      {importing ? (
        <div className="dialog-form">
          {file && <div className="meeting-source-name"><FileAudio size={16} /><span>{file.name}</span></div>}
          <progress className="meeting-import-progress" max={1} value={mediaImport.progress ?? undefined} aria-label="Import progress" />
          <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Hide</button></div>
        </div>
      ) : <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <label><span>Title</span><input autoFocus value={title} onFocus={(event) => event.currentTarget.select()} onChange={(event) => { titleEdited.current = true; setTitle(event.target.value); }} /></label>
        <label><span>Project</span><CustomSelect ariaLabel="Project" value={projectId ?? ""} options={[{ value: "", label: "Unsorted" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} onChange={(value) => setProjectId(value || null)} /></label>
        <div className="meeting-source">
          <button type="button" className="meeting-source-name" disabled={mediaImport !== null} onClick={() => void chooseFile()} title={file ? "Choose a different file" : undefined}>
            {file ? <FileAudio size={16} /> : <FileUp size={16} />}<span>{file?.name ?? "Import audio or video…"}</span>
          </button>
          {file && <button type="button" className="icon-button" aria-label="Remove selected file" onClick={() => { setFile(null); if (!titleEdited.current) setTitle(defaultMeetingTitle()); }}><X size={14} /></button>}
        </div>
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!title.trim() || busy || Boolean(file && mediaImport)}>{file ? "Import meeting" : "Create meeting"}</button></div>
      </form>}
    </Modal>
  );
}
