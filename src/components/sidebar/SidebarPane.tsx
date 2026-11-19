import { useEffect, useRef, useState, type ReactNode } from "react";

const MIN_WIDTH = 196;
const DEFAULT_WIDTH = 244;
const MAX_WIDTH = 480;
const STORAGE_KEY = "listen.sidebarWidth";

function widthLimit(): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 470));
}

function readWidth(): number {
  try {
    const width = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) return width;
  } catch { /* Preferences are optional. */ }
  return DEFAULT_WIDTH;
}

export function SidebarPane({ children }: { children: ReactNode }) {
  const [preferredWidth, setPreferredWidth] = useState(readWidth);
  const [maximum, setMaximum] = useState(widthLimit);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const width = Math.min(preferredWidth, maximum);

  useEffect(() => {
    const resize = () => setMaximum(widthLimit());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function resize(value: number, persist: boolean): void {
    const next = Math.max(MIN_WIDTH, Math.min(maximum, Math.round(value)));
    setPreferredWidth(next);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* Preferences are optional. */ }
    }
  }

  return (
    <aside className="sidebar" id="projects-sidebar" aria-label="Projects" style={{ width }}>
      {children}
      <div
        className="sidebar-divider"
        role="separator"
        aria-label="Resize Projects sidebar"
        aria-controls="projects-sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maximum}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        title="Resize sidebar · Double-click to reset"
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, width };
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.id === event.pointerId) resize(start.width + event.clientX - start.x, false);
        }}
        onPointerUp={(event) => {
          const start = drag.current;
          if (start?.id !== event.pointerId) return;
          resize(start.width + event.clientX - start.x, true);
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => resize(DEFAULT_WIDTH, true)}
        onKeyDown={(event) => {
          switch (event.key) {
            case "ArrowLeft": resize(width - 16, true); break;
            case "ArrowRight": resize(width + 16, true); break;
            case "Home": resize(MIN_WIDTH, true); break;
            case "End": resize(maximum, true); break;
            default: return;
          }
          event.preventDefault();
        }}
      />
    </aside>
  );
}
