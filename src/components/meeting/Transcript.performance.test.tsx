// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Meeting, TranscriptSegment } from "../../domain/models";
import type { MeetingPlayback } from "../../hooks/useMeetingPlayback";
import { useWorkspace } from "../../store/workspace";
import { Transcript } from "./Transcript";

const { rowRender } = vi.hoisted(() => ({ rowRender: vi.fn() }));
vi.mock("../../services/desktop", () => ({ desktop: {} }));
vi.mock("../ui/Avatar", () => ({ Avatar: () => { rowRender(); return null; } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const meeting: Meeting = {
  id: "performance-meeting", title: "Long meeting", projectId: null, folderId: null,
  position: 0, status: "ready", createdAt: "2026-01-01", startedAt: null,
  endedAt: null, durationMs: 10000000, audioDirectory: "/synthetic", errorMessage: null,
};
function setup(count: number) {
  const segments: TranscriptSegment[] = Array.from({ length: count }, (_, i) => ({
    id: `segment-${i}`, meetingId: meeting.id, speakerLabel: `speaker-${i % 2}`,
    personId: null, identitySource: null, identityConfidence: null,
    startMs: i * 1000, endMs: (i + 1) * 1000, text: `Passage ${i}`,
  }));
  useWorkspace.setState({ segments, people: [], segmentsLoading: false });
  const transport: MeetingPlayback = {
    available: true, status: "ready", playing: true, currentMs: 500,
    durationMs: meeting.durationMs, toggle: vi.fn(), seek: vi.fn(), pause: vi.fn(),
  };
  const props = { meeting, transport, onOpenPeople: vi.fn(), onOpenSettings: vi.fn() };
  return { props, ...render(<Transcript {...props} />) };
}

it("rerenders only the old and new active rows in a 1,000-row transcript", () => {
  const { props, rerender } = setup(1000);
  expect(rowRender).toHaveBeenCalledTimes(1000);
  rowRender.mockClear();
  rerender(<Transcript {...props} transport={{ ...props.transport, currentMs: 1500 }} />);
  expect(rowRender).toHaveBeenCalledTimes(2);
  rowRender.mockClear();
  rerender(<Transcript {...props} transport={{ ...props.transport, currentMs: 1700 }} />);
  expect(rowRender).not.toHaveBeenCalled();
  act(() => useWorkspace.setState({ chatBusy: true }));
  expect(rowRender).not.toHaveBeenCalled();
  act(() => useWorkspace.setState({ chatBusy: false }));
});

it("memoized timestamp actions use the latest committed playback callback", () => {
  const { props, rerender } = setup(2);
  const seek = vi.fn();
  rerender(<Transcript {...props} transport={{ ...props.transport, seek }} />);
  fireEvent.click(screen.getAllByTitle("Play from here")[1]);
  expect(seek).toHaveBeenCalledWith(1000);
  expect(props.transport.seek).not.toHaveBeenCalled();
});
