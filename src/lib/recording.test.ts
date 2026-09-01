import { describe, expect, it } from "vitest";
import { recordButtonState } from "./recording";

const draft = { id: "m1", status: "draft" as const, durationMs: 0, audioDirectory: null };
const ready = { id: "m1", status: "ready" as const, durationMs: 60_000, audioDirectory: "recordings/m1" };

describe("recordButtonState", () => {
  it("offers a plain start on meetings without audio", () => {
    expect(recordButtonState(draft, null, false)).toEqual({ kind: "start", label: "Start recording" });
  });

  it("stops the active recording from its own meeting", () => {
    expect(recordButtonState({ ...ready, status: "recording" }, { id: "m1", title: "First" }, true).kind).toBe("stop");
  });

  it("reports processing", () => {
    expect(recordButtonState({ ...ready, status: "processing" }, null, true).kind).toBe("processing");
  });

  it("blocks recording while another meeting records", () => {
    const state = recordButtonState(ready, { id: "other", title: "Standup" }, false);
    expect(state.kind).toBe("blocked");
    expect(state.label).toContain("Standup");
  });

  it("resumes with confirmation only when a transcript exists", () => {
    expect(recordButtonState(ready, null, true)).toMatchObject({ kind: "resume", confirm: true });
    expect(recordButtonState(ready, null, false)).toMatchObject({ kind: "resume", confirm: false });
  });

  it("treats audio-less failed meetings as a fresh start", () => {
    expect(recordButtonState({ ...draft, status: "failed" }, null, false).kind).toBe("start");
  });
});
