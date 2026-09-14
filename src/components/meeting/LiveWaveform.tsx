import { useEffect, useRef } from "react";

export interface LevelFrame {
  id: number;
  microphone: number;
  system: number;
}

export const WAVEFORM_FRAME_COUNT = 30;
export const LEVEL_POLL_INTERVAL_MS = 80;

export function LiveWaveform({ frames, paused }: {
  frames: LevelFrame[];
  paused: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef(frames);
  const outgoingFrameRef = useRef<LevelFrame | null>(null);
  const frameStartedAtRef = useRef(performance.now());
  const pausedRef = useRef(paused);
  const requestDrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const previousFrames = framesRef.current;
    const previousLatest = previousFrames[previousFrames.length - 1]?.id;
    const nextLatest = frames[frames.length - 1]?.id;
    if (previousLatest !== nextLatest) {
      outgoingFrameRef.current = previousFrames[0] ?? null;
      frameStartedAtRef.current = performance.now();
    }
    framesRef.current = frames;
    requestDrawRef.current();
  }, [frames]);

  useEffect(() => {
    pausedRef.current = paused;
    requestDrawRef.current();
  }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let pixelRatio = 1;

    const resize = (): void => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const nextWidth = Math.max(1, Math.round(width * pixelRatio));
      const nextHeight = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== nextWidth) canvas.width = nextWidth;
      if (canvas.height !== nextHeight) canvas.height = nextHeight;
      requestDrawRef.current();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const draw = (now: number): void => {
      animationFrame = 0;
      if (document.visibilityState === "hidden") return;
      const context = canvas.getContext("2d");
      if (!context || width <= 0 || height <= 0) {
        return;
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const currentFrames = framesRef.current;
      const step = width / Math.max(1, WAVEFORM_FRAME_COUNT);
      const progress = pausedRef.current
        ? 1
        : Math.min(1, Math.max(0, (now - frameStartedAtRef.current) / LEVEL_POLL_INTERVAL_MS));

      const outgoing = outgoingFrameRef.current;
      if (outgoing && progress < 1) {
        drawWaveformFrame(context, outgoing, (progress - 1) * step, step, width, height, 1 - progress);
      }
      currentFrames.forEach((frame, index) => {
        const x = (index + 1 - progress) * step;
        drawWaveformFrame(context, frame, x, step, width, height, 1);
      });

      if (!pausedRef.current && progress < 1) requestDrawRef.current();
    };

    const requestDraw = (): void => {
      if (!animationFrame && document.visibilityState !== "hidden") {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };
    requestDrawRef.current = requestDraw;
    const visibilityChanged = (): void => {
      if (document.visibilityState === "hidden") {
        window.cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      } else requestDraw();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    resize();
    requestDraw();
    return () => {
      requestDrawRef.current = () => {};
      document.removeEventListener("visibilitychange", visibilityChanged);
      resizeObserver.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div className={`live-waveform ${paused ? "is-paused" : ""}`} aria-hidden="true">
      <canvas className="live-waveform-canvas" ref={canvasRef} />
    </div>
  );
}

function drawWaveformFrame(
  context: CanvasRenderingContext2D,
  frame: LevelFrame,
  x: number,
  step: number,
  width: number,
  height: number,
  opacity: number,
): void {
  if (x < -step || x > width) return;
  const contour = 0.72 + Math.sin(frame.id * 1.87) * 0.18 + Math.sin(frame.id * 0.47) * 0.1;
  const edgeFade = Math.min(1, Math.max(0, x / Math.max(1, width * 0.2)));
  const centerX = x + step / 2;
  /* keep in sync with --drop-target / --recording in styles.css */
  drawWaveformBar(context, centerX, frame.system * contour, height, 3, `rgba(110, 140, 240, ${0.42 * opacity * edgeFade})`);
  drawWaveformBar(context, centerX, frame.microphone * contour, height, 2, `rgba(210, 76, 64, ${opacity * edgeFade})`);
}

function drawWaveformBar(
  context: CanvasRenderingContext2D,
  x: number,
  level: number,
  height: number,
  width: number,
  color: string,
): void {
  const barHeight = Math.max(2, level * (height - 10));
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = "round";
  context.moveTo(x, height / 2 - barHeight / 2);
  context.lineTo(x, height / 2 + barHeight / 2);
  context.stroke();
}
