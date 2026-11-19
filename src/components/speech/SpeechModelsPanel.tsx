import { AudioLines, Check, Fingerprint, UsersRound, type LucideIcon } from "lucide-react";
import type { SpeechModel } from "../../domain/models";
import { formatBytes } from "../../lib/speechModels";
import { useWorkspace } from "../../store/workspace";

const modelIcons: Record<string, LucideIcon> = {
  "nemotron-3-diarization": UsersRound,
  "wespeaker-resnet34-lm": Fingerprint,
};

export function ModelList({ models, setup = false, showProgress = false }: {
  models: SpeechModel[];
  setup?: boolean;
  showProgress?: boolean;
}) {
  return (
    <ul className="speech-model-list" aria-label="Models">
      {models.map((model) => {
        const Icon = modelIcons[model.id] ?? AudioLines;
        const fraction = model.downloadedBytes / model.sizeBytes;
        const verifying = model.state === "verifying";
        const failed = model.state === "failed";
        const progress = showProgress && !model.installed;
        let detail = formatBytes(model.sizeBytes);
        if (progress) detail = failed ? "Failed" : verifying ? "Verifying" : `${Math.min(99, Math.floor(fraction * 100))}%`;
        return (
          <li key={model.id} className={failed ? "model-failed" : undefined}>
            <span className="speech-model-mark" aria-hidden="true"><Icon size={16} /></span>
            <div className="speech-model-name">
              <strong>{model.role}</strong>
              <small>{model.name}{setup ? "" : ` · ${model.licence}`}</small>
            </div>
            <span className="speech-model-size">
              {setup && model.installed ? <><Check size={14} /> Installed</> : detail}
            </span>
            {progress && <ProgressBar fraction={fraction} label={`${model.role} download`} />}
          </li>
        );
      })}
    </ul>
  );
}

export function SpeechModelsPanel() {
  const models = useWorkspace((state) => state.speechModels?.models);
  return models ? <div className="speech-models"><ModelList models={models} /></div> : null;
}

export function ProgressBar({ fraction, label }: { fraction: number; label: string }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  return (
    <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(clamped * 100)}>
      <span className="progress-fill" style={{ transform: `scaleX(${clamped})` }} />
    </div>
  );
}
