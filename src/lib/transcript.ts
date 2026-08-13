import type { TranscriptSegment } from "../domain/models";

const MAX_TURN_GAP_MS = 30_000;
const MAX_TURN_DURATION_MS = 5 * 60_000;

export function mergeSequentialSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const turns: TranscriptSegment[] = [];
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
      continue;
    }
    turns.push({ ...segment });
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
