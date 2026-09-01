import { describe, expect, it } from "vitest";
import { formatDuration, formatMeetingDate, getInitials } from "./format";

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

describe("formatMeetingDate", () => {
  it("shows only the time for a meeting from today", () => {
    const today = new Date();
    today.setHours(9, 30, 0, 0);
    expect(formatMeetingDate(today.toISOString())).toMatch(/9:30/);
  });

  it("shows month and day within the current year", () => {
    const date = new Date();
    date.setMonth(date.getMonth() === 0 ? 5 : 0, 15);
    const formatted = formatMeetingDate(date.toISOString());
    expect(formatted).toMatch(/15/);
    expect(formatted).not.toMatch(String(date.getFullYear()));
  });

  it("includes the year for older meetings", () => {
    expect(formatMeetingDate("2020-03-05T10:00:00Z")).toMatch(/2020/);
  });
});
