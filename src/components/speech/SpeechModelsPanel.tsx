import { useShallow } from "zustand/react/shallow";
import { CheckCircle2, Download, HardDrive, RotateCcw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { downloadFraction, formatBytes, isDownloading } from "../../lib/speechModels";
import { useWorkspace } from "../../store/workspace";
import { Modal } from "../ui/Modal";

/** Installed-model list with download, progress, retry and removal, for Settings. */
export function SpeechModelsPanel() {
  const { speechModels, downloadSpeechModels, cancelSpeechModelsDownload, removeSpeechModels, busy } = useWorkspace(useShallow((state) => ({
    speechModels: state.speechModels,
    downloadSpeechModels: state.downloadSpeechModels,
    cancelSpeechModelsDownload: state.cancelSpeechModelsDownload,
    removeSpeechModels: state.removeSpeechModels,
    busy: state.busy,
  })));
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  if (!speechModels) return null;
  const downloading = isDownloading(speechModels);
  const ready = speechModels.state === "ready";

  return (
    <div className="speech-models">
      <ul className="speech-model-list">
        {speechModels.models.map((model) => (
          <li key={model.id}>
            <span className={`speech-model-mark ${model.installed ? "installed" : ""}`} aria-hidden="true">
              {model.installed ? <CheckCircle2 size={15} /> : <HardDrive size={14} />}
            </span>
            <div>
              <strong>{model.role}</strong>
              <small>{model.name} · {model.licence}</small>
            </div>
            <span className="speech-model-size">{formatBytes(model.sizeBytes)}</span>
          </li>
        ))}
      </ul>

      {downloading ? (
        <DownloadProgress onCancel={() => void cancelSpeechModelsDownload()} />
      ) : (
        <div className="speech-models-footer">
          {ready ? (
            <>
              <span className="speech-models-summary">{formatBytes(speechModels.totalBytes)} on this computer</span>
              <button className="danger-text-button" type="button" disabled={busy} onClick={() => setRemoveConfirmOpen(true)}><Trash2 size={14} /> Remove models</button>
            </>
          ) : (
            <>
              <span className={`speech-models-summary ${speechModels.error ? "error" : ""}`} role={speechModels.error ? "alert" : undefined}>
                {speechModels.error
                  ? speechModels.error
                  : speechModels.downloadedBytes > 0
                    ? `${formatBytes(speechModels.downloadedBytes)} of ${formatBytes(speechModels.totalBytes)} installed`
                    : `One-time download from Hugging Face`}
              </span>
              <button className="primary-button" type="button" onClick={() => void downloadSpeechModels()}>
                {speechModels.error ? <RotateCcw size={15} /> : <Download size={15} />}
                {speechModels.error ? "Retry download" : speechModels.downloadedBytes > 0 ? "Finish download" : `Download ${formatBytes(speechModels.totalBytes - speechModels.downloadedBytes)}`}
              </button>
            </>
          )}
        </div>
      )}

      <Modal open={removeConfirmOpen} title="Remove the speech models?" onClose={() => setRemoveConfirmOpen(false)} size="small">
        <div className="confirmation-content">
          <p>This frees {formatBytes(speechModels.totalBytes)}. Recordings, transcripts and voice profiles stay. New recordings can't be transcribed until the models are downloaded again.</p>
          <div className="dialog-actions">
            <button autoFocus className="secondary-button" onClick={() => setRemoveConfirmOpen(false)}>Cancel</button>
            <button className="danger-button" disabled={busy} onClick={() => void removeSpeechModels().then((removed) => { if (removed) setRemoveConfirmOpen(false); })}><Trash2 size={15} /> Remove models</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Live bar for an in-flight model download. */
export function DownloadProgress({ onCancel }: { onCancel: () => void }) {
  const speechModels = useWorkspace((state) => state.speechModels);
  if (!speechModels) return null;
  const fraction = downloadFraction(speechModels);
  const verifying = speechModels.state === "verifying";
  return (
    <div className="speech-download">
      <div className="speech-download-text">
        <span>{verifying ? "Checking file integrity…" : `Downloading ${formatBytes(speechModels.downloadedBytes)} of ${formatBytes(speechModels.totalBytes)}`}</span>
        <span className="speech-download-percent">{Math.floor(fraction * 100)}%</span>
        <button type="button" className="icon-text-button" onClick={onCancel} aria-label="Cancel download"><X size={13} /> Cancel</button>
      </div>
      <ProgressBar fraction={fraction} label="Speech model download" />
      <small>You can keep working. A cancelled or interrupted download resumes where it stopped.</small>
    </div>
  );
}

export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const percent = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return (
    <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span className="progress-fill" style={{ transform: `scaleX(${Math.max(0, Math.min(1, fraction))})` }} />
    </div>
  );
}
