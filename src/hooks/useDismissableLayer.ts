import { useEffect, useRef, type RefObject } from "react";

export type DismissReason = "pointer" | "escape" | "blur";

export function useDismissableLayer<T extends HTMLElement>(
  open: boolean,
  onDismiss: (reason: DismissReason) => void,
  options?: { closeOnWindowBlur?: boolean },
): RefObject<T | null> {
  const layerRef = useRef<T>(null);
  const closeOnWindowBlur = options?.closeOnWindowBlur ?? false;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent): void {
      if (!layerRef.current?.contains(event.target as Node)) onDismiss("pointer");
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onDismiss("escape");
    }

    function handleWindowBlur(): void {
      onDismiss("blur");
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    if (closeOnWindowBlur) window.addEventListener("blur", handleWindowBlur);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      if (closeOnWindowBlur) window.removeEventListener("blur", handleWindowBlur);
    };
  }, [open, onDismiss, closeOnWindowBlur]);

  return layerRef;
}
