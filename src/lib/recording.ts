import type { Meeting } from "../domain/models";

export type RecordButtonState =
  | { kind: "stop"; label: string }
  | { kind: "processing"; label: string }
  | { kind: "start"; label: string }
  | { kind: "resume"; label: string; confirm: boolean }
  | { kind: "blocked"; label: string };

export function recordButtonState(
  meeting: Pick<Meeting, "id" | "status" | "durationMs" | "audioDirectory">,
  activeRecording: { id: string; title: string } | null,
  hasTranscript: boolean,
): RecordButtonState {
  if (meeting.status === "recording") return { kind: "stop", label: "Stop recording" };
  if (meeting.status === "processing") return { kind: "processing", label: "Transcribing recording" };
  if (activeRecording && activeRecording.id !== meeting.id) {
    return { kind: "blocked", label: `Recording “${activeRecording.title}” — stop it before starting another` };
  }
  if (meeting.durationMs > 0 && meeting.audioDirectory) {
    return { kind: "resume", label: "Resume recording — new audio is added to this meeting", confirm: hasTranscript };
  }
  return { kind: "start", label: "Start recording" };
}
