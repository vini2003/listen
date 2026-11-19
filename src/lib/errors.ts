const DEFAULT_MESSAGE = "Something went wrong. Please try again.";

export function friendlyError(error: unknown, fallback = DEFAULT_MESSAGE, context?: "media-import"): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const message = extractApiMessage(raw)
    .replace(/^OpenAI request failed:\s*/i, "")
    .replace(/^Speech processing failed:\s*/i, "")
    .replace(/^Model download failed:\s*/i, "")
    .replace(/^Audio error:\s*/i, "")
    .replace(/^Invalid request:\s*/i, "")
    .replace(/\s*Error ID [A-F0-9]{8}\.?(?=\s|$)/i, "")
    .trim();

  if (!message) return fallback;
  if (context === "media-import") return message;

  if (/corrupt|unsupported|invalid audio|audio file/i.test(message)) {
    return "No usable audio was found. Check the selected devices and try recording again.";
  }

  if (/\b401\b|invalid api key|incorrect api key|authentication/i.test(message)) {
    return "OpenAI rejected the API key. Replace it in Settings.";
  }

  if (/\b429\b|rate.?limit|quota/i.test(message)) {
    return "OpenAI’s request limit was reached. Try again later or check your account quota.";
  }

  if (/\b402\b|billing|credit|budget/i.test(message)) {
    return "Check your OpenAI account’s credits and spending limit.";
  }

  return message.length > 180 ? `${message.slice(0, 177).trimEnd()}…` : message;
}

export function diagnosticId(error: unknown): string | null {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return raw.match(/\bError ID ([A-F0-9]{8})\b/i)?.[1]?.toUpperCase() ?? null;
}

function extractApiMessage(raw: string): string {
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return raw;

  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === "string" ? parsed.error.message : raw;
  } catch {
    return raw;
  }
}
