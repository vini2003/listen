export interface RecordingReference {
  meetingId: string;
  timeMs: number;
}

export function renderableChatContent(content: string, currentMeetingId: string): string {
  const marked = content.replace(
    /\[\[recording:([^|\]]+)\|(\d+)\|([^\]]+)\]\]/g,
    (_, meetingId: string, timeMs: string, label: string) =>
      `[${escapeMarkdownLabel(label)}](#listen-recording=${encodeURIComponent(meetingId)}&time=${timeMs})`,
  );
  return marked.replace(
    /\[([^\]\n]+?)\s+(\d{1,2}:\d{2}(?::\d{2})?)\](?!\()/g,
    (match, label: string, timestamp: string) => {
      const timeMs = timestampToMilliseconds(timestamp);
      if (timeMs === null) return match;
      return `[${escapeMarkdownLabel(`${label} ${timestamp}`)}](#listen-recording=${encodeURIComponent(currentMeetingId)}&time=${timeMs})`;
    },
  );
}

export function parseRecordingHref(href?: string): RecordingReference | null {
  if (!href?.startsWith("#listen-recording=")) return null;
  const parameters = new URLSearchParams(href.slice(1));
  const meetingId = parameters.get("listen-recording");
  const timeMs = Number(parameters.get("time"));
  if (!meetingId || !Number.isFinite(timeMs) || timeMs < 0) return null;
  return { meetingId, timeMs };
}

function timestampToMilliseconds(timestamp: string): number | null {
  const parts = timestamp.split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const seconds = parts.length === 3
    ? parts[0] * 3_600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
  return seconds * 1_000;
}

function escapeMarkdownLabel(label: string): string {
  return label.replace(/([\\\[\]])/g, "\\$1");
}
