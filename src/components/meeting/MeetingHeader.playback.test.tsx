// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Meeting } from "../../domain/models";
import { useMeetingPlayback } from "../../hooks/useMeetingPlayback";
import { useWorkspace } from "../../store/workspace";
import { MeetingHeader } from "./MeetingHeader";

vi.mock("../../services/desktop", () => ({ desktop: {} }));

const meeting: Meeting = {
  id: "meeting", title: "Standup", projectId: null, folderId: null, position: 0,
  status: "ready", createdAt: "2026-01-01", startedAt: null, endedAt: null,
  durationMs: 30000, audioDirectory: "/recording", errorMessage: null,
};
const originalLoad = useWorkspace.getState().loadMeetingAudioUrl;

function Player({ item = meeting }: { item?: Meeting }) {
  const playback = useMeetingPlayback(item);
  return <MeetingHeader meeting={item} playback={playback} />;
}

function setup() {
  const audio = document.createElement("audio");
  let paused = true;
  let hasMetadata = false;
  Object.defineProperties(audio, {
    paused: { get: () => paused },
    duration: { get: () => hasMetadata ? 30 : NaN },
    readyState: { get: () => hasMetadata ? HTMLMediaElement.HAVE_METADATA : HTMLMediaElement.HAVE_NOTHING },
  });
  vi.spyOn(audio, "play").mockImplementation(async () => { paused = false; fireEvent.play(audio); });
  vi.spyOn(audio, "pause").mockImplementation(() => { paused = true; fireEvent.pause(audio); });
  vi.stubGlobal("Audio", vi.fn(function () { return audio; }));

  let finishExport!: (url: string) => void;
  const exportResult = new Promise<string>((resolve) => { finishExport = resolve; });
  const load = vi.fn(() => exportResult);
  useWorkspace.setState({ loadMeetingAudioUrl: load });
  const view = render(<Player />);
  const slider = screen.getByRole("slider", { name: "Seek recording" });
  function seek(ms: number) { fireEvent.change(slider, { target: { value: String(ms) } }); }
  async function finishLoading() {
    await act(async () => { finishExport("recording.wav"); });
    hasMetadata = true;
    fireEvent.loadedMetadata(audio);
  }
  return { ...view, audio, slider, load, seek, finishLoading };
}

afterEach(() => {
  cleanup();
  useWorkspace.setState({ loadMeetingAudioUrl: originalLoad });
  vi.unstubAllGlobals();
});

it("seeks before the first play and returns to exactly zero while paused", async () => {
  const { audio, slider, load, seek, finishLoading } = setup();
  seek(9500);
  expect(slider).toHaveAttribute("aria-valuetext", "0:09 of 0:30");
  expect(load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
  await finishLoading();
  expect(audio.currentTime).toBe(9.5);
  fireEvent.click(screen.getByRole("button", { name: "Pause playback" }));
  seek(0);
  fireEvent.timeUpdate(audio);
  expect(audio.currentTime).toBe(0);
  expect(audio.paused).toBe(true);
  expect(audio.play).toHaveBeenCalledTimes(1);
  expect(slider).toHaveValue("0");
  expect(screen.getByRole("button", { name: "Play recording" })).toBeEnabled();
});

it("keeps the latest seek during preparation and preserves active playback during further seeks", async () => {
  const { audio, slider, load, seek, finishLoading } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
  expect(slider).toBeEnabled();
  seek(15000);
  seek(8500);
  await finishLoading();
  expect(audio.currentTime).toBe(8.5);
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  expect(audio.currentTime).toBe(13.5);
  seek(0);
  expect(audio.currentTime).toBe(0);
  expect(audio.paused).toBe(false);
  expect(audio.play).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
});

it("discards a pending seek and play when switching recordings", async () => {
  const { audio, slider, seek, finishLoading, rerender } = setup();
  seek(17000);
  fireEvent.click(screen.getByRole("button", { name: "Play recording" }));
  rerender(<Player item={{ ...meeting, id: "another-meeting" }} />);
  await finishLoading();
  expect(audio.play).not.toHaveBeenCalled();
  expect(slider).toHaveValue("0");
});
