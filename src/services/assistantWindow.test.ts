// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { ChatScope } from "../domain/models";
import {
  ASSISTANT_REFERENCE_EVENT,
  isMatchingChatScope,
  listenForBrowserReference,
} from "./assistantWindow";

describe("assistant window synchronization", () => {
  it("matches chat updates only to their exact scope", () => {
    const meetingScope: ChatScope = { scopeType: "meeting", scopeId: "meeting-1" };

    expect(isMatchingChatScope(meetingScope, meetingScope)).toBe(true);
    expect(isMatchingChatScope(
      { scopeType: "meeting", scopeId: "meeting-2" },
      meetingScope,
    )).toBe(false);
    expect(isMatchingChatScope(
      { scopeType: "project", scopeId: "meeting-1" },
      meetingScope,
    )).toBe(false);
  });

  it("accepts recording references only from the app origin and stops after cleanup", () => {
    const handler = vi.fn();
    const cleanup = listenForBrowserReference(handler);
    const reference = {
      type: ASSISTANT_REFERENCE_EVENT,
      meetingId: "meeting-1",
      timeMs: 42_000,
    };

    window.dispatchEvent(new MessageEvent("message", {
      data: reference,
      origin: window.location.origin,
    }));
    window.dispatchEvent(new MessageEvent("message", {
      data: reference,
      origin: "https://example.com",
    }));

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ meetingId: "meeting-1", timeMs: 42_000 });

    cleanup();
    window.dispatchEvent(new MessageEvent("message", {
      data: reference,
      origin: window.location.origin,
    }));
    expect(handler).toHaveBeenCalledOnce();
  });
});
