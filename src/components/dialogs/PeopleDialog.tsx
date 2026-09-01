import { Fingerprint, ImageUp, Mic2, Pencil, Plus, Save, Sparkles, Trash2, UserRound } from "lucide-react";
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
};

export function PeopleDialog({ open, onClose }: PeopleDialogProps) {
  const { people, settings, createPerson, updatePerson, deletePerson, eraseVoiceProfile, enableVoiceLabeling, updateSettings, busy } = useWorkspace();
  const [editing, setEditing] = useState<Person | "new" | null>(null);
  const [draft, setDraft] = useState<PersonDraft>(emptyDraft);

  useEffect(() => { if (!open) setEditing(null); }, [open]);
  useEffect(() => {
    if (!editing || editing === "new") return;
    const refreshed = people.find((person) => person.id === editing.id);
    if (refreshed && refreshed !== editing) setEditing(refreshed);
  }, [people, editing]);

  function startEditing(person: Person): void {
    setEditing(person);
    setDraft({
      fullName: person.fullName,
      nickname: null,
      photoDataUrl: person.photoDataUrl,
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
    const dataUrl = await fileToAvatarDataUrl(file);
    setDraft((current) => ({ ...current, photoDataUrl: dataUrl }));
    event.target.value = "";
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
                <div className="person-photo-control">
                  <label className="person-photo-upload" aria-label={draft.photoDataUrl ? "Change photo" : "Add photo"}>
                    <Avatar person={{ ...editing === "new" ? { id: "", color: "#777", createdAt: "" } : editing, ...draft } as Person} size="large" />
                    <span className="person-photo-overlay"><ImageUp size={19} /></span>
                    <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void readFile(event)} />
                  </label>
                  {draft.photoDataUrl ? (
                    <button
                      className="person-photo-remove"
                      type="button"
                      aria-label="Remove photo"
                      onClick={() => setDraft((current) => ({ ...current, photoDataUrl: null }))}
                    ><Trash2 size={12} /></button>
                  ) : null}
                </div>
              </div>
              <label><span>Name</span><input autoFocus value={draft.fullName} onChange={(event) => setDraft({ ...draft, fullName: event.target.value })} placeholder="Ben" /></label>
              {editing !== "new" ? (
                <div className="voice-profile-card">
                  <div className="voice-profile-heading"><span><Fingerprint size={17} /></span><div><strong>Voice identification</strong><p>{voiceProfileDescription(editing)}</p></div><span className={`voice-profile-status status-${editing.voiceProfile?.status ?? "off"}`}>{voiceProfileLabel(editing)}</span></div>
                  <label className="settings-toggle voice-labeling-toggle"><input type="checkbox" disabled={busy} checked={editing.voiceProfile?.status !== "disabled"} onChange={(event) => void (event.target.checked ? enableVoiceLabeling(editing.id) : eraseVoiceProfile(editing.id))} /><span><Sparkles size={14} /> Label this person automatically</span></label>
                  <label className="settings-toggle"><input type="checkbox" checked={settings.localSpeakerPersonId === editing.id} onChange={(event) => void updateSettings({ ...settings, localSpeakerPersonId: event.target.checked ? editing.id : null, preferLocalSpeakerForMicrophone: true })} /><span><Mic2 size={14} /> This is me on the selected microphone</span></label>
                </div>
              ) : null}
              <div className="person-form-actions">
                {editing !== "new" ? <button type="button" className="danger-text-button" onClick={() => { void deletePerson(editing.id).then((deleted) => { if (deleted) setEditing(null); }); }}><Trash2 size={15} /> Delete</button> : <span />}
                <div><button type="button" className="secondary-button" onClick={() => setEditing(null)}>Cancel</button><button className="primary-button" disabled={!draft.fullName.trim() || busy}><Save size={15} /> Save</button></div>
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

function voiceProfileLabel(person: Person): string {
  switch (person.voiceProfile?.status) {
    case "ready": return "Ready";
    case "learning": return "Learning";
    case "pending_sample": return "Needs sample";
    case "failed": return "Needs attention";
    case "disabled": return "Off";
    default: return "Waiting";
  }
}

function voiceProfileDescription(person: Person): string {
  const profile = person.voiceProfile;
  if (profile?.status === "ready") {
    const seconds = Math.round((profile.enrollmentDurationMs ?? 0) / 1000);
    return `Learned from ${profile.enrollmentClipCount ?? 1} clean clip${profile.enrollmentClipCount === 1 ? "" : "s"}${seconds ? ` (${seconds}s)` : ""}.`;
  }
  if (profile?.status === "learning") return "Creating a private profile from assigned speech.";
  if (profile?.status === "pending_sample") return "Assign this person to enough clean speech to learn their voice.";
  if (profile?.status === "failed") return profile.lastError || "The last enrollment could not be completed.";
  if (profile?.status === "disabled") return "The stored voice profile was erased and no new one will be learned.";
  return "Learned automatically the first time you label this person in a transcript.";
}

async function fileToAvatarDataUrl(file: File): Promise<string> {
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  if (file.type !== "image/png" && file.type !== "image/jpeg") return source;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("The selected photo could not be read"));
    element.src = source;
  });
  const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return source;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.84);
}
