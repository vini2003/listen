import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { createContext, useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { EASE_STANDARD } from "../../lib/motion";

/** True while the nearest enclosing Modal is open; stays reachable inside AnimatePresence's frozen exit subtree. */
export const ModalOpenContext = createContext(true);

/* Stacked dialogs each listen for Escape on window; only the topmost may close. */
const openModalStack: symbol[] = [];

interface ModalProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  size?: "small" | "medium" | "large";
  dismissible?: boolean;
  initialFocus?: { readonly current: HTMLElement | null };
}

export function Modal({ open, title, description, children, onClose, size = "medium", dismissible = true, initialFocus }: ModalProps) {
  const titleId = useId();
  const descriptionId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const stackIdRef = useRef<symbol | null>(null);
  if (stackIdRef.current === null) stackIdRef.current = Symbol("modal");
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const stackId = stackIdRef.current!;
    openModalStack.push(stackId);
    returnFocusRef.current = document.activeElement as HTMLElement | null;

    function closeOnEscape(event: KeyboardEvent): void {
      if (openModalStack[openModalStack.length - 1] !== stackId) return;
      if (dismissible && event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    const focusFrame = window.requestAnimationFrame(() => {
      if (cardRef.current?.contains(document.activeElement)) return;
      (initialFocus?.current ?? firstFocusable(cardRef.current))?.focus();
    });
    return () => {
      const stackIndex = openModalStack.indexOf(stackId);
      if (stackIndex >= 0) openModalStack.splice(stackIndex, 1);
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", closeOnEscape);
      const returnTarget = returnFocusRef.current;
      window.requestAnimationFrame(() => returnTarget?.isConnected && returnTarget.focus());
    };
  }, [open, dismissible]);

  function trapFocus(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== "Tab") return;
    const focusable = focusableElements(cardRef.current);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <ModalOpenContext.Provider value={open}>
      <AnimatePresence>
        {open ? (
        <motion.div
          className="modal-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, pointerEvents: "auto" as const }}
          exit={{ opacity: 0, pointerEvents: "none" as const }}
          transition={{ duration: 0.16, ease: EASE_STANDARD }}
          onMouseDown={(event) => dismissible && event.currentTarget === event.target && onClose()}
        >
          <motion.section
            ref={cardRef}
            className={`modal-card modal-${size}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            onKeyDown={trapFocus}
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.16, ease: EASE_STANDARD }}
          >
            <header className="modal-header">
              <div>
                <h2 id={titleId}>{title}</h2>
                {description ? <p id={descriptionId}>{description}</p> : null}
              </div>
              {dismissible ? <button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button> : null}
            </header>
            {children}
          </motion.section>
        </motion.div>
        ) : null}
      </AnimatePresence>
    </ModalOpenContext.Provider>
  );
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true");
}

function firstFocusable(root: HTMLElement | null): HTMLElement | undefined {
  return focusableElements(root)[0];
}
