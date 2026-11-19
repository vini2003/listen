// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktop } from "../../services/desktop";
import { useWorkspace } from "../../store/workspace";
import { Sidebar } from "./Sidebar";

vi.mock("../../services/desktop", () => ({
  desktop: { reorderProjects: vi.fn(async () => {}) },
}));

const createdAt = "2026-01-01";
const initialState = useWorkspace.getState();

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no CSS.escape. The fixture uses simple CSS identifiers.
  vi.stubGlobal("CSS", { ...globalThis.CSS, escape: (id: string) => id });
  useWorkspace.setState({
    projects: ["Alpha", "Bravo", "Charlie"].map((name, position) => ({ id: name.toLowerCase(), name, position, createdAt })),
    folders: [{ id: "notes", name: "Notes", projectId: "bravo", parentId: null, position: 0, createdAt }],
    meetings: [],
  });
  render(<Sidebar onCreateProject={vi.fn()} onCreateMeeting={vi.fn()} onOpenPeople={vi.fn()} onOpenSettings={vi.fn()} />);
});

afterEach(() => {
  cleanup();
  useWorkspace.setState(initialState);
  vi.unstubAllGlobals();
});

it("moves a collapsed project by keyboard and keeps the same heading focused", async () => {
  const bravo = screen.getByRole("button", { name: "Bravo" });
  bravo.focus();
  fireEvent.keyDown(bravo, { key: "ArrowLeft" });
  expect(bravo).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Notes")).toBeNull();

  const moveUp = { key: "ArrowUp", altKey: true, shiftKey: true };
  fireEvent.keyDown(bravo, { ...moveUp, ctrlKey: true });
  fireEvent.keyDown(bravo, { ...moveUp, metaKey: true });
  expect(desktop.reorderProjects).not.toHaveBeenCalled();
  fireEvent.keyDown(bravo, moveUp);
  await waitFor(() => expect(desktop.reorderProjects).toHaveBeenCalledExactlyOnceWith(["bravo", "alpha", "charlie"]));
  expect(screen.getAllByRole("button", { name: /^(Alpha|Bravo|Charlie)$/ }).map((button) => button.textContent)).toEqual(["Bravo", "Alpha", "Charlie"]);
  expect(bravo).toHaveFocus();
  expect(bravo).toHaveAttribute("aria-expanded", "false");
  fireEvent.keyDown(bravo, moveUp);
  expect(desktop.reorderProjects).toHaveBeenCalledTimes(1);
});

it("moves from the options menu and disables moves beyond the first and last positions", async () => {
  fireEvent.click(screen.getByRole("button", { name: "Project options for Alpha" }));
  expect(screen.getByRole("menuitem", { name: "Move up" })).toBeDisabled();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Project options for Bravo" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
  await waitFor(() => expect(desktop.reorderProjects).toHaveBeenCalledExactlyOnceWith(["alpha", "charlie", "bravo"]));
  await waitFor(() => expect(screen.getByRole("button", { name: "Bravo" })).toHaveFocus());
  expect(screen.getByRole("button", { name: "Collapse Bravo" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Project options for Bravo" }));
  expect(screen.getByRole("menuitem", { name: "Move down" })).toBeDisabled();
});
