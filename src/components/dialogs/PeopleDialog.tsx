import { Camera, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import type { Person, PersonDraft } from "../../domain/models";
import { useWorkspace } from "../../store/workspace";
import { Avatar } from "../ui/Avatar";
import { Modal } from "../ui/Modal";

interface PeopleDialogProps {
  open: boolean;
  onClose: () => void;
}

const emptyDraft: PersonDraft = {
  fullName: "",
  nickname: null,
  photoDataUrl: null,
  referenceAudioDataUrl: null,
};

export function PeopleDialog({ open, onClose }: PeopleDialogProps) {
  const { people, createPerson, updatePerson, deletePerson, busy } = useWorkspace();
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const [draft, setDraft] = useState<PersonDraft>(emptyDraft);

  useEffect(() => { if (!open) setEditing(null); }, [open]);

  function startEditing(person: Person): void {
    setEditing(person);
    setDraft({
      fullName: person.fullName,
      nickname: null,
      photoDataUrl: person.photoDataUrl,
      referenceAudioDataUrl: person.referenceAudioDataUrl,
    });
  }

  function startCreating(): void {
    setEditing("new");
    setDraft(emptyDraft);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft.fullName.trim()) return;
    const cleanDraft = { ...draft, fullName: draft.fullName.trim(), nickname: null };
    const saved = editing === "new"
      ? await createPerson(cleanDraft)
      : editing
        ? await updatePerson(editing.id, cleanDraft)
        : false;
    if (saved) setEditing(null);
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    setDraft((current) => ({ ...current, photoDataUrl: dataUrl }));
  }

  return (
    <Modal open={open} title="People" onClose={onClose} size="large">
      <div className="people-layout">
        <section className="people-list-panel">
          <button className="add-person-button" onClick={startCreating}><Plus size={16} /> Add person</button>
          <div className="people-list">
            {people.map((person) => (
              <button key={person.id} className={editing !== "new" && editing?.id === person.id ? "selected" : ""} onClick={() => startEditing(person)}>
                <Avatar person={person} />
                <span><strong>{person.fullName}</strong></span>
                <Pencil size={15} />
              </button>
            ))}
            {!people.length ? <div className="people-empty"><span><UserRound size={19} /></span><p>No people yet</p></div> : null}
          </div>
        </section>

        <section className="person-editor-panel">
          {editing ? (
            <form className="person-form" onSubmit={(event) => void submit(event)}>
              <div className="person-photo-editor">
                <Avatar person={{ ...editing === "new" ? { id: "", color: "#777", createdAt: "" } : editing, ...draft } as Person} size="large" />
                <label className="upload-button"><Camera size={15} /> Choose photo<input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void readFile(event)} /></label>
              </div>
              <label><span>Name</span><input autoFocus value={draft.fullName} onChange={(event) => setDraft({ ...draft, fullName: event.target.value })} placeholder="Ben" /></label>
              <div className="person-form-actions">
                {editing !== "new" ? <button type="button" className="danger-text-button" onClick={() => { void deletePerson(editing.id).then((deleted) => { if (deleted) setEditing(null); }); }}><Trash2 size={15} /> Delete</button> : <span />}
                <div><button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" disabled={!draft.fullName.trim() || busy}>Save person</button></div>
              </div>
            </form>
          ) : (
            <div className="person-editor-empty"><UserRound size={23} /><h3>Select a person</h3></div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
