const SAMPLE_RATE = 16_000;

/* Mirrors MAX_PLAYBACK_MS in src-tauri/src/speech_audio.rs. */
export const MAX_PLAYBACK_MS = 5 * 60_000;

/**
 * Synthesizes a faint 220 Hz tone as a 16 kHz mono PCM WAV data URL so the
 * browser preview can exercise the real playback state machine.
 */
export function silentWavDataUrl(durationMs: number): string {
  const clampedMs = Math.max(0, Math.min(durationMs, MAX_PLAYBACK_MS));
  const sampleCount = Math.max(1, Math.round((clampedMs / 1000) * SAMPLE_RATE));
  const dataLength = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE) * 0.02;
    view.setInt16(44 + index * 2, Math.round(sample * 32767), true);
  }

  return `data:audio/wav;base64,${base64FromBytes(new Uint8Array(buffer))}`;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
