import { describe, expect, it } from "vitest";
import { MAX_PLAYBACK_MS, silentWavDataUrl } from "./previewAudio";

function decode(dataUrl: string): Uint8Array {
  const base64 = dataUrl.replace("data:audio/wav;base64,", "");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function uint32At(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer).getUint32(offset, true);
}

describe("silentWavDataUrl", () => {
  it("produces a valid RIFF/WAVE header", () => {
    const bytes = decode(silentWavDataUrl(1_000));
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(ascii(bytes, 8, 4)).toBe("WAVE");
    expect(ascii(bytes, 36, 4)).toBe("data");
    expect(uint32At(bytes, 4)).toBe(bytes.length - 8);
  });

  it("sizes the data chunk from the duration at 16 kHz mono 16-bit", () => {
    const bytes = decode(silentWavDataUrl(1_000));
    expect(uint32At(bytes, 40)).toBe(16_000 * 2);
    expect(bytes.length).toBe(44 + 16_000 * 2);
  });

  it("caps clips at the backend playback limit", () => {
    const capped = decode(silentWavDataUrl(MAX_PLAYBACK_MS * 3));
    expect(uint32At(capped, 40)).toBe((MAX_PLAYBACK_MS / 1000) * 16_000 * 2);
  });

  it("never produces an empty data chunk", () => {
    const bytes = decode(silentWavDataUrl(0));
    expect(uint32At(bytes, 40)).toBeGreaterThan(0);
  });
});
