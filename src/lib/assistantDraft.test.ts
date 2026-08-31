// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { readAssistantDraft, writeAssistantDraft } from "./assistantDraft";

const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, value: string) => entries.set(key, value),
  removeItem: (key: string) => entries.delete(key),
};

describe("assistant drafts", () => {
  beforeEach(() => {
    entries.clear();
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  });

  it("keeps unsent text isolated by meeting", () => {
    writeAssistantDraft("meeting-1", "First question");
    writeAssistantDraft("meeting-2", "Second question");

    expect(readAssistantDraft("meeting-1")).toBe("First question");
    expect(readAssistantDraft("meeting-2")).toBe("Second question");
  });

  it("removes persisted text after the draft is cleared", () => {
    writeAssistantDraft("meeting-1", "Question");
    writeAssistantDraft("meeting-1", "");

    expect(readAssistantDraft("meeting-1")).toBe("");
  });
});
