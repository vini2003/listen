import { describe, expect, it } from "vitest";
import { diagnosticId, friendlyError } from "./errors";

describe("friendlyError", () => {
  it("condenses legacy OpenAI audio errors", () => {
    const legacy = 'OpenAI returned 400 Bad Request: {"error":{"message":"Audio file might be corrupted or unsupported","type":"invalid_request_error"}}';

    expect(friendlyError(legacy)).toBe(
      "No usable audio was found. Check the selected devices and try recording again.",
    );
  });

  it("removes implementation prefixes", () => {
    expect(friendlyError("Audio error: The selected microphone is unavailable."))
      .toBe("The selected microphone is unavailable.");
  });

  it("uses a contextual fallback for an empty error", () => {
    expect(friendlyError(null, "Your audio is still saved locally."))
      .toBe("Your audio is still saved locally.");
  });

  it("extracts a final-transcription diagnostic ID", () => {
    expect(diagnosticId("OpenAI could not create this transcript. Error ID a1b2c3d4."))
      .toBe("A1B2C3D4");
  });

  it("keeps the diagnostic ID out of the readable message", () => {
    expect(friendlyError("OpenAI could not create this transcript. Error ID A1B2C3D4."))
      .toBe("OpenAI could not create this transcript.");
  });
});
