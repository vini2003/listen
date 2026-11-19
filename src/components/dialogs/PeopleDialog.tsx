import { ImageUp, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { Person } from "../../domain/models";
import { useWorkspace } from "../../store/workspace";
import { Avatar } from "../ui/Avatar";
import { Modal } from "../ui/Modal";

interface PeopleDialogProps {
  open: boolean;
  onClose: () => void;
}

export function PeopleDialog({ open, onClose }: PeopleDialogProps) {
  const people = useWorkspace((state) => state.people);
  const [editor, setEditor] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const busy = useWorkspace((state) => state.busy);
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const person = people.find((candidate) => candidate.id === editor);
  const editing = Boolean(person) || editor === "new";

  useEffect(() => {
    if (!open) {
      setEditor(null);
      setDeleteOpen(false);
    }
  }, [open]);

  function showList(): void {
    setDeleteOpen(false);
    setEditor(null);
    window.requestAnimationFrame(() => {
      const row = editor ? listRef.current?.querySelector<HTMLButtonElement>(`[data-person-id="${CSS.escape(editor)}"]`) : null;
      (row ?? addRef.current)?.focus();
    });
  }

  return (
    <>
      <Modal open={open} title={editing ? (person ? "Edit person" : "Add person") : "People"} onClose={onClose} size="small" initialFocus={addRef}>
        {editing ? (
          <PersonEditor key={editor} person={person} onDone={showList} onDelete={() => setDeleteOpen(true)} />
        ) : (
          <div className="people-list-panel">
            {people.length > 0 ? (
              <div className="people-list" ref={listRef}>
                {people.map((entry) => (
                  <button type="button" key={entry.id} data-person-id={entry.id} onClick={() => setEditor(entry.id)}>
                    <Avatar person={entry} /><span>{entry.fullName}</span>
                  </button>
                ))}
              </div>
            ) : <p className="people-empty">No people yet.</p>}
            <button ref={addRef} className="secondary-button people-add" onClick={() => setEditor("new")}><Plus size={15} /> Add person</button>
          </div>
        )}
      </Modal>
      <Modal open={open && deleteOpen && Boolean(person)} title={`Delete ${person?.fullName}?`} onClose={() => setDeleteOpen(false)} size="small">
        <div className="confirmation-content">
          <p>Their name will be removed from transcripts.</p>
          <div className="dialog-actions">
            <button autoFocus type="button" className="secondary-button" onClick={() => setDeleteOpen(false)}>Cancel</button>
            <button type="button" className="danger-button" disabled={busy} onClick={() => {
              if (person) void useWorkspace.getState().deletePerson(person.id).then((deleted) => { if (deleted) showList(); });
            }}>Delete person</button>
          </div>
        </div>
      </Modal>
    </>
  );
}

function PersonEditor({ person, onDone, onDelete }: { person?: Person; onDone: () => void; onDelete: () => void }) {
  const settings = useWorkspace((state) => state.settings);
  const busy = useWorkspace((state) => state.busy);
  const [name, setName] = useState(person?.fullName ?? "");
  const [photo, setPhoto] = useState(person?.photoDataUrl ?? null);
  const [photoError, setPhotoError] = useState("");
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [saving, setSaving] = useState(false);
  const photoRequest = useRef(0);
  const fingerprintEnabled = person?.voiceProfile?.status !== "disabled";
  const microphoneOwner = person?.id === settings.localSpeakerPersonId;
  const [fingerprintChoice, setFingerprintChoice] = useState<boolean | null>(null);
  const [microphoneChoice, setMicrophoneChoice] = useState<boolean | null>(null);
  const fingerprint = fingerprintChoice ?? fingerprintEnabled;
  const microphone = microphoneChoice ?? microphoneOwner;
  const erasing = fingerprintEnabled && !fingerprint && Boolean(person?.voiceProfile);
  const changed = !person || name.trim() !== person.fullName || photo !== person.photoDataUrl
    || fingerprint !== fingerprintEnabled || microphone !== microphoneOwner;

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!name.trim() || saving || readingPhoto || busy) return;
    const workspace = useWorkspace.getState();
    const draft = { fullName: name.trim(), nickname: person?.nickname ?? null, photoDataUrl: photo };
    setSaving(true);
    try {
      if (!person) {
        if (await workspace.createPerson(draft)) onDone();
        return;
      }
      if (draft.fullName !== person.fullName || photo !== person.photoDataUrl) {
        if (!(await workspace.updatePerson(person.id, draft))) return;
      }
      if (microphone !== microphoneOwner) {
        const latest = useWorkspace.getState().settings;
        if (!(await workspace.updateSettings({
          ...latest,
          localSpeakerPersonId: microphone ? person.id : null,
          preferLocalSpeakerForMicrophone: microphone || latest.preferLocalSpeakerForMicrophone,
        }))) return;
      }
      if (fingerprint !== fingerprintEnabled) {
        const update = fingerprint ? workspace.enableVoiceLabeling : workspace.eraseVoiceProfile;
        if (!(await update(person.id))) return;
      }
      onDone();
    } finally {
      setSaving(false);
    }
  }

  async function readPhoto(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    const request = ++photoRequest.current;
    setPhotoError("");
    setReadingPhoto(true);
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      if (photoRequest.current === request) setPhoto(dataUrl);
    } catch {
      if (photoRequest.current === request) setPhotoError("Couldn’t read this photo. Choose a PNG, JPEG or WebP.");
    } finally {
      if (photoRequest.current === request) setReadingPhoto(false);
    }
  }

  return (
    <form className="person-form" onSubmit={(event) => void save(event)}>
      <div className="person-identity">
        <div className="person-photo-control">
          <label className="person-photo-upload" title={photo ? "Change photo" : "Add photo"}>
            {photo ? <img className="avatar avatar-large" src={photo} alt="" /> : <Avatar size="large" label={name || "?"} color={person?.color} />}
            <span className="person-photo-overlay" aria-hidden="true"><ImageUp size={12} /></span>
            <input type="file" aria-label={photo ? "Change photo" : "Add photo"} accept="image/png,image/jpeg,image/webp" onChange={(event) => void readPhoto(event)} />
          </label>
          {photo ? (
            <button type="button" className="person-photo-remove" aria-label="Remove photo" title="Remove photo" onClick={() => {
              photoRequest.current++;
              setReadingPhoto(false);
              setPhotoError("");
              setPhoto(null);
            }}><X size={12} /></button>
          ) : null}
        </div>
        <label className="person-name"><span>Name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      </div>
      {photoError ? <p role="alert" className="person-photo-error">{photoError}</p> : null}
      {person ? (
        <div className="voice-profile-controls">
          <div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={fingerprint}
                disabled={saving}
                onChange={(event) => setFingerprintChoice(event.target.checked)}
                aria-describedby={fingerprint || erasing ? "person-fingerprint-status" : undefined}
              />
              <span>Fingerprinting</span>
            </label>
            {fingerprint || erasing ? (
              <p id="person-fingerprint-status" className={erasing ? "voice-profile-warning" : undefined}>
                {erasing ? "Saving will erase this person’s fingerprint." : voiceStatus(person)}
              </p>
            ) : null}
          </div>
          <label className="settings-toggle">
            <input type="checkbox" checked={microphone} disabled={saving} onChange={(event) => setMicrophoneChoice(event.target.checked)} />
            <span>This person uses my microphone</span>
          </label>
        </div>
      ) : null}
      <div className="person-form-actions">
        {person ? <button type="button" className="danger-text-button" disabled={busy || saving} onClick={onDelete}>Delete person</button> : null}
        <div>
          <button type="button" className="secondary-button" disabled={saving} onClick={onDone}>Cancel</button>
          <button className="primary-button" disabled={!name.trim() || !changed || readingPhoto || saving || busy}>{person ? "Save" : "Add person"}</button>
        </div>
      </div>
    </form>
  );
}

function voiceStatus(person: Person): string {
  const profile = person.voiceProfile;
  switch (profile?.status) {
    case "ready": return "Ready to recognize this voice.";
    case "learning": return "Learning from labeled speech…";
    case "failed": return profile.lastError || "Couldn’t learn this voice. Label another passage to try again.";
    case "pending_sample": return profile.lastError?.startsWith("Relearning")
      ? "Relearning from labeled speech…"
      : "Label a clear passage from this person to learn their voice.";
    default: return "Label this person in a transcript to learn their voice.";
  }
}

async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Unsupported image");
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

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
