// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Meeting } from "../../domain/models";
import { useWorkspace } from "../../store/workspace";
import { MeetingChat } from "./MeetingChat";

const meeting: Meeting = {
  id: "standup", title: "Team standup", status: "ready", projectId: null, folderId: null,
  position: 0, createdAt: "2026-01-01", startedAt: null, endedAt: null,
  durationMs: 12000, audioDirectory: "/recording", errorMessage: null,
};
const original = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState({ loadChat: vi.fn().mockResolvedValue(undefined) });
  HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  useWorkspace.setState(original);
  localStorage.clear();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

it.each([undefined, 650])("keeps chat behind its launcher and returns focus when dismissed (max width %s)", async (maxWidePanelWidth) => {
  render(<MeetingChat meeting={meeting} maxWidePanelWidth={maxWidePanelWidth} onOpenSettings={vi.fn()} />);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add OpenAI key" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  const composer = screen.getByRole("textbox", { name: "Ask about this meeting" });
  expect(composer).toHaveFocus();
  expect(screen.getByRole("heading", { name: "Chat" })).toBeVisible();
  expect(screen.queryByText(meeting.title)).toBeNull();
  expect(screen.getByRole("button", { name: "Detach chat" }).textContent).toBe("");

  fireEvent.change(composer, { target: { value: "What was decided?" } });
  fireEvent.keyDown(composer, { key: "Escape" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Open chat" })).toHaveFocus());
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(screen.getByRole("textbox")).toHaveValue("What was decided?");
});
