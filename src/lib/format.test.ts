import { describe, expect, it } from "vitest";
import { formatDuration, getInitials } from "./format";

describe("formatDuration", () => {
  it("formats short recordings", () => {
    expect(formatDuration(65_400)).toBe("1:05");
  });

  it("formats multi-hour recordings", () => {
    expect(formatDuration(7_445_000)).toBe("2:04:05");
  });

  it("does not expose negative durations", () => {
    expect(formatDuration(-200)).toBe("0:00");
  });
});

describe("getInitials", () => {
  it("uses the first two words", () => {
    expect(getInitials("Ben James Carter")).toBe("BJ");
  });
});
