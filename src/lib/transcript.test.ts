import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../domain/models";
import { mergeSequentialSegments } from "./transcript";

function segment(id: string, speakerLabel: string, startMs: number, text: string): TranscriptSegment {
  return {
    id,
    meetingId: "meeting",
    speakerLabel,
    personId: null,
    identitySource: null,
    identityConfidence: null,
    startMs,
    endMs: startMs + 1_000,
    text,
  };
}

describe("mergeSequentialSegments", () => {
  it("renders nearby consecutive messages from one speaker as one turn", () => {
    const turns = mergeSequentialSegments([
      segment("one", "A", 0, "Hello."),
      segment("two", "A", 1_200, "How are you?"),
      segment("three", "B", 2_500, "Great."),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe("Hello. How are you?");
    expect(turns[0].endMs).toBe(2_200);
  });

  it("keeps long pauses as separate turns", () => {
    const turns = mergeSequentialSegments([
      segment("one", "A", 0, "Earlier."),
      segment("two", "A", 45_000, "Later."),
    ]);

    expect(turns).toHaveLength(2);
  });

  it("bounds merged turns so their local audio remains reviewable", () => {
    const segments = Array.from({ length: 12 }, (_, index) =>
      segment(String(index), "A", index * 29_000, `Line ${index}.`),
    );

    const turns = mergeSequentialSegments(segments);

    expect(turns.length).toBeGreaterThan(1);
    expect(turns.every((turn) => turn.endMs - turn.startMs <= 5 * 60_000)).toBe(true);
  });
});
