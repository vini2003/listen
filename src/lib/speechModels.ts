import type { SpeechModelsStatus, TranscriptionPhase } from "../domain/models";

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(bytes >= 10_000_000_000 ? 0 : 1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

export function isDownloading(status: SpeechModelsStatus | null): boolean {
  return status?.state === "downloading" || status?.state === "verifying";
}

const PHASE_LABELS: Record<TranscriptionPhase, string> = {
  queued: "Waiting for the current transcription",
  preparing: "Preparing audio",
  separating: "Separating speakers",
  transcribing: "Transcribing speech",
  identifying: "Recognising voices",
  polishing: "Polishing text",
};

export function phaseLabel(phase: TranscriptionPhase): string {
  return PHASE_LABELS[phase];
}
