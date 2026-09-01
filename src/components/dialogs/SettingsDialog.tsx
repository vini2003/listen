import { AudioWaveform, CheckCircle2, Eye, EyeOff, FileText, Fingerprint, LockKeyhole, MonitorSpeaker, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useWorkspace } from "../../store/workspace";
import { CustomSelect } from "../ui/CustomSelect";
import { Modal } from "../ui/Modal";

export type SettingsSection = "transcription" | "voice" | "text-model" | "capture" | "appearance" | "diagnostics";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}

export function SettingsDialog({ open, onClose, initialSection }: SettingsDialogProps) {
  const { settings, devices, people, updateSettings, acknowledgePrivacyNotice, withdrawBiometricConsent, setApiKey, setPyannoteApiKey, openDiagnostics, busy } = useWorkspace();
  const [pyannoteKey, setPyannoteKey] = useState("");
  const [openAiKey, setOpenAiKey] = useState("");
  const [showPyannoteKey, setShowPyannoteKey] = useState(false);
  const [showOpenAiKey, setShowOpenAiKey] = useState(false);
  const [voiceEnableConfirmOpen, setVoiceEnableConfirmOpen] = useState(false);
  const [voiceDisableConfirmOpen, setVoiceDisableConfirmOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const pyannoteInputRef = useRef<HTMLInputElement>(null);
  const openAiInputRef = useRef<HTMLInputElement>(null);
  const initialFocus = initialSection === "transcription" ? pyannoteInputRef : initialSection === "text-model" ? openAiInputRef : undefined;
  const microphoneOptions = [
    { value: "", label: "No microphone", description: "Record the speaker only" },
    ...devices.filter((device) => device.kind === "microphone").map((device) => ({ value: device.id, label: device.name, description: device.subtitle || (device.isDefault ? "System default" : undefined) })),
  ];
  const systemOptions = [
    { value: "", label: "No speaker", description: "Record the microphone only" },
    ...devices.filter((device) => device.kind === "system").map((device) => ({ value: device.id, label: device.name, description: device.subtitle || (device.isDefault ? "System default" : undefined) })),
  ];

  useEffect(() => {
    if (!open) return;
    setPyannoteKey("");
    setOpenAiKey("");
    setShowPyannoteKey(false);
    setShowOpenAiKey(false);
  }, [open]);

  useEffect(() => {
    if (!open || !initialSection) return;
    const frame = window.requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector(`[data-settings-section="${initialSection}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, initialSection]);

  async function savePyannoteKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await setPyannoteApiKey(pyannoteKey.trim())) setPyannoteKey("");
  }

  async function saveOpenAiKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await setApiKey(openAiKey.trim())) setOpenAiKey("");
  }

  return (
    <>
    <Modal open={open} title="Settings" description="Configure capture, models, and appearance." onClose={onClose} size="large" initialFocus={initialFocus}>
      <div className="settings-content" ref={contentRef}>
        <section className="settings-section" data-settings-section="transcription">
          <div className="settings-section-icon"><AudioWaveform size={18} /></div>
          <div className="settings-section-body">
            <div className="settings-heading"><div><h3>Transcription model</h3><p>Creates the transcript and separates speakers.</p></div>{settings.pyannoteApiKeyConfigured ? <span className="configured-badge"><CheckCircle2 size={14} /> Configured</span> : null}</div>
            <form className="api-key-form" onSubmit={(event) => void savePyannoteKey(event)}>
              <div className="secret-input"><LockKeyhole size={16} /><input ref={pyannoteInputRef} aria-label="Pyannote API key" autoComplete="off" type={showPyannoteKey ? "text" : "password"} value={pyannoteKey} onChange={(event) => setPyannoteKey(event.target.value)} placeholder={settings.pyannoteApiKeyConfigured ? "Replace pyannote key" : "pyannote API key"} /><button type="button" onClick={() => setShowPyannoteKey((show) => !show)} aria-label={showPyannoteKey ? "Hide key" : "Show key"}>{showPyannoteKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <button className="primary-button" disabled={!pyannoteKey.trim() || busy}><Save size={15} /> Save key</button>
            </form>
          </div>
        </section>

        <section className="settings-section" data-settings-section="voice">
          <div className="settings-section-icon"><Fingerprint size={18} /></div>
          <div className="settings-section-body">
            <div className="settings-heading"><div><h3>Voice identification <small>Optional</small></h3><p>Matches confident speaker clusters to permitted local voice profiles. Uncertain speakers stay unknown.</p></div>{settings.speakerIdentificationEnabled ? <span className="configured-badge"><CheckCircle2 size={14} /> Enabled</span> : null}</div>
            {settings.speakerIdentificationEnabled ? (
              <div className="voice-settings-actions">
                {settings.localSpeakerPersonId ? <label className="settings-toggle"><input type="checkbox" checked={settings.preferLocalSpeakerForMicrophone} onChange={(event) => void updateSettings({ ...settings, preferLocalSpeakerForMicrophone: event.target.checked })} /><span>Prefer {people.find((person) => person.id === settings.localSpeakerPersonId)?.fullName || "my profile"} for clear microphone-only speech</span></label> : <p className="voice-owner-hint">Choose “This is me” for your profile in People to identify clear microphone-only speech.</p>}
                <button className="danger-text-button" type="button" onClick={() => setVoiceDisableConfirmOpen(true)}><Trash2 size={15} /> Turn off and erase profiles</button>
              </div>
            ) : (
              <button className="secondary-button" type="button" disabled={busy} onClick={() => setVoiceEnableConfirmOpen(true)}><Fingerprint size={15} /> Enable voice identification</button>
            )}
          </div>
        </section>

        <section className="settings-section" data-settings-section="text-model">
          <div className="settings-section-icon"><Sparkles size={18} /></div>
          <div className="settings-section-body">
            <div className="settings-heading"><div><h3>Text model <small>Optional</small></h3><p>Cleans transcript text and powers questions about your meetings.</p></div>{settings.apiKeyConfigured ? <span className="configured-badge"><CheckCircle2 size={14} /> Configured</span> : null}</div>
            <form className="api-key-form" onSubmit={(event) => void saveOpenAiKey(event)}>
              <div className="secret-input"><LockKeyhole size={16} /><input ref={openAiInputRef} aria-label="OpenAI API key" autoComplete="off" type={showOpenAiKey ? "text" : "password"} value={openAiKey} onChange={(event) => setOpenAiKey(event.target.value)} placeholder={settings.apiKeyConfigured ? "Replace OpenAI key" : "sk-…"} /><button type="button" onClick={() => setShowOpenAiKey((show) => !show)} aria-label={showOpenAiKey ? "Hide key" : "Show key"}>{showOpenAiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <button className="secondary-button" disabled={!openAiKey.trim() || busy}><Save size={15} /> Save key</button>
            </form>
          </div>
        </section>

        <section className="settings-section" data-settings-section="capture">
          <div className="settings-section-icon"><MonitorSpeaker size={18} /></div>
          <div className="settings-section-body">
            <div className="settings-heading"><div><h3>Default capture</h3></div></div>
            <div className="settings-grid">
              <label><span>Microphone</span><CustomSelect ariaLabel="Microphone" maxVisibleOptions={4} value={settings.microphoneDeviceId ?? ""} options={microphoneOptions} onChange={(value) => void updateSettings({ ...settings, microphoneDeviceId: value || null })} /></label>
              <label><span>Speaker</span><CustomSelect ariaLabel="Speaker" maxVisibleOptions={4} value={settings.systemDeviceId ?? ""} options={systemOptions} onChange={(value) => void updateSettings({ ...settings, systemDeviceId: value || null })} /></label>
            </div>
          </div>
        </section>

        <section className="settings-section compact-settings" data-settings-section="appearance">
          <div className="settings-section-body full-width">
            <div className="settings-heading"><div><h3>Appearance</h3></div><div className="theme-select"><CustomSelect compact ariaLabel="Appearance" value={settings.theme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(value) => void updateSettings({ ...settings, theme: value as "light" | "dark" | "system" })} /></div></div>
          </div>
        </section>

        <section className="settings-section compact-settings" data-settings-section="diagnostics">
          <div className="settings-section-body full-width diagnostics-setting">
            <div className="settings-heading"><div><h3>Diagnostics</h3></div><button className="secondary-button" type="button" onClick={() => void openDiagnostics()}><FileText size={15} /> Open log</button></div>
          </div>
        </section>
      </div>
    </Modal>

    <Modal open={voiceEnableConfirmOpen} title="Enable voice identification?" onClose={() => setVoiceEnableConfirmOpen(false)} size="small">
      <div className="confirmation-content">
        <p>Listen creates biometric voice profiles only for people who have given permission, and prefers Unknown whenever a match is not sufficiently confident. Voice identification can be wrong and is not suitable for security decisions. You can withdraw permission and erase voice profiles at any time.</p>
        <div className="dialog-actions">
          <button className="secondary-button" onClick={() => setVoiceEnableConfirmOpen(false)}>Cancel</button>
          <button className="primary-button" disabled={busy} onClick={() => void acknowledgePrivacyNotice(true).then((succeeded) => { if (succeeded) setVoiceEnableConfirmOpen(false); })}><Fingerprint size={15} /> Enable</button>
        </div>
      </div>
    </Modal>

    <Modal open={voiceDisableConfirmOpen} title="Turn off voice identification?" onClose={() => setVoiceDisableConfirmOpen(false)} size="small">
      <div className="confirmation-content">
        <p>Every stored voice profile is <strong>permanently deleted</strong>. Names, recordings, and transcripts remain.</p>
        <div className="dialog-actions">
          <button autoFocus className="secondary-button" onClick={() => setVoiceDisableConfirmOpen(false)}>Cancel</button>
          <button className="danger-button" disabled={busy} onClick={() => void withdrawBiometricConsent().then((succeeded) => { if (succeeded) setVoiceDisableConfirmOpen(false); })}><Trash2 size={15} /> Turn off and erase profiles</button>
        </div>
      </div>
    </Modal>
    </>
  );
}
