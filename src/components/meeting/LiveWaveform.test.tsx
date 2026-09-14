// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LiveWaveform } from "./LiveWaveform";

let queued: Map<number, FrameRequestCallback>;
let nextId: number;
let visibility: DocumentVisibilityState;
const clearRect = vi.fn();
const frames = [{ id: 1, microphone: 0.5, system: 0.2 }];
beforeEach(() => {
  queued = new Map(); nextId = 0; visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queued.set(++nextId, callback); return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { queued.delete(id); });
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 132, height: 40 } as DOMRect);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(), clearRect, beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); clearRect.mockClear(); });
function frame() {
  const callbacks = [...queued.values()]; queued.clear();
  act(() => callbacks.forEach((callback) => callback(performance.now() + 1000)));
}
it("draws once when paused, sleeps when interpolation completes, and cleans up", () => {
  const { rerender, unmount } = render(<LiveWaveform frames={frames} paused />);
  expect(queued.size).toBe(1); frame();
  expect(clearRect).toHaveBeenCalledTimes(1);
  expect(queued.size).toBe(0);
  rerender(<LiveWaveform frames={frames} paused={false} />);
  expect(queued.size).toBe(1); frame();
  expect(queued.size).toBe(0);
  rerender(<LiveWaveform frames={[{ ...frames[0], id: 2 }]} paused={false} />);
  expect(queued.size).toBe(1);
  unmount(); expect(queued.size).toBe(0);
});
it("does not schedule hidden draws and wakes when visible again", () => {
  const { rerender } = render(<LiveWaveform frames={frames} paused={false} />);
  visibility = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(queued.size).toBe(0);
  rerender(<LiveWaveform frames={[{ ...frames[0], id: 2 }]} paused={false} />);
  expect(queued.size).toBe(0);
  visibility = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(queued.size).toBe(1); frame();
  expect(clearRect).toHaveBeenCalledTimes(1);
});
