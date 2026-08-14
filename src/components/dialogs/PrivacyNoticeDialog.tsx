import { Fingerprint, HardDrive, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "../../store/workspace";
import { Modal } from "../ui/Modal";

interface PrivacyNoticeDialogProps {
  open: boolean;
}

export function PrivacyNoticeDialog({ open }: PrivacyNoticeDialogProps) {
  const { acknowledgePrivacyNotice, busy } = useWorkspace();
  const [enableIdentity, setEnableIdentity] = useState(false);

  return (
    <Modal open={open} title="Your recordings, your choice" description="Choose how Listen may use voice identity. You can change this later in Settings." onClose={() => {}} size="medium" dismissible={false}>
      <div className="privacy-notice">
        <div className="privacy-point"><HardDrive size={18} /><div><strong>Saved on this device</strong><p>Your projects, transcripts, recordings, names, photos, and voice profiles remain in Listen's local app data.</p></div></div>
        <div className="privacy-point"><ShieldCheck size={18} /><div><strong>Audio is processed remotely</strong><p>When you transcribe or enroll a voice, selected audio and voice data are sent securely to your configured pyannote service. Its Media API may retain uploaded audio for up to 48 hours and job output for 24 hours; pyannote says it does not use this data to train models.</p></div></div>
        <label className="privacy-choice">
          <input type="checkbox" checked={enableIdentity} onChange={(event) => setEnableIdentity(event.target.checked)} />
          <Fingerprint size={19} />
          <span><strong>Enable voice identification</strong><small>Create biometric voice profiles only for people who have given permission. Listen will prefer Unknown whenever a match is not sufficiently confident.</small></span>
        </label>
        <p className="privacy-fine-print">Voice identification can be wrong and is not suitable for security decisions. Make sure every enrolled person understands and agrees to this use. You can withdraw permission and erase voice profiles at any time.</p>
        <div className="privacy-actions">
          <button className="secondary-button" disabled={busy} onClick={() => void acknowledgePrivacyNotice(false)}>Continue without voice identity</button>
          <button className="primary-button" disabled={!enableIdentity || busy} onClick={() => void acknowledgePrivacyNotice(true)}><ShieldCheck size={15} /> Enable and continue</button>
        </div>
      </div>
    </Modal>
  );
}
