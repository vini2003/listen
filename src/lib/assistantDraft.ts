const PREFIX = "listen.askDraft.";

export function readAssistantDraft(meetingId: string): string {
  try {
    return window.localStorage.getItem(`${PREFIX}${meetingId}`) ?? "";
  } catch {
    return "";
  }
}

export function writeAssistantDraft(meetingId: string, draft: string): void {
  try {
    const key = `${PREFIX}${meetingId}`;
    if (draft) window.localStorage.setItem(key, draft);
    else window.localStorage.removeItem(key);
  } catch {
    // Draft persistence is a convenience; chat remains usable without it.
  }
}
