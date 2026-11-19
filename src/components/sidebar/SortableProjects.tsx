import { DndContext, PointerSensor, getClientRect, useSensor, useSensors, type Announcements, type CollisionDetection, type Modifier, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS as transforms } from "@dnd-kit/utilities";
import { useEffect, useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import type { Project } from "../../domain/models";

const slide = { duration: 200, easing: "ease" };

// A section includes its expanded folders and meetings. Its leading edge has
// to cross the middle of the next section before that section moves aside.
type SectionRect = Pick<DOMRect, "top" | "height">;
function projectAtEdge(id: UniqueIdentifier, top: number, height: number, rects: ReadonlyMap<UniqueIdentifier, SectionRect>) {
  const source = rects.get(id);
  if (!source) return id;
  const up = top < source.top;
  let target = id;
  let targetTop = source.top;
  for (const [candidate, rect] of rects) {
    const middle = rect.top + rect.height / 2;
    const crossed = up
      ? rect.top < targetTop && top < middle
      : rect.top > targetTop && top + height > middle;
    if (crossed) {
      target = candidate;
      targetTop = rect.top;
    }
  }
  return target;
}

export const findProjectTarget: CollisionDetection = ({ active, collisionRect, droppableRects }) => {
  return [{ id: projectAtEdge(active.id, collisionRect.top, collisionRect.height, droppableRects) }];
};

type ProjectListProps = {
  projects: Project[];
  onPickUp: () => void;
  onMove: (from: string, to: string) => void;
  children: ReactNode;
};

export function SortableProjects({ projects, onPickUp, onMove, children }: ProjectListProps) {
  const list = useRef<HTMLDivElement>(null);
  const lifted = useRef<{
    node: HTMLElement; pointerId: number; grabOffset: number; releaseY: number | null;
    min: number; max: number; scroll: number;
  } | null>(null);
  useEffect(() => {
    function rememberRelease(event: PointerEvent): void {
      const drag = lifted.current;
      if (drag?.pointerId === event.pointerId) drag.releaseY = event.clientY;
    }
    window.addEventListener("pointerup", rememberRelease, true);
    return () => window.removeEventListener("pointerup", rememberRelease, true);
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const projectName = (id: string | number) => projects.find((project) => project.id === id)?.name ?? "Project";
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Moving ${projectName(active.id)}.`,
    onDragOver: ({ over }) => over ? `Position ${projects.findIndex((project) => project.id === over.id) + 1} of ${projects.length}.` : undefined,
    onDragEnd: ({ active }) => `Placed ${projectName(active.id)}.`,
    onDragCancel: () => "Move canceled.",
  };
  const constrain: Modifier = ({ transform, scrollableAncestors }) => {
    if (!lifted.current) return { ...transform, x: 0 };
    const { min, max, scroll } = lifted.current;
    const scrolled = (scrollableAncestors[0]?.scrollTop ?? scroll) - scroll;
    return { ...transform, x: 0, y: Math.max(min - scrolled, Math.min(max - scrolled, transform.y)) };
  };

  function pickUp(id: string, event: Event): void {
    onPickUp();
    const group = list.current?.querySelector<HTMLElement>(`[data-sortable-project="${CSS.escape(id)}"]`);
    if (!group || !list.current || !(event instanceof PointerEvent)) return;
    group.getAnimations().forEach((animation) => animation.cancel());
    const item = group.getBoundingClientRect();
    const area = list.current.getBoundingClientRect();
    lifted.current = {
      node: group, pointerId: event.pointerId, grabOffset: event.clientY - item.top, releaseY: null,
      min: area.top - item.top, max: area.bottom - item.bottom, scroll: list.current.closest("nav")?.scrollTop ?? 0,
    };
  }

  function releaseTarget(active: UniqueIdentifier, fallback: UniqueIdentifier): UniqueIdentifier {
    const drag = lifted.current;
    if (!drag || drag.releaseY === null || !list.current) return fallback;
    // A quick release can arrive before the last pointermove renders. Resolve
    // that final position against the unshifted layout at the current scroll.
    const rects = new Map<string, SectionRect>();
    for (const group of list.current.querySelectorAll<HTMLElement>("[data-sortable-project]")) {
      rects.set(group.dataset.sortableProject!, getClientRect(group, { ignoreTransform: true }));
    }
    const height = rects.get(String(active))?.height;
    if (height === undefined) return active;
    const area = list.current.getBoundingClientRect();
    const top = Math.max(area.top, Math.min(area.bottom - height, drag.releaseY - drag.grabOffset));
    return projectAtEdge(active, top, height, rects);
  }

  function settle(): void {
    const group = lifted.current?.node;
    lifted.current = null;
    if (!group || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const from = group.getBoundingClientRect().top;
    requestAnimationFrame(() => {
      if (!group.isConnected || lifted.current?.node === group) return;
      const delta = from - getClientRect(group, { ignoreTransform: true }).top;
      if (Math.abs(delta) < 1) return;
      group.classList.add("project-settling");
      const animation = group.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: slide.duration, easing: "ease-out" },
      );
      animation.onfinish = animation.oncancel = () => group.classList.remove("project-settling");
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={findProjectTarget}
      modifiers={[constrain]}
      accessibility={{ announcements, screenReaderInstructions: { draggable: "Use Alt+Shift+Up or Down to move a project." } }}
      onDragStart={({ active, activatorEvent }) => pickUp(String(active.id), activatorEvent)}
      onDragCancel={settle}
      onDragEnd={({ active, over }) => {
        const target = releaseTarget(active.id, over?.id ?? active.id);
        settle();
        if (target !== active.id) onMove(String(active.id), String(target));
      }}
    >
      <SortableContext items={projects} strategy={verticalListSortingStrategy} disabled={projects.length < 2}>
        <div ref={list} className="project-list">{children}</div>
      </SortableContext>
    </DndContext>
  );
}

type ProjectHandle = Pick<ComponentProps<"button">, "onPointerDown" | "ref" | "aria-describedby">;
type SortableProjectProps = Omit<ComponentProps<"div">, "children" | "id"> & {
  id: string;
  children: (handle: ProjectHandle) => ReactNode;
};

export function SortableProject({ id, children, className, ...props }: SortableProjectProps) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id, transition: slide });
  const descriptionId = listeners ? attributes["aria-describedby"] : undefined;
  // Pointer movement only changes the section's transform. Keep its expanded
  // folder and meeting tree out of those renders.
  const contents = useMemo(() => children({
    ref: setActivatorNodeRef, "aria-describedby": descriptionId, ...listeners,
  }), [children, setActivatorNodeRef, descriptionId, listeners]);
  return (
    <div
      {...props}
      data-sortable-project={id}
      ref={setNodeRef}
      className={`project-group ${className ?? ""}${isDragging ? " project-lifted" : ""}`}
      style={{ transform: transforms.Translate.toString(transform), transition }}
    >
      {contents}
    </div>
  );
}
