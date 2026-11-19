// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarPane } from "./SidebarPane";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

it("remembers the chosen sidebar width when a smaller window temporarily limits it", () => {
  vi.stubGlobal("innerWidth", 1180);
  const pane = <SidebarPane>Projects</SidebarPane>;
  const { unmount } = render(pane);
  let divider = screen.getByRole("separator", { name: "Resize Projects sidebar" });
  fireEvent.keyDown(divider, { key: "End" });
  const chosen = divider.getAttribute("aria-valuenow");
  expect(chosen).toBe(divider.getAttribute("aria-valuemax"));

  vi.stubGlobal("innerWidth", 820);
  fireEvent(window, new Event("resize"));
  expect(Number(divider.getAttribute("aria-valuenow"))).toBeLessThan(Number(chosen));
  unmount();

  vi.stubGlobal("innerWidth", 1180);
  render(pane);
  divider = screen.getByRole("separator", { name: "Resize Projects sidebar" });
  expect(divider).toHaveAttribute("aria-valuenow", chosen);
  fireEvent.doubleClick(divider);
  expect(divider).toHaveAttribute("aria-valuenow", "244");
});
