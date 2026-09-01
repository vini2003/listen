import { Check, ChevronDown } from "lucide-react";
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalOpenContext } from "./Modal";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface CustomSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  compact?: boolean;
  maxVisibleOptions?: number;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  openAbove: boolean;
}

export function CustomSelect({ value, options, onChange, ariaLabel, compact = false, maxVisibleOptions = 6 }: CustomSelectProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modalOpen = useContext(ModalOpenContext);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex] ?? options[0];

  function measure(): void {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = Math.min(options.length, maxVisibleOptions) * 44 + 10;
    const roomBelow = window.innerHeight - rect.bottom;
    const openAbove = roomBelow < estimatedHeight + 12 && rect.top > roomBelow;
    setPosition({
      left: Math.min(rect.left, window.innerWidth - rect.width - 12),
      top: openAbove ? Math.max(12, rect.top - estimatedHeight - 7) : rect.bottom + 7,
      width: rect.width,
      openAbove,
    });
  }

  function choose(index: number): void {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function openMenu(): void {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, options.length, maxVisibleOptions]);

  useEffect(() => {
    if (!modalOpen) setOpen(false);
  }, [modalOpen]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    let last = triggerRef.current?.getBoundingClientRect();
    const follow = (): void => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect && last && (rect.top !== last.top || rect.left !== last.left || rect.width !== last.width || rect.bottom !== last.bottom)) measure();
      if (rect) last = rect;
      frame = window.requestAnimationFrame(follow);
    };
    frame = window.requestAnimationFrame(follow);
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function dismiss(event: PointerEvent): void {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    }

    function reposition(): void {
      measure();
    }

    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, options.length, maxVisibleOptions]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`custom-select-trigger ${compact ? "compact" : ""} ${open ? "open" : ""}`}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open ? `${listboxId}-option-${activeIndex}` : undefined}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) openMenu();
            else setActiveIndex((current) => cycleIndex(current, event.key === "ArrowDown" ? 1 : -1, options.length));
          }
          if (event.key === "Enter" || event.key === " ") {
            if (open) { event.preventDefault(); choose(activeIndex); }
          }
          if (event.key === "Home" && open) { event.preventDefault(); setActiveIndex(0); }
          if (event.key === "End" && open) { event.preventDefault(); setActiveIndex(Math.max(0, options.length - 1)); }
          if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); }
          if (event.key === "Tab" && open) setOpen(false);
        }}
      >
        <span>{selected?.label ?? "Select"}</span>
        <ChevronDown size={15} />
      </button>

      {open && position ? createPortal(
        <div
          ref={menuRef}
          id={listboxId}
          className={`custom-select-menu ${position.openAbove ? "open-above" : ""}`}
          role="listbox"
          aria-label={ariaLabel}
          style={{ left: position.left, top: position.top, width: position.width, maxHeight: Math.min(options.length, maxVisibleOptions) * 44 + 10 }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); }
          }}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              id={`${listboxId}-option-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              className={`${option.value === value ? "selected" : ""} ${index === activeIndex ? "active" : ""}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="custom-select-option-copy">
                <strong>{option.label}</strong>
                {option.description ? <small>{option.description}</small> : null}
              </span>
              {option.value === value ? <Check size={15} /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}

function cycleIndex(current: number, direction: number, length: number): number {
  if (length === 0) return 0;
  return (current + direction + length) % length;
}
