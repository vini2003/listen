import { Eye, EyeOff, FileText, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../../store/workspace";
import { SpeechModelsPanel } from "../speech/SpeechModelsPanel";
import { CustomSelect } from "../ui/CustomSelect";
import { Modal } from "../ui/Modal";

export type SettingsSection = "transcription" | "voice" | "text-model" | "capture" | "appearance" | "diagnostics";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
}

export function SettingsDialog({ open, onClose, initialSection }: SettingsDialogProps) {
  const { settings, devices, people, updateSettings, eraseAllVoiceProfiles, setApiKey, openDiagnostics, busy } = useWorkspace(useShallow((state) => ({
    settings: state.settings,
    devices: state.devices,
    people: state.people,
    updateSettings: state.updateSettings,
    eraseAllVoiceProfiles: state.eraseAllVoiceProfiles,
    setApiKey: state.setApiKey,
    openDiagnostics: state.openDiagnostics,
    busy: state.busy,
  })));
  const [openAiKey, setOpenAiKey] = useState("");
  const [showOpenAiKey, setShowOpenAiKey] = useState(false);
  const [eraseProfilesConfirmOpen, setEraseProfilesConfirmOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const openAiInputRef = useRef<HTMLInputElement>(null);
  const initialFocus = initialSection === "text-model" ? openAiInputRef : undefined;
  const localSpeaker = people.find((person) => person.id === settings.localSpeakerPersonId);
  const hasFingerprints = people.some((person) => person.voiceProfile && person.voiceProfile.status !== "disabled");
  const microphoneOptions = [
    { value: "", label: "Off" },
    ...devices.filter((device) => device.kind === "microphone").map((device) => ({ value: device.id, label: device.name, description: device.subtitle || (device.isDefault ? "System default" : undefined) })),
  ];
  const systemOptions = [
    { value: "", label: "Off" },
    ...devices.filter((device) => device.kind === "system").map((device) => ({ value: device.id, label: device.name, description: device.subtitle || (device.isDefault ? "System default" : undefined) })),
  ];

  useEffect(() => {
    if (!open) {
      setOpenAiKey("");
      setShowOpenAiKey(false);
      setEraseProfilesConfirmOpen(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !initialSection) return;
    const frame = window.requestAnimationFrame(() => {
      contentRef.current
        ?.querySelector(`[data-settings-section="${initialSection}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, initialSection]);

  async function saveOpenAiKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await setApiKey(openAiKey.trim())) {
      setOpenAiKey("");
      setShowOpenAiKey(false);
    }
  }

  return (
    <>
      <Modal open={open} title="Settings" onClose={onClose} initialFocus={initialFocus}>
        <div className="settings-content" ref={contentRef}>
          <section className="settings-section" data-settings-section="transcription" aria-labelledby="settings-models">
            <h3 id="settings-models">Models</h3>
            <SpeechModelsPanel />
          </section>

          <section className="settings-section" data-settings-section="voice" aria-labelledby="settings-fingerprinting">
            <h3 id="settings-fingerprinting">Fingerprinting</h3>
            <p>Learns each person's voice and automatically labels them in recordings.</p>
            {localSpeaker || hasFingerprints ? (
              <div className="voice-settings-actions">
                {localSpeaker ? (
                  <label className="settings-toggle">
                    <input type="checkbox" checked={settings.preferLocalSpeakerForMicrophone} onChange={(event) => void updateSettings({ ...settings, preferLocalSpeakerForMicrophone: event.target.checked })} />
                    <span>Prefer {localSpeaker.fullName} for microphone-only speech</span>
                  </label>
                ) : null}
                {hasFingerprints ? (
                  <button className="danger-text-button" type="button" onClick={() => setEraseProfilesConfirmOpen(true)}>
                    <Trash2 size={14} /> Erase fingerprints
                  </button>
                ) : null}
              </div>
            ) : null}
          </section>

          <section className="settings-section" data-settings-section="text-model" aria-labelledby="settings-chat">
            <h3 id="settings-chat">Chat</h3>
            <p>Powers the chat window and polishes meeting transcripts.</p>
            <form className="api-key-form" onSubmit={(event) => void saveOpenAiKey(event)}>
              <div className="secret-input">
                <input
                  ref={openAiInputRef}
                  aria-label={settings.apiKeyConfigured ? "Replace OpenAI API key" : "OpenAI API key"}
                  autoComplete="off"
                  spellCheck={false}
                  type={showOpenAiKey ? "text" : "password"}
                  value={openAiKey}
                  onChange={(event) => setOpenAiKey(event.target.value)}
                  placeholder={settings.apiKeyConfigured ? "Replace saved OpenAI API key" : "OpenAI API key"}
                />
                <button type="button" onClick={() => setShowOpenAiKey((show) => !show)} aria-label={showOpenAiKey ? "Hide key" : "Show key"} title={showOpenAiKey ? "Hide key" : "Show key"}>
                  {showOpenAiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <button className="secondary-button" disabled={!openAiKey.trim() || busy}>Save key</button>
            </form>
            {openAiKey.trim() && !settings.apiKeyConfigured ? <small className="key-sharing-note">Chat and polishing send transcript text to OpenAI.</small> : null}
          </section>

          <section className="settings-section" data-settings-section="capture" aria-labelledby="settings-recording">
            <h3 id="settings-recording">Recording defaults</h3>
            <div className="settings-grid">
              <label>
                <span>Microphone</span>
                <CustomSelect ariaLabel="Microphone" maxVisibleOptions={4}
                  value={settings.captureMicrophone ? settings.microphoneDeviceId || microphoneOptions[1]?.value || "" : ""}
                  options={microphoneOptions}
                  onChange={(value) => void updateSettings({ ...settings, captureMicrophone: Boolean(value), microphoneDeviceId: value || settings.microphoneDeviceId })}
                />
              </label>
              <label>
                <span>System audio</span>
                <CustomSelect ariaLabel="System audio" maxVisibleOptions={4}
                  value={settings.captureSystem ? settings.systemDeviceId || systemOptions[1]?.value || "" : ""}
                  options={systemOptions}
                  onChange={(value) => void updateSettings({ ...settings, captureSystem: Boolean(value), systemDeviceId: value || settings.systemDeviceId })}
                />
              </label>
            </div>
          </section>

          <section className="settings-section settings-row" data-settings-section="appearance" aria-labelledby="settings-appearance">
            <h3 id="settings-appearance">Appearance</h3>
            <div className="theme-select">
              <CustomSelect compact ariaLabel="Appearance" value={settings.theme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(value) => void updateSettings({ ...settings, theme: value as "light" | "dark" | "system" })} />
            </div>
          </section>

          <section className="settings-section settings-row" data-settings-section="diagnostics" aria-labelledby="settings-diagnostics">
            <h3 id="settings-diagnostics">Diagnostics</h3>
            <button className="secondary-button" type="button" onClick={() => void openDiagnostics()}><FileText size={15} /> Open log</button>
          </section>
        </div>
      </Modal>

      <Modal open={eraseProfilesConfirmOpen} title="Erase all fingerprints?" onClose={() => setEraseProfilesConfirmOpen(false)} size="small">
        <div className="confirmation-content">
          <p>This permanently erases saved fingerprints and turns off automatic labeling for those people.</p>
          <div className="dialog-actions">
            <button autoFocus className="secondary-button" onClick={() => setEraseProfilesConfirmOpen(false)}>Cancel</button>
            <button className="danger-button" disabled={busy} onClick={() => void eraseAllVoiceProfiles().then((succeeded) => { if (succeeded) setEraseProfilesConfirmOpen(false); })}>Erase fingerprints</button>
          </div>
        </div>
      </Modal>
    </>
  );
}
