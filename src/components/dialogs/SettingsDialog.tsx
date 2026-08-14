import { AudioWaveform, CheckCircle2, Eye, EyeOff, FileText, Fingerprint, LockKeyhole, MonitorSpeaker, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useWorkspace } from "../../store/workspace";
import { CustomSelect } from "../ui/CustomSelect";
import { Modal } from "../ui/Modal";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const { settings, devices, people, updateSettings, acknowledgePrivacyNotice, withdrawBiometricConsent, setApiKey, setPyannoteApiKey, openDiagnostics, busy } = useWorkspace();
  const [pyannoteKey, setPyannoteKey] = useState("");
  const [openAiKey, setOpenAiKey] = useState("");
  const [showPyannoteKey, setShowPyannoteKey] = useState(false);
  const [showOpenAiKey, setShowOpenAiKey] = useState(false);
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

  async function savePyannoteKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await setPyannoteApiKey(pyannoteKey.trim())) setPyannoteKey("");
  }

  async function saveOpenAiKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await setApiKey(openAiKey.trim())) setOpenAiKey("");
  }

  return (
    <Modal open={open} title="Settings" description="Configure capture, models, and appearance." onClose={onClose} size="large">
      <div className="settings-content">
        <section className="settings-section">
          <div className="settings-section-icon"><AudioWaveform size={18} /></div>
          <div className="settings-section-body">
            <div className="settings-heading"><div><h3>Transcription model</h3><p>Creates the transcript and separates speakers.</p></div>{settings.pyannoteApiKeyConfigured ? <span className="configured-badge"><CheckCircle2 size={14} /> Configured</span> : null}</div>
            <form className="api-key-form" onSubmit={(event) => void savePyannoteKey(event)}>
              <div className="secret-input"><LockKeyhole size={16} /><input aria-label="Pyannote API key" autoComplete="off" type={showPyannoteKey ? "text" : "password"} value={pyannoteKey} onChange={(event) => setPyannoteKey(event.target.value)} placeholder={settings.pyannoteApiKeyConfigured ? "Replace pyannote key" : "pyannote API key"} /><button type="button" onClick={() => setShowPyannoteKey((show) => !show)} aria-label={showPyannoteKey ? "Hide key" : "Show key"}>{showPyannoteKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <button className="primary-button" disabled={!pyannoteKey.trim() || busy}><Save size={15} /> Save key</button>
            </form>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-icon"><Fingerprint size={18} /></div>
          <div className="settings-section-body">
            <div className="settings-heading"><div><h3>Voice identification <small>Optional</small></h3><p>Matches confident speaker clusters to permitted local voice profiles. Uncertain speakers stay unknown.</p></div>{settings.speakerIdentificationEnabled ? <span className="configured-badge"><CheckCircle2 size={14} /> Enabled</span> : null}</div>
            {settings.speakerIdentificationEnabled ? (
              <div className="voice-settings-actions">
                {settings.localSpeakerPersonId ? <label className="settings-toggle"><input type="checkbox" checked={settings.preferLocalSpeakerForMicrophone} onChange={(event) => void updateSettings({ ...settings, preferLocalSpeakerForMicrophone: event.target.checked })} /><span>Prefer {people.find((person) => person.id === settings.localSpeakerPersonId)?.fullName || "my profile"} for clear microphone-only speech</span></label> : <p className="voice-owner-hint">Choose “This is me” for your profile in People to identify clear microphone-only speech.</p>}
                <button className="danger-text-button" type="button" onClick={() => { if (window.confirm("Turn off voice identification and permanently delete every stored voice profile? Names, recordings, and transcripts will remain.")) void withdrawBiometricConsent(); }}><Trash2 size={15} /> Turn off and erase profiles</button>
              </div>
            ) : (
              <button className="secondary-button" type="button" disabled={busy} onClick={() => void acknowledgePrivacyNotice(true)}><Fingerprint size={15} /> Enable voice identification</button>
            )}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-icon"><Sparkles size={18} /></div>
          <div className="settings-section-body">
            <div className="settings-heading"><div><h3>Text model <small>Optional</small></h3><p>Cleans transcript text and powers questions about your meetings.</p></div>{settings.apiKeyConfigured ? <span className="configured-badge"><CheckCircle2 size={14} /> Configured</span> : null}</div>
            <form className="api-key-form" onSubmit={(event) => void saveOpenAiKey(event)}>
              <div className="secret-input"><LockKeyhole size={16} /><input aria-label="OpenAI API key" autoComplete="off" type={showOpenAiKey ? "text" : "password"} value={openAiKey} onChange={(event) => setOpenAiKey(event.target.value)} placeholder={settings.apiKeyConfigured ? "Replace OpenAI key" : "sk-…"} /><button type="button" onClick={() => setShowOpenAiKey((show) => !show)} aria-label={showOpenAiKey ? "Hide key" : "Show key"}>{showOpenAiKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>
              <button className="secondary-button" disabled={!openAiKey.trim() || busy}><Save size={15} /> Save key</button>
            </form>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-icon"><MonitorSpeaker size={18} /></div>
          <div className="settings-section-body">
            <div className="settings-heading"><div><h3>Default capture</h3></div></div>
            <div className="settings-grid">
              <label><span>Microphone</span><CustomSelect ariaLabel="Microphone" value={settings.microphoneDeviceId ?? ""} options={microphoneOptions} onChange={(value) => void updateSettings({ ...settings, microphoneDeviceId: value || null })} /></label>
              <label><span>Speaker</span><CustomSelect ariaLabel="Speaker" value={settings.systemDeviceId ?? ""} options={systemOptions} onChange={(value) => void updateSettings({ ...settings, systemDeviceId: value || null })} /></label>
            </div>
          </div>
        </section>

        <section className="settings-section compact-settings">
          <div className="settings-section-body full-width">
            <div className="settings-heading"><div><h3>Appearance</h3></div><div className="theme-select"><CustomSelect compact ariaLabel="Appearance" value={settings.theme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(value) => void updateSettings({ ...settings, theme: value as "light" | "dark" | "system" })} /></div></div>
          </div>
        </section>

        <section className="settings-section compact-settings">
          <div className="settings-section-body full-width diagnostics-setting">
            <div className="settings-heading"><div><h3>Diagnostics</h3></div><button className="secondary-button" type="button" onClick={() => void openDiagnostics()}><FileText size={15} /> Open log</button></div>
          </div>
        </section>
      </div>
    </Modal>
  );
}
