import { describe, expect, it } from "vitest";
import { shortcutAria, shortcutLabel, usesMetaModifier } from "./shortcuts";

describe("shortcuts", () => {
  it("uses platform-appropriate primary modifiers", () => {
    expect(usesMetaModifier("MacIntel")).toBe(true);
    expect(usesMetaModifier("Win32")).toBe(false);
  });

  it("formats visible shortcut labels", () => {
    expect(shortcutLabel("n", {}, "Win32")).toBe("Ctrl+N");
    expect(shortcutLabel("n", { shift: true }, "MacIntel")).toBe("⇧⌘N");
  });

  it("formats aria-keyshortcuts values", () => {
    expect(shortcutAria("n", { shift: true }, "Linux")).toBe("Control+Shift+N");
    expect(shortcutAria(",", {}, "MacIntel")).toBe("Meta+,");
  });
});
