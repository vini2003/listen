import { useShallow } from "zustand/react/shallow";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Settings,
  Trash2,
  UserRound,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import type { Folder, Meeting, Project } from "../../domain/models";
import { useDismissableLayer, type DismissReason } from "../../hooks/useDismissableLayer";
import { moveMenuFocus } from "../../lib/focus";
import { meaningfulMeetingDrop, type MeetingDropSpot } from "../../lib/meetingDrop";
import { shortcutAria, shortcutLabel } from "../../lib/shortcuts";
import { useWorkspace } from "../../store/workspace";
import type { SettingsSection } from "../dialogs/SettingsDialog";
import { SidebarPane } from "./SidebarPane";
import { Modal } from "../ui/Modal";
import { ActivityTray, TranscriptionRing } from "./ActivityTray";
import { SortableProject, SortableProjects } from "./SortableProjects";

interface SidebarProps {
  onCreateProject: () => void;
  onCreateMeeting: (projectId: string | null) => void;
  onOpenPeople: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
}

type DropSpot = MeetingDropSpot;

const PROJECT_TOGGLE_DELAY_MS = 140;
const MEETING_DRAG_TYPE = "application/listen-meeting";
const FOLDER_DRAG_TYPE = "application/listen-folder";

interface MeetingContextMenuState {
  meetingId: string;
  x: number;
  y: number;
}

interface ProjectContextMenuState {
  projectId: string;
  x: number;
  y: number;
}

interface FolderContextMenuState {
  folderId: string;
  x: number;
  y: number;
}

export function Sidebar({
  onCreateProject,
  onCreateMeeting,
  onOpenPeople,
  onOpenSettings,
}: SidebarProps) {
  const {
    projects,
    folders,
    meetings,
    selectedMeetingId,
    selectedProjectId,
    selectMeeting,
    reorderMeeting,
    reorderProjects,
    renameProject,
    renameMeeting,
    deleteProject,
    deleteMeeting,
    createFolder,
    renameFolder,
    moveFolder,
    deleteFolder,
    busy,
  } = useWorkspace(useShallow((state) => ({
    projects: state.projects,
    folders: state.folders,
    meetings: state.meetings,
    selectedMeetingId: state.selectedMeetingId,
    selectedProjectId: state.selectedProjectId,
    selectMeeting: state.selectMeeting,
    reorderMeeting: state.reorderMeeting,
    reorderProjects: state.reorderProjects,
    renameProject: state.renameProject,
    renameMeeting: state.renameMeeting,
    deleteProject: state.deleteProject,
    deleteMeeting: state.deleteMeeting,
    createFolder: state.createFolder,
    renameFolder: state.renameFolder,
    moveFolder: state.moveFolder,
    deleteFolder: state.deleteFolder,
    busy: state.busy,
  })));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([
    ...projects.map((project) => project.id),
    ...folders.map((folder) => folder.id),
  ]));
  const [draggedMeetingId, setDraggedMeetingId] = useState<string | null>(null);
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  const [dropSpot, setDropSpot] = useState<DropSpot | null>(null);
  const [hoveredCollectionKey, setHoveredCollectionKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<MeetingContextMenuState | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<ProjectContextMenuState | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<FolderContextMenuState | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [folderRenameValue, setFolderRenameValue] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [projectDeleteCandidate, setProjectDeleteCandidate] = useState<Project | null>(null);
  const [folderDeleteCandidate, setFolderDeleteCandidate] = useState<Folder | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Meeting | null>(null);
  const contextMenuOpen = Boolean(contextMenu || projectContextMenu || folderContextMenu);
  const dismissContextMenus = useCallback((reason: DismissReason) => {
    setContextMenu(null);
    setProjectContextMenu(null);
    setFolderContextMenu(null);
    if (reason === "escape") window.requestAnimationFrame(() => contextTriggerRef.current?.focus());
  }, []);
  const contextMenuRef = useDismissableLayer<HTMLDivElement>(contextMenuOpen, dismissContextMenus, { closeOnWindowBlur: true });
  const contextTriggerRef = useRef<HTMLElement | null>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const projectClickTimerRef = useRef<number | null>(null);
  const seenCollectionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Expand collections the first time they appear, without re-expanding
    // ones the user has collapsed.
    const seen = seenCollectionIdsRef.current;
    const fresh = [...projects.map((project) => project.id), ...folders.map((folder) => folder.id)]
      .filter((id) => !seen.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => seen.add(id));
    setExpanded((current) => {
      const next = new Set(current);
      fresh.forEach((id) => next.add(id));
      return next;
    });
  }, [projects, folders]);

  useEffect(() => () => {
    if (projectClickTimerRef.current !== null) window.clearTimeout(projectClickTimerRef.current);
  }, []);

  useEffect(() => {
    function handleItemShortcut(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== "F2" && event.key !== "Delete") return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']") || document.querySelector('[role="dialog"]')) return;

      const projectId = target?.closest<HTMLElement>("[data-project-id]")?.dataset.projectId;
      const folderId = target?.closest<HTMLElement>("[data-folder-id]")?.dataset.folderId;
      const meetingId = target?.closest<HTMLElement>("[data-meeting-id]")?.dataset.meetingId || selectedMeetingId;
      const project = projects.find((candidate) => candidate.id === projectId);
      const folder = folders.find((candidate) => candidate.id === folderId);
      const meeting = meetings.find((candidate) => candidate.id === meetingId);

      if (event.key === "F2") {
        if (project) beginProjectRename(project);
        else if (folder) beginFolderRename(folder);
        else if (meeting) beginRename(meeting);
        else return;
      } else {
        if (project) setProjectDeleteCandidate(project);
        else if (folder) setFolderDeleteCandidate(folder);
        else if (meeting) setDeleteCandidate(meeting);
        else return;
      }

      event.preventDefault();
    }

    window.addEventListener("keydown", handleItemShortcut);
    return () => window.removeEventListener("keydown", handleItemShortcut);
  }, [meetings, projects, folders, selectedMeetingId]);

  useEffect(() => {
    if (!contextMenu && !projectContextMenu && !folderContextMenu) return;
    window.requestAnimationFrame(() => contextMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus());
  }, [contextMenu, projectContextMenu, folderContextMenu]);

  const meetingsByCollection = useMemo(() => {
    const groups = new Map<string, Meeting[]>();
    for (const meeting of [...meetings].sort((a, b) => a.position - b.position)) {
      const key = collectionKey(meeting.projectId, meeting.folderId);
      groups.set(key, [...(groups.get(key) ?? []), meeting]);
    }
    return groups;
  }, [meetings]);
  const foldersByParent = useMemo(() => {
    const groups = new Map<string, Folder[]>();
    for (const folder of [...folders].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt))) {
      const key = collectionKey(folder.projectId, folder.parentId);
      groups.set(key, [...(groups.get(key) ?? []), folder]);
    }
    return groups;
  }, [folders]);
  const miscellaneous = meetingsByCollection.get(collectionKey(null, null)) ?? [];
  const contextMeeting = meetings.find((meeting) => meeting.id === contextMenu?.meetingId) ?? null;
  const contextProject = projects.find((project) => project.id === projectContextMenu?.projectId) ?? null;
  const contextFolder = folders.find((folder) => folder.id === folderContextMenu?.folderId) ?? null;

  function toggleCollection(id: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function expandCollection(id: string): void {
    setExpanded((current) => current.has(id) ? current : new Set(current).add(id));
  }

  function scheduleProjectToggle(id: string): void {
    if (projectClickTimerRef.current !== null) window.clearTimeout(projectClickTimerRef.current);
    projectClickTimerRef.current = window.setTimeout(() => {
      projectClickTimerRef.current = null;
      toggleCollection(id);
    }, PROJECT_TOGGLE_DELAY_MS);
  }

  function cancelScheduledProjectToggle(): void {
    if (projectClickTimerRef.current === null) return;
    window.clearTimeout(projectClickTimerRef.current);
    projectClickTimerRef.current = null;
  }

  function beginMeetingDrag(event: DragEvent, meeting: Meeting): void {
    event.stopPropagation();
    event.dataTransfer.setData(MEETING_DRAG_TYPE, meeting.id);
    event.dataTransfer.setData("text/plain", meeting.id);
    event.dataTransfer.effectAllowed = "move";
    const preview = document.createElement("div");
    preview.className = "meeting-drag-preview";
    preview.textContent = meeting.title;
    document.body.appendChild(preview);
    event.dataTransfer.setDragImage(preview, 18, 18);
    dragPreviewRef.current = preview;
    setDraggedMeetingId(meeting.id);
    setHoveredCollectionKey(collectionKey(meeting.projectId, meeting.folderId));
    setContextMenu(null);
  }

  function finishMeetingDrag(): void {
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
    setDraggedMeetingId(null);
    setDropSpot(null);
    setHoveredCollectionKey(null);
  }

  function beginProjectDrag(): void {
    cancelScheduledProjectToggle();
    setProjectContextMenu(null);
  }

  function beginFolderDrag(event: DragEvent, folder: Folder): void {
    event.stopPropagation();
    event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id);
    event.dataTransfer.effectAllowed = "move";
    setDraggedFolderId(folder.id);
    setFolderContextMenu(null);
  }

  function finishFolderDrag(): void {
    setDraggedFolderId(null);
    setHoveredCollectionKey(null);
  }

  function isMeetingDrag(event: DragEvent): boolean {
    return Boolean(draggedMeetingId) || event.dataTransfer.types.includes(MEETING_DRAG_TYPE);
  }

  function isFolderDrag(event: DragEvent): boolean {
    return Boolean(draggedFolderId) || event.dataTransfer.types.includes(FOLDER_DRAG_TYPE);
  }

  function updateDropSpot(event: DragEvent, projectId: string | null, folderId: string | null, index: number): void {
    if (!isMeetingDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setHoveredCollectionKey(collectionKey(projectId, folderId));
    setDropSpot(draggedMeetingId
      ? meaningfulMeetingDrop(meetings, draggedMeetingId, { projectId, folderId, index })
      : { projectId, folderId, index });
  }

  function updateRowDropSpot(event: DragEvent, projectId: string | null, folderId: string | null, index: number): void {
    updateDropSpot(event, projectId, folderId, rowDropIndex(event, index));
  }

  function rowDropIndex(event: DragEvent, index: number): number {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? index : index + 1;
  }

  async function commitDrop(event: DragEvent, target: DropSpot): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const meetingId = event.dataTransfer.getData(MEETING_DRAG_TYPE)
      || event.dataTransfer.getData("text/plain")
      || draggedMeetingId;
    const destination = meetingId ? meaningfulMeetingDrop(meetings, meetingId, target) : null;
    finishMeetingDrag();
    if (meetingId && destination) await reorderMeeting(meetingId, destination);
  }

  function moveProject(from: string, to: string): void {
    const ids = projects.map((project) => project.id);
    const source = ids.indexOf(from);
    const target = ids.indexOf(to);
    if (source < 0 || target < 0 || source === target) return;
    ids.splice(source, 1);
    ids.splice(target, 0, from);
    void reorderProjects(ids);
  }

  function stepProject(id: string, direction: -1 | 1): void {
    const index = projects.findIndex((project) => project.id === id);
    const target = projects[index + direction];
    if (!target) return;
    setProjectContextMenu(null);
    moveProject(id, target.id);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`button[data-project-id="${CSS.escape(id)}"]`)?.focus());
  }

  function canNestDraggedFolder(target: { projectId: string; id: string | null }): boolean {
    const dragged = folders.find((folder) => folder.id === draggedFolderId);
    if (!dragged || dragged.projectId !== target.projectId) return false;
    // Walk up from the target; the dragged folder must not be on the path.
    for (let cursor = target.id; cursor !== null;) {
      if (cursor === dragged.id) return false;
      cursor = folders.find((folder) => folder.id === cursor)?.parentId ?? null;
    }
    return dragged.parentId !== target.id;
  }

  function commitFolderDrop(event: DragEvent, target: { projectId: string; id: string | null }): void {
    event.preventDefault();
    event.stopPropagation();
    const folderId = event.dataTransfer.getData(FOLDER_DRAG_TYPE) || draggedFolderId;
    const allowed = canNestDraggedFolder(target);
    finishFolderDrag();
    if (!folderId || !allowed) return;
    if (target.id) expandCollection(target.id);
    void moveFolder(folderId, target.id);
  }

  function openContextMenu(event: MouseEvent, meeting: Meeting): void {
    event.preventDefault();
    event.stopPropagation();
    const width = 238;
    const height = 94;
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchorX = event.clientX || bounds.left + 24;
    const anchorY = event.clientY || bounds.bottom;
    contextTriggerRef.current = event.currentTarget as HTMLElement;
    setContextMenu({
      meetingId: meeting.id,
      x: Math.min(anchorX, window.innerWidth - width - 10),
      y: Math.min(anchorY, window.innerHeight - height - 10),
    });
    setProjectContextMenu(null);
    setFolderContextMenu(null);
  }

  function openProjectContextMenu(event: MouseEvent, project: Project): void {
    event.preventDefault();
    event.stopPropagation();
    const width = 238;
    const height = 236;
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchorX = event.clientX || bounds.left + 24;
    const anchorY = event.clientY || bounds.bottom;
    contextTriggerRef.current = event.currentTarget as HTMLElement;
    setProjectContextMenu({
      projectId: project.id,
      x: Math.min(anchorX, window.innerWidth - width - 10),
      y: Math.min(anchorY, window.innerHeight - height - 10),
    });
    setContextMenu(null);
    setFolderContextMenu(null);
  }

  function openFolderContextMenu(event: MouseEvent, folder: Folder): void {
    event.preventDefault();
    event.stopPropagation();
    const width = 238;
    const height = 130;
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchorX = event.clientX || bounds.left + 24;
    const anchorY = event.clientY || bounds.bottom;
    contextTriggerRef.current = event.currentTarget as HTMLElement;
    setFolderContextMenu({
      folderId: folder.id,
      x: Math.min(anchorX, window.innerWidth - width - 10),
      y: Math.min(anchorY, window.innerHeight - height - 10),
    });
    setContextMenu(null);
    setProjectContextMenu(null);
  }

  function handleContextMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (moveMenuFocus(event.currentTarget, event.key)) event.preventDefault();
  }

  function beginRename(meeting: Meeting): void {
    setContextMenu(null);
    setRenamingId(meeting.id);
    setRenameValue(meeting.title);
  }

  function beginProjectRename(project: Project): void {
    setRenamingProjectId(project.id);
    setProjectRenameValue(project.name);
  }

  function beginFolderRename(folder: Folder): void {
    setFolderContextMenu(null);
    setRenamingFolderId(folder.id);
    setFolderRenameValue(folder.name);
  }

  async function createFolderIn(projectId: string, parentId: string | null): Promise<void> {
    setProjectContextMenu(null);
    setFolderContextMenu(null);
    const folder = await createFolder({ projectId, parentId, name: "New folder" });
    if (!folder) return;
    expandCollection(projectId);
    if (parentId) expandCollection(parentId);
    beginFolderRename(folder);
  }

  async function commitProjectRename(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const project = projects.find((candidate) => candidate.id === renamingProjectId);
    const nextName = projectRenameValue.trim();
    if (project && nextName && nextName !== project.name) {
      if (!await renameProject(project.id, nextName)) return;
    }
    setRenamingProjectId(null);
    if (event) window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-project-id="${project?.id}"]`)?.focus());
  }

  async function commitFolderRename(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const folder = folders.find((candidate) => candidate.id === renamingFolderId);
    const nextName = folderRenameValue.trim();
    if (folder && nextName && nextName !== folder.name) {
      if (!await renameFolder(folder.id, nextName)) return;
    }
    setRenamingFolderId(null);
    if (event) window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-folder-id="${folder?.id}"]`)?.focus());
  }

  async function commitRename(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const meeting = meetings.find((candidate) => candidate.id === renamingId);
    const nextTitle = renameValue.trim();
    if (meeting && nextTitle && nextTitle !== meeting.title) {
      if (!await renameMeeting(meeting.id, nextTitle)) return;
    }
    setRenamingId(null);
    if (event) window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-meeting-id="${meeting?.id}"]`)?.focus());
  }

  function cancelProjectRename(projectId: string): void {
    setRenamingProjectId(null);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-project-id="${projectId}"]`)?.focus());
  }

  function cancelFolderRename(folderId: string): void {
    setRenamingFolderId(null);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-folder-id="${folderId}"]`)?.focus());
  }

  function cancelMeetingRename(meetingId: string): void {
    setRenamingId(null);
    window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-meeting-id="${meetingId}"]`)?.focus());
  }

  function renderMeetingList(projectId: string | null, folderId: string | null, collectionMeetings: Meeting[]) {
    return (
      <>
        {collectionMeetings.map((meeting, index) => (
          <Fragment key={meeting.id}>
            <DropIndicator
              active={Boolean(draggedMeetingId
                && dropSpot?.projectId === projectId
                && dropSpot.folderId === folderId
                && dropSpot.index === index)}
              onDragOver={(event) => updateDropSpot(event, projectId, folderId, index)}
              onDrop={(event) => void commitDrop(event, { projectId, folderId, index })}
            />
            <MeetingRow
              meeting={meeting}
              selected={meeting.id === selectedMeetingId}
              dragging={meeting.id === draggedMeetingId}
              renaming={meeting.id === renamingId}
              renameValue={renameValue}
              onRenameValueChange={setRenameValue}
              onCommitRename={commitRename}
              onCancelRename={() => cancelMeetingRename(meeting.id)}
              onSelect={() => selectMeeting(meeting.id)}
              onBeginRename={() => beginRename(meeting)}
              onContextMenu={(event) => openContextMenu(event, meeting)}
              onDragStart={(event) => beginMeetingDrag(event, meeting)}
              onDragEnd={finishMeetingDrag}
              onDragOver={(event) => updateRowDropSpot(event, projectId, folderId, index)}
              onDrop={(event) => void commitDrop(event, { projectId, folderId, index: rowDropIndex(event, index) })}
            />
          </Fragment>
        ))}
        <DropIndicator
          active={Boolean(draggedMeetingId
            && dropSpot?.projectId === projectId
            && dropSpot.folderId === folderId
            && dropSpot.index === collectionMeetings.length)}
          onDragOver={(event) => updateDropSpot(event, projectId, folderId, collectionMeetings.length)}
          onDrop={(event) => void commitDrop(event, { projectId, folderId, index: collectionMeetings.length })}
        />
      </>
    );
  }

  function renderCollectionContents(projectId: string, folderId: string | null) {
    const childFolders = foldersByParent.get(collectionKey(projectId, folderId)) ?? [];
    const collectionMeetings = meetingsByCollection.get(collectionKey(projectId, folderId)) ?? [];
    return (
      <div className="meeting-list">
        {childFolders.map((folder) => renderFolder(folder))}
        {renderMeetingList(projectId, folderId, collectionMeetings)}
      </div>
    );
  }

  function renderFolder(folder: Folder) {
    const key = collectionKey(folder.projectId, folder.id);
    const childFolders = foldersByParent.get(key) ?? [];
    const folderMeetings = meetingsByCollection.get(key) ?? [];
    const hasContents = childFolders.length > 0 || folderMeetings.length > 0;
    const isExpanded = expanded.has(folder.id);
    const isDropTarget = hoveredCollectionKey === key
      && (Boolean(draggedMeetingId) || (Boolean(draggedFolderId) && draggedFolderId !== folder.id));
    return (
      <div
        key={folder.id}
        className={`folder-group ${isDropTarget ? "drop-target" : ""} ${folder.id === draggedFolderId ? "dragging" : ""}`}
      >
        <div
          className="sidebar-row folder-row"
          draggable={renamingFolderId !== folder.id}
          onDragStart={(event) => beginFolderDrag(event, folder)}
          onDragEnd={finishFolderDrag}
          onContextMenu={(event) => openFolderContextMenu(event, folder)}
          onDragOver={(event) => {
            if (isFolderDrag(event)) {
              if (!canNestDraggedFolder({ projectId: folder.projectId, id: folder.id })) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              setHoveredCollectionKey(key);
              return;
            }
            updateDropSpot(event, folder.projectId, folder.id, folderMeetings.length);
            if (isMeetingDrag(event)) expandCollection(folder.id);
          }}
          onDrop={(event) => {
            if (isFolderDrag(event)) {
              commitFolderDrop(event, { projectId: folder.projectId, id: folder.id });
              return;
            }
            void commitDrop(event, { projectId: folder.projectId, folderId: folder.id, index: folderMeetings.length });
          }}
        >
          {hasContents ? (
            <button className="disclosure" onClick={() => toggleCollection(folder.id)} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${folder.name}`} aria-expanded={isExpanded}>
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : <span className="disclosure disclosure-placeholder" aria-hidden="true" />}
          {renamingFolderId === folder.id ? (
            <form
              className="project-inline-rename"
              onPointerDown={(event) => event.stopPropagation()}
              onSubmit={(event) => void commitFolderRename(event)}
            >
              <FolderIcon size={15} />
              <input
                autoFocus
                value={folderRenameValue}
                onChange={(event) => setFolderRenameValue(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onBlur={() => void commitFolderRename()}
                onKeyDown={(event) => {
                  if (event.key === "Escape") cancelFolderRename(folder.id);
                }}
                aria-label={`Rename ${folder.name}`}
              />
            </form>
          ) : (
            <button
              className="row-main"
              data-folder-id={folder.id}
              aria-keyshortcuts="F2 Delete ArrowLeft ArrowRight"
              aria-expanded={hasContents ? isExpanded : undefined}
              title={folder.name}
              onClick={() => {
                if (hasContents) toggleCollection(folder.id);
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                beginFolderRename(folder);
              }}
              onKeyDown={(event) => {
                if (!hasContents || event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setExpanded((current) => {
                  const next = new Set(current);
                  if (event.key === "ArrowRight") next.add(folder.id);
                  else next.delete(folder.id);
                  return next;
                });
              }}
            >
              <FolderIcon size={15} />
              <span>{folder.name}</span>
            </button>
          )}
          <button
            className="row-action folder-row-action"
            aria-label={`Folder options for ${folder.name}`}
            aria-haspopup="menu"
            aria-expanded={folderContextMenu?.folderId === folder.id}
            onClick={(event) => openFolderContextMenu(event, folder)}
          >
            <MoreHorizontal size={15} />
          </button>
        </div>
        {isExpanded ? renderCollectionContents(folder.projectId, folder.id) : null}
      </div>
    );
  }

  return (
    <SidebarPane>
      <button
        className="new-recording-button"
        onClick={() => onCreateMeeting(selectedProjectId)}
        aria-keyshortcuts={shortcutAria("n")}
        title={`New meeting (${shortcutLabel("n")})`}
      >
        <Plus size={17} />
        <span>New meeting</span>
        <kbd aria-hidden="true">{shortcutLabel("n")}</kbd>
      </button>

      <nav className="sidebar-navigation" aria-label="Projects and recordings">
        <div className="sidebar-section-heading">
          <h2>Projects</h2>
          <button className="mini-icon-button" onClick={onCreateProject} aria-label="Create project" aria-keyshortcuts={shortcutAria("n", { shift: true })} title={`Create project (${shortcutLabel("n", { shift: true })})`}>
            <FolderPlus size={16} />
          </button>
        </div>

        <SortableProjects projects={projects} onPickUp={beginProjectDrag} onMove={moveProject}>
          {projects.map((project) => {
            const rootKey = collectionKey(project.id, null);
            const rootMeetings = meetingsByCollection.get(rootKey) ?? [];
            const hasContents = rootMeetings.length > 0
              || (foldersByParent.get(rootKey)?.length ?? 0) > 0
              || meetings.some((meeting) => meeting.projectId === project.id);
            const isExpanded = expanded.has(project.id);
            const isDropTarget = hoveredCollectionKey === rootKey
              && (Boolean(draggedMeetingId) || Boolean(draggedFolderId));
            return (
              <SortableProject key={project.id} id={project.id} className={isDropTarget ? "drop-target" : undefined}
                onDragEnter={(event) => { if (isMeetingDrag(event)) setHoveredCollectionKey(rootKey); }}>
                {(handle) => <>
                  <div
                    className="sidebar-row project-row"
                    onContextMenu={(event) => openProjectContextMenu(event, project)}
                    onDragOver={(event) => {
                      if (isFolderDrag(event)) {
                        if (!canNestDraggedFolder({ projectId: project.id, id: null })) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                        setHoveredCollectionKey(rootKey);
                        return;
                      }
                      updateDropSpot(event, project.id, null, rootMeetings.length);
                      if (isMeetingDrag(event) && !isExpanded) expandCollection(project.id);
                    }}
                    onDrop={(event) => {
                      if (isFolderDrag(event)) {
                        commitFolderDrop(event, { projectId: project.id, id: null });
                        return;
                      }
                      void commitDrop(event, { projectId: project.id, folderId: null, index: rootMeetings.length });
                    }}
                  >
                    {hasContents ? (
                      <button className="disclosure" onClick={() => toggleCollection(project.id)} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={isExpanded}>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    ) : <span className="disclosure disclosure-placeholder" aria-hidden="true" />}
                    {renamingProjectId === project.id ? (
                      <form
                        className="project-inline-rename"
                        onPointerDown={(event) => event.stopPropagation()}
                        onSubmit={(event) => void commitProjectRename(event)}
                      >
                        <FolderIcon size={16} />
                        <input
                          autoFocus
                          value={projectRenameValue}
                          onChange={(event) => setProjectRenameValue(event.target.value)}
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => void commitProjectRename()}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") cancelProjectRename(project.id);
                          }}
                          aria-label={`Rename ${project.name}`}
                        />
                      </form>
                    ) : (
                      <button
                        {...handle}
                        className="row-main"
                        data-project-id={project.id}
                        aria-keyshortcuts="F2 Delete ArrowLeft ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown"
                        aria-expanded={hasContents ? isExpanded : undefined}
                        title={project.name}
                        onClick={() => {
                          if (hasContents) scheduleProjectToggle(project.id);
                        }}
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelScheduledProjectToggle();
                          beginProjectRename(project);
                        }}
                        onKeyDown={(event) => {
                          if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                            event.preventDefault();
                            stepProject(project.id, event.key === "ArrowUp" ? -1 : 1);
                            return;
                          }
                          if (!hasContents || event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          cancelScheduledProjectToggle();
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (event.key === "ArrowRight") next.add(project.id);
                            else next.delete(project.id);
                            return next;
                          });
                        }}
                      >
                        <FolderIcon size={16} />
                        <span>{project.name}</span>
                      </button>
                    )}
                    <button
                      className="row-action"
                      aria-label={`Project options for ${project.name}`}
                      aria-haspopup="menu"
                      aria-expanded={projectContextMenu?.projectId === project.id}
                      onClick={(event) => openProjectContextMenu(event, project)}
                    ><MoreHorizontal size={15} /></button>
                  </div>

                  {isExpanded && (hasContents || draggedMeetingId) ? renderCollectionContents(project.id, null) : null}
                </>}
              </SortableProject>
            );
          })}
        </SortableProjects>

        <div
          hidden={miscellaneous.length === 0 && !draggedMeetingId}
          className={`miscellaneous-section ${hoveredCollectionKey === collectionKey(null, null) && draggedMeetingId ? "drop-target" : ""}`}
          onDragEnter={(event) => {
            if (isMeetingDrag(event)) setHoveredCollectionKey(collectionKey(null, null));
          }}
          onDragLeave={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
              setDropSpot(null);
              setHoveredCollectionKey(null);
            }
          }}
        >
          <div
            className="sidebar-section-heading misc-heading"
            onDragOver={(event) => updateDropSpot(event, null, null, miscellaneous.length)}
            onDrop={(event) => void commitDrop(event, { projectId: null, folderId: null, index: miscellaneous.length })}
          >
            <h2>Unsorted</h2>
          </div>
          {renderMeetingList(null, null, miscellaneous)}
        </div>
      </nav>

      <ActivityTray />
      <footer className="sidebar-footer">
        <button onClick={onOpenPeople}><UserRound size={17} /><span>People</span></button>
        <button onClick={() => onOpenSettings()} aria-keyshortcuts={shortcutAria(",")} title={`Settings (${shortcutLabel(",")})`}><Settings size={17} /><span>Settings</span></button>
      </footer>

      <AnimatePresence>
        {projectContextMenu && contextProject ? (
          <motion.div
            key="project-context-menu"
            ref={contextMenuRef}
            className="recording-context-menu"
            style={{ left: projectContextMenu.x, top: projectContextMenu.y }}
            initial={{ opacity: 0, scale: 0.97, y: -3 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -2 }}
            transition={{ duration: 0.12 }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={handleContextMenuKeyDown}
            role="menu"
            aria-label={`Actions for ${contextProject.name}`}
          >
            <button role="menuitem" onClick={() => { setProjectContextMenu(null); expandCollection(contextProject.id); onCreateMeeting(contextProject.id); }}><Plus size={15} /> New meeting</button>
            <button role="menuitem" onClick={() => void createFolderIn(contextProject.id, null)}><FolderPlus size={15} /> New folder</button>
            <button role="menuitem" onClick={() => { setProjectContextMenu(null); beginProjectRename(contextProject); }}><Pencil size={15} /> Rename <kbd className="menu-shortcut">F2</kbd></button>
            <button role="menuitem" disabled={projects[0]?.id === contextProject.id} onClick={() => stepProject(contextProject.id, -1)}><ArrowUp size={15} /> Move up</button>
            <button role="menuitem" disabled={projects.at(-1)?.id === contextProject.id} onClick={() => stepProject(contextProject.id, 1)}><ArrowDown size={15} /> Move down</button>
            <div className="menu-divider" role="separator" />
            <button role="menuitem" className="danger-menu-item" onClick={() => { setProjectContextMenu(null); setProjectDeleteCandidate(contextProject); }}>
              <Trash2 size={15} /> Delete <kbd className="menu-shortcut">Del</kbd>
            </button>
          </motion.div>
        ) : null}
        {folderContextMenu && contextFolder ? (
          <motion.div
            key="folder-context-menu"
            ref={contextMenuRef}
            className="recording-context-menu"
            style={{ left: folderContextMenu.x, top: folderContextMenu.y }}
            initial={{ opacity: 0, scale: 0.97, y: -3 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -2 }}
            transition={{ duration: 0.12 }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={handleContextMenuKeyDown}
            role="menu"
            aria-label={`Actions for ${contextFolder.name}`}
          >
            <button role="menuitem" onClick={() => void createFolderIn(contextFolder.projectId, contextFolder.id)}><FolderPlus size={15} /> New folder</button>
            <button role="menuitem" onClick={() => beginFolderRename(contextFolder)}><Pencil size={15} /> Rename <kbd className="menu-shortcut">F2</kbd></button>
            <div className="menu-divider" role="separator" />
            <button role="menuitem" className="danger-menu-item" onClick={() => { setFolderContextMenu(null); setFolderDeleteCandidate(contextFolder); }}>
              <Trash2 size={15} /> Delete <kbd className="menu-shortcut">Del</kbd>
            </button>
          </motion.div>
        ) : null}
        {contextMenu && contextMeeting ? (
          <motion.div
            key="meeting-context-menu"
            ref={contextMenuRef}
            className="recording-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            initial={{ opacity: 0, scale: 0.97, y: -3 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -2 }}
            transition={{ duration: 0.12 }}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={handleContextMenuKeyDown}
            role="menu"
            aria-label={`Actions for ${contextMeeting.title}`}
          >
            <button role="menuitem" onClick={() => beginRename(contextMeeting)}><Pencil size={15} /> Rename <kbd className="menu-shortcut">F2</kbd></button>
            <div className="menu-divider" role="separator" />
            <button role="menuitem" className="danger-menu-item" onClick={() => { setContextMenu(null); setDeleteCandidate(contextMeeting); }}>
              <Trash2 size={15} /> Delete <kbd className="menu-shortcut">Del</kbd>
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Modal
        open={Boolean(projectDeleteCandidate)}
        title={`Delete “${projectDeleteCandidate?.name}”?`}
        onClose={() => setProjectDeleteCandidate(null)}
        size="small"
      >
        <div className="confirmation-content">
          <p>Meetings in this project will move to Unsorted.</p>
          <div className="dialog-actions">
            <button autoFocus className="secondary-button" onClick={() => setProjectDeleteCandidate(null)}>Cancel</button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (!projectDeleteCandidate) return;
                void deleteProject(projectDeleteCandidate.id).then((deleted) => {
                  if (deleted) setProjectDeleteCandidate(null);
                });
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(folderDeleteCandidate)}
        title={`Delete “${folderDeleteCandidate?.name}”?`}
        onClose={() => setFolderDeleteCandidate(null)}
        size="small"
      >
        <div className="confirmation-content">
          <p>Meetings and folders inside will move up one level.</p>
          <div className="dialog-actions">
            <button autoFocus className="secondary-button" onClick={() => setFolderDeleteCandidate(null)}>Cancel</button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (!folderDeleteCandidate) return;
                void deleteFolder(folderDeleteCandidate.id).then((deleted) => {
                  if (deleted) setFolderDeleteCandidate(null);
                });
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(deleteCandidate)}
        title={`Delete “${deleteCandidate?.title}”?`}
        onClose={() => setDeleteCandidate(null)}
        size="small"
      >
        <div className="confirmation-content">
          <p>You can undo this with {shortcutLabel("z")}.</p>
          <div className="dialog-actions">
            <button autoFocus className="secondary-button" onClick={() => setDeleteCandidate(null)}>Cancel</button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (deleteCandidate) void deleteMeeting(deleteCandidate.id);
                setDeleteCandidate(null);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
    </SidebarPane>
  );
}

function DropIndicator({
  active,
  onDragOver,
  onDrop,
}: {
  active: boolean;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}) {
  return <div className={`meeting-drop-indicator ${active ? "active" : ""}`} onDragOver={onDragOver} onDrop={onDrop}><span /></div>;
}

function collectionKey(projectId: string | null, folderId: string | null): string {
  return `${projectId ?? "__unsorted__"}/${folderId ?? "__root__"}`;
}

interface MeetingRowProps {
  meeting: Meeting;
  selected: boolean;
  dragging: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onCommitRename: (event?: FormEvent) => Promise<void>;
  onCancelRename: () => void;
  onSelect: () => void;
  onBeginRename: () => void;
  onContextMenu: (event: MouseEvent) => void;
  onDragStart: (event: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

function MeetingRow({
  meeting,
  selected,
  dragging,
  renaming,
  renameValue,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
  onSelect,
  onBeginRename,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: MeetingRowProps) {
  return (
    <div
      className={`meeting-row-shell ${dragging ? "dragging" : ""}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {renaming ? (
        <form onSubmit={(event) => void onCommitRename(event)}>
          <input
            className="meeting-row-input"
            autoFocus
            value={renameValue}
            onChange={(event) => onRenameValueChange(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => void onCommitRename()}
            aria-label={`Rename ${meeting.title}`}
            onKeyDown={(event) => {
              if (event.key === "Escape") onCancelRename();
            }}
          />
        </form>
      ) : (
        <button
          className={`sidebar-row meeting-row ${selected ? "selected" : ""}`}
          data-meeting-id={meeting.id}
          aria-current={selected ? "page" : undefined}
          aria-keyshortcuts="F2 Delete"
          title={meeting.title}
          draggable
          onClick={onSelect}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onBeginRename();
          }}
          onContextMenu={onContextMenu}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {meeting.status === "processing" ? <TranscriptionRing meetingId={meeting.id} /> : null}
          {meeting.status === "recording" || meeting.status === "failed" ? (
            <span
              className={`status-dot status-${meeting.status}`}
              role="img"
              aria-label={meeting.status === "recording" ? "Recording" : "Transcription failed"}
            />
          ) : null}
          <span className="meeting-row-copy"><span>{meeting.title}</span></span>
        </button>
      )}
    </div>
  );
}
