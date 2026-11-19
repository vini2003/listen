// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Meeting } from "../../domain/models";
import { useWorkspace } from "../../store/workspace";
import { RecordingDock } from "./RecordingDock";

vi.mock("../../services/desktop", () => ({ desktop: {} }));

const initial = useWorkspace.getState();
const draft: Meeting = {
  id: "meeting", title: "Planning", projectId: null, folderId: null, position: 0,
  status: "draft", createdAt: "2026-01-01", startedAt: null, endedAt: null,
  durationMs: 0, audioDirectory: null, errorMessage: null,
};
const file = { path: "archive/Planning.mp4", name: "Planning.mp4" };

function setup(meeting = draft) {
  const pick = vi.fn().mockResolvedValue(file);
  const importMedia = vi.fn().mockResolvedValue(true);
  useWorkspace.setState({ meetings: [meeting], pickMeetingMedia: pick, importMeetingMedia: importMedia, mediaImport: null });
  render(<RecordingDock meeting={meeting} compact={meeting.durationMs > 0} />);
  return { pick, importMedia, trigger: screen.getByRole("button", { name: "Import audio or video" }) };
}

afterEach(() => { cleanup(); useWorkspace.setState(initial); });

it("imports a selected file directly into an empty meeting and ignores picker cancellation", async () => {
  const { pick, importMedia, trigger } = setup();
  pick.mockResolvedValueOnce(null);
  fireEvent.click(trigger);
  await waitFor(() => expect(trigger).toBeEnabled());
  expect(importMedia).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  await waitFor(() => expect(importMedia).toHaveBeenCalledWith(draft.id, file));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows the selected filename and requires confirmation before appending to saved audio", async () => {
  const { importMedia, trigger } = setup({ ...draft, status: "ready", durationMs: 30_000, audioDirectory: "recordings/meeting" });
  fireEvent.click(trigger);
  const prompt = await screen.findByRole("dialog", { name: "Append Planning.mp4?" });
  expect(prompt).toHaveTextContent("The file’s audio will play after this recording.");
  expect(importMedia).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("button", { name: "Append audio" }));
  expect(importMedia).toHaveBeenCalledExactlyOnceWith(draft.id, file);
});

it("blocks another import, shows progress, and prevents recording into the importing meeting", () => {
  const { trigger } = setup();
  act(() => useWorkspace.setState({ mediaImport: { meetingId: "other-meeting", progress: 0.2 } }));
  expect(trigger).toBeDisabled();
  const record = screen.getByRole("button", { name: "Start recording" });
  expect(record).toBeEnabled();
  act(() => useWorkspace.setState({ mediaImport: { meetingId: draft.id, progress: 0.25 } }));
  expect(screen.getByRole("button", { name: "Importing 25%" })).toBeDisabled();
  expect(record).toBeDisabled();
});
