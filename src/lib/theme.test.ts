// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, resolveTheme, watchTheme } from "./theme";

type ChangeListener = (event: MediaQueryListEvent) => void;

function stubMatchMedia(initialDark: boolean) {
  let matches = initialDark;
  const listeners = new Set<ChangeListener>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: (_type: string, listener: ChangeListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: ChangeListener) => listeners.delete(listener),
  }));
  return {
    listeners,
    setDark(next: boolean) {
      matches = next;
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  document.querySelector('meta[name="theme-color"]')?.remove();
});

describe("resolveTheme", () => {
  it("passes explicit preferences through", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("resolves system from the OS scheme", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("applyTheme", () => {
  it("sets the resolved theme and theme-color meta", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.append(meta);
    stubMatchMedia(true);

    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(meta.getAttribute("content")).toBe("#171716");

    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(meta.getAttribute("content")).toBe("#f4f4f1");
  });
});

describe("watchTheme", () => {
  it("follows OS scheme changes for system and cleans up", () => {
    const media = stubMatchMedia(false);
    const stop = watchTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");

    media.setDark(true);
    expect(document.documentElement.dataset.theme).toBe("dark");

    stop();
    expect(media.listeners.size).toBe(0);
  });

  it("ignores OS scheme changes for explicit preferences", () => {
    const media = stubMatchMedia(true);
    const stop = watchTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(media.listeners.size).toBe(0);

    media.setDark(false);
    expect(document.documentElement.dataset.theme).toBe("light");
    stop();
  });
});
