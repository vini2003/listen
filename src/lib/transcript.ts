import type { MeetingStatus, TranscriptSegment } from "../domain/models";

const MAX_TURN_GAP_MS = 30_000;
const MAX_TURN_DURATION_MS = 5 * 60_000;

export type TranscriptStateKind =
  | "transcript"
  | "loading"
  | "recording"
  | "processing"
  | "failed"
  | "awaiting-key"
  | "ready-to-transcribe"
  | "empty";

export function transcriptStateFor(input: {
  status: MeetingStatus;
  durationMs: number;
  hasTranscript: boolean;
  segmentsLoading: boolean;
  pyannoteKeyConfigured: boolean;
}): TranscriptStateKind {
  if (input.hasTranscript) return "transcript";
  if (input.segmentsLoading) return "loading";
  if (input.status === "recording") return "recording";
  if (input.status === "processing") return "processing";
  if (input.status === "failed") return "failed";
  if (input.durationMs > 0) return input.pyannoteKeyConfigured ? "ready-to-transcribe" : "awaiting-key";
  return "empty";
}

export interface TranscriptTurn extends TranscriptSegment {
  sourceSegmentIds: string[];
}

export function mergeSequentialSegments(segments: TranscriptSegment[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const segment of segments) {
    const previous = turns.at(-1);
    const sameSpeaker = previous
      && previous.speakerLabel === segment.speakerLabel
      && previous.personId === segment.personId;
    const nearby = previous && segment.startMs - previous.endMs <= MAX_TURN_GAP_MS;
    const withinPlaybackLimit = previous
      && segment.endMs - previous.startMs <= MAX_TURN_DURATION_MS;
    if (sameSpeaker && nearby && withinPlaybackLimit) {
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      previous.text = joinText(previous.text, segment.text);
      previous.sourceSegmentIds.push(segment.id);
      // A turn mixing manual and auto segments counts as manual: the person
      // confirmed part of it, so no "labeled automatically" badge is shown.
      if (segment.identitySource === "manual" && previous.identitySource !== "manual") {
        previous.identitySource = "manual";
        previous.identityConfidence = null;
      }
      continue;
    }
    turns.push({ ...segment, sourceSegmentIds: [segment.id] });
  }
  return turns;
}

function joinText(left: string, right: string): string {
  const cleanLeft = left.trimEnd();
  const cleanRight = right.trimStart();
  if (!cleanLeft) return cleanRight;
  if (!cleanRight) return cleanLeft;
  return `${cleanLeft} ${cleanRight}`;
}
