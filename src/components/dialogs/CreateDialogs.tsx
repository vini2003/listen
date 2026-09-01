import { useEffect, useState, type FormEvent } from "react";
import { defaultMeetingTitle } from "../../lib/format";
import { useWorkspace } from "../../store/workspace";
import { CustomSelect } from "../ui/CustomSelect";
import { Modal } from "../ui/Modal";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateProjectDialog({ open, onClose }: CreateProjectDialogProps) {
  const { createProject, busy } = useWorkspace();
  const [name, setName] = useState("");

  useEffect(() => { if (open) setName(""); }, [open]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim()) return;
    if (await createProject({ name: name.trim() })) onClose();
  }

  return (
    <Modal open={open} title="Create a project" description="Keep related recordings and people together." onClose={onClose} size="small">
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <label><span>Project name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Soccer video" /></label>
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
  const { projects, createMeeting, busy } = useWorkspace();
  const [title, setTitle] = useState(defaultMeetingTitle());
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);

  useEffect(() => {
    if (open) {
      setTitle(defaultMeetingTitle());
      setProjectId(initialProjectId);
    }
  }, [initialProjectId, open]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!title.trim()) return;
    if (await createMeeting({ title: title.trim(), projectId })) onClose();
  }

  return (
    <Modal open={open} title="New meeting" description="Choose where this conversation belongs. You can move it later." onClose={onClose} size="small">
      <form className="dialog-form" onSubmit={(event) => void submit(event)}>
        <label><span>Title</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>Project</span><CustomSelect ariaLabel="Project" value={projectId ?? ""} options={[{ value: "", label: "Unsorted" }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} onChange={(value) => setProjectId(value || null)} /></label>
        <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!title.trim() || busy}>Create recording</button></div>
      </form>
    </Modal>
  );
}
