import { invoke, isTauri } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import type { ChatScope } from "../domain/models";

export const ASSISTANT_ATTACHED_EVENT = "listen://assistant-attached";
export const ASSISTANT_CLOSED_EVENT = "listen://assistant-closed";
export const ASSISTANT_NAVIGATE_EVENT = "listen://assistant-navigate";
export const ASSISTANT_REFERENCE_EVENT = "listen://assistant-reference";
export const CHAT_SETTINGS_EVENT = "listen://chat-settings";
export const CHAT_UPDATED_EVENT = "listen://chat-updated";

let previewAssistant: Window | null = null;
let previewMeeting: string | null = null;
let previewCloseTimer: number | null = null;

export interface AssistantReference {
  meetingId: string;
  timeMs: number;
}

export async function openAssistantWindow(meetingId: string): Promise<void> {
  if (isTauri()) {
    await invoke("open_assistant_window", { meetingId });
    return;
  }
  const url = new URL(window.location.href);
  url.searchParams.set("view", "assistant");
  url.searchParams.set("meetingId", meetingId);
  const opened = window.open(url, "listen-assistant", "popup,width=480,height=700");
  if (!opened) throw new Error("Chat window blocked");
  previewAssistant = opened;
  previewMeeting = meetingId;
  if (previewCloseTimer === null) {
    previewCloseTimer = window.setInterval(() => {
      if (!previewAssistant?.closed) return;
      previewAssistant = null;
      previewMeeting = null;
      window.clearInterval(previewCloseTimer!);
      previewCloseTimer = null;
      window.dispatchEvent(new CustomEvent(ASSISTANT_CLOSED_EVENT));
    }, 500);
  }
}

export async function attachedAssistantMeeting(): Promise<string | null> {
  if (!isTauri()) return previewAssistant && !previewAssistant.closed ? previewMeeting : null;
  return invoke("attached_assistant_meeting");
}

export async function focusAssistantWindow(): Promise<boolean> {
  if (!isTauri()) {
    if (!previewAssistant || previewAssistant.closed) return false;
    previewAssistant.focus();
    return true;
  }
  return invoke("focus_assistant_window");
}

export async function attachAssistantWindow(meetingId: string): Promise<void> {
  if (isTauri()) {
    await invoke("attach_assistant_window", { meetingId });
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return;
  }
  window.opener?.dispatchEvent(new CustomEvent(ASSISTANT_ATTACHED_EVENT, { detail: meetingId }));
  window.opener?.focus();
  window.close();
}

export async function openReferenceInMain(reference: AssistantReference): Promise<void> {
  if (isTauri()) {
    await invoke("focus_main_window_reference", {
      meetingId: reference.meetingId,
      timeMs: reference.timeMs,
    });
    return;
  }
  window.opener?.postMessage({ type: ASSISTANT_REFERENCE_EVENT, ...reference }, window.location.origin);
  window.opener?.focus();
}

export async function listenForAssistantEvent<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    const receive = (event: Event) => handler((event as CustomEvent<T>).detail);
    window.addEventListener(eventName, receive);
    return () => window.removeEventListener(eventName, receive);
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(eventName, (event) => handler(event.payload));
}

export function listenForBrowserReference(handler: (reference: AssistantReference) => void): () => void {
  function receive(event: MessageEvent): void {
    if (event.origin !== window.location.origin || event.data?.type !== ASSISTANT_REFERENCE_EVENT) return;
    handler({ meetingId: String(event.data.meetingId), timeMs: Number(event.data.timeMs) });
  }
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}

export function isMatchingChatScope(payload: ChatScope, scope: ChatScope): boolean {
  return payload.scopeType === scope.scopeType && payload.scopeId === scope.scopeId;
}

export async function openChatSettingsInMain(): Promise<void> {
  if (isTauri()) {
    await invoke("open_chat_settings");
    return;
  }
  if (!window.opener || window.opener.closed) throw new Error("Main window closed");
  window.opener.dispatchEvent(new CustomEvent(CHAT_SETTINGS_EVENT));
  window.opener.focus();
}
