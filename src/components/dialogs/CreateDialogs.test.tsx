// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspace } from "../../store/workspace";
import { CreateMeetingDialog } from "./CreateDialogs";

const source = { name: "Team review.2025.mp4", path: "C:/Videos/Team review.2025.mp4" };
const pickMeetingMedia = vi.fn();
const importMeetingMedia = vi.fn();
const createMeeting = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspace.setState({ projects: [], busy: false, mediaImport: null, pickMeetingMedia, importMeetingMedia, createMeeting });
});
afterEach(cleanup);

it("uses the filename for the title and keeps the chosen file on a failed import", async () => {
  pickMeetingMedia.mockResolvedValue(source);
  importMeetingMedia.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const close = vi.fn();
  render(<CreateMeetingDialog open initialProjectId={null} onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Import audio or video…" }));
  await screen.findByDisplayValue("Team review.2025");
  fireEvent.click(screen.getByRole("button", { name: "Import meeting" }));
  await waitFor(() => expect(importMeetingMedia).toHaveBeenCalledWith({ title: "Team review.2025", projectId: null }, source));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Import meeting" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(createMeeting).not.toHaveBeenCalled();
});

it("keeps a hand-written title through file selection, picker cancellation and removal", async () => {
  pickMeetingMedia.mockResolvedValueOnce(source).mockResolvedValueOnce(null);
  createMeeting.mockResolvedValue(true);
  const close = vi.fn();
  render(<CreateMeetingDialog open initialProjectId={null} onClose={close} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Roadmap" } });
  fireEvent.click(screen.getByRole("button", { name: "Import audio or video…" }));
  fireEvent.click(await screen.findByRole("button", { name: source.name }));
  await waitFor(() => expect(pickMeetingMedia).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText("Title")).toHaveValue("Roadmap");
  fireEvent.click(screen.getByRole("button", { name: "Remove selected file" }));
  fireEvent.click(screen.getByRole("button", { name: "Create meeting" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(createMeeting).toHaveBeenCalledWith({ title: "Roadmap", projectId: null });
  expect(importMeetingMedia).not.toHaveBeenCalled();
});
