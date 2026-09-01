import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../domain/models";
import { mergeSequentialSegments, transcriptStateFor } from "./transcript";

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
    expect(turns[0].sourceSegmentIds).toEqual(["one", "two"]);
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

describe("transcriptStateFor", () => {
  const base = {
    status: "ready" as const,
    durationMs: 10_000,
    hasTranscript: false,
    segmentsLoading: false,
    pyannoteKeyConfigured: true,
  };

  it("always renders an existing transcript", () => {
    expect(transcriptStateFor({ ...base, hasTranscript: true, status: "recording" })).toBe("transcript");
    expect(transcriptStateFor({ ...base, hasTranscript: true, status: "failed" })).toBe("transcript");
  });

  it("shows the quiet loading state while segments are being fetched", () => {
    expect(transcriptStateFor({ ...base, segmentsLoading: true })).toBe("loading");
  });

  it("distinguishes live, processing, and failed states", () => {
    expect(transcriptStateFor({ ...base, status: "recording" })).toBe("recording");
    expect(transcriptStateFor({ ...base, status: "processing" })).toBe("processing");
    expect(transcriptStateFor({ ...base, status: "failed" })).toBe("failed");
  });

  it("gates transcription on the pyannote key", () => {
    expect(transcriptStateFor(base)).toBe("ready-to-transcribe");
    expect(transcriptStateFor({ ...base, pyannoteKeyConfigured: false })).toBe("awaiting-key");
  });

  it("prompts to record when no audio exists", () => {
    expect(transcriptStateFor({ ...base, status: "draft", durationMs: 0 })).toBe("empty");
  });
});

describe("merged turn identity source", () => {
  it("treats a turn as manual when any merged segment was manually confirmed", () => {
    const auto = { ...segment("s1", "A", 0, "Hello"), personId: "p1", identitySource: "voiceprint" as const, identityConfidence: 91 };
    const manual = { ...segment("s2", "A", 2_000, "again"), personId: "p1", identitySource: "manual" as const };
    const [turn] = mergeSequentialSegments([auto, manual]);
    expect(turn.identitySource).toBe("manual");
    expect(turn.identityConfidence).toBeNull();
  });

  it("keeps the auto source when no segment is manual", () => {
    const first = { ...segment("s1", "A", 0, "Hello"), personId: "p1", identitySource: "voiceprint" as const, identityConfidence: 91 };
    const second = { ...segment("s2", "A", 2_000, "again"), personId: "p1", identitySource: "voiceprint" as const, identityConfidence: 84 };
    const [turn] = mergeSequentialSegments([first, second]);
    expect(turn.identitySource).toBe("voiceprint");
  });
});
