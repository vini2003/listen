import {
  AudioLines,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Mic,
  Pencil,
  Settings,
  Trash2,
  UserRound,
} from "lucide-react";
import { AnimatePresence, motion, Reorder } from "framer-motion";
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
} from "react";
import type { Meeting, Project } from "../../domain/models";
import { meaningfulMeetingDrop, type MeetingDropSpot } from "../../lib/meetingDrop";
import { useWorkspace } from "../../store/workspace";
import { ProjectActions } from "../project/ProjectActions";
import { Modal } from "../ui/Modal";

interface SidebarProps {
  onCreateProject: () => void;
  onCreateMeeting: (projectId: string | null) => void;
  onOpenPeople: () => void;
  onOpenSettings: () => void;
}

type DropSpot = MeetingDropSpot;

const PROJECT_TOGGLE_DELAY_MS = 140;

interface ContextMenuState {
  meetingId: string;
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
    meetings,
    selectedMeetingId,
    selectedProjectId,
    selectMeeting,
    reorderMeeting,
    reorderProjects,
    renameProject,
    renameMeeting,
    deleteMeeting,
    busy,
  } = useWorkspace();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(projects.map((project) => project.id)));
  const [orderedProjects, setOrderedProjects] = useState(projects);
  const [draggedMeetingId, setDraggedMeetingId] = useState<string | null>(null);
  const [dropSpot, setDropSpot] = useState<DropSpot | null>(null);
  const [hoveredCollectionKey, setHoveredCollectionKey] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<Meeting | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const dragPreviewRef = useRef<HTMLDivElement | null>(null);
  const projectClickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const project of projects) if (!current.has(project.id)) next.add(project.id);
      return next;
    });
  }, [projects]);

  useEffect(() => setOrderedProjects(projects), [projects]);

  useEffect(() => () => {
    if (projectClickTimerRef.current !== null) window.clearTimeout(projectClickTimerRef.current);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    function dismiss(event: PointerEvent): void {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null);
    }
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") setContextMenu(null);
    }
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", () => setContextMenu(null), { once: true });
    return () => {
      window.removeEventListener("pointerdown", dismiss, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const meetingsByProject = useMemo(() => {
    const groups = new Map<string, Meeting[]>();
    for (const meeting of [...meetings].sort((a, b) => a.position - b.position)) {
      const key = meeting.projectId ?? "__unsorted__";
      groups.set(key, [...(groups.get(key) ?? []), meeting]);
    }
    return groups;
  }, [meetings]);
  const miscellaneous = meetingsByProject.get("__unsorted__") ?? [];
  const contextMeeting = meetings.find((meeting) => meeting.id === contextMenu?.meetingId) ?? null;

  function toggleProject(id: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function scheduleProjectToggle(id: string): void {
    if (projectClickTimerRef.current !== null) window.clearTimeout(projectClickTimerRef.current);
    projectClickTimerRef.current = window.setTimeout(() => {
      projectClickTimerRef.current = null;
      toggleProject(id);
    }, PROJECT_TOGGLE_DELAY_MS);
  }

  function cancelScheduledProjectToggle(): void {
    if (projectClickTimerRef.current === null) return;
    window.clearTimeout(projectClickTimerRef.current);
    projectClickTimerRef.current = null;
  }

  function beginMeetingDrag(event: DragEvent, meeting: Meeting): void {
    event.dataTransfer.setData("application/listen-meeting", meeting.id);
    event.dataTransfer.setData("text/plain", meeting.id);
    event.dataTransfer.effectAllowed = "move";
    const preview = document.createElement("div");
    preview.className = "meeting-drag-preview";
    preview.textContent = meeting.title;
    document.body.appendChild(preview);
    event.dataTransfer.setDragImage(preview, 18, 18);
    dragPreviewRef.current = preview;
    setDraggedMeetingId(meeting.id);
    setHoveredCollectionKey(collectionKey(meeting.projectId));
    setContextMenu(null);
  }

  function finishMeetingDrag(): void {
    dragPreviewRef.current?.remove();
    dragPreviewRef.current = null;
    setDraggedMeetingId(null);
    setDropSpot(null);
    setHoveredCollectionKey(null);
  }

  function updateDropSpot(event: DragEvent, projectId: string | null, index: number): void {
    if (!draggedMeetingId && !event.dataTransfer.types.includes("application/listen-meeting")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setHoveredCollectionKey(collectionKey(projectId));
    setDropSpot(draggedMeetingId ? meaningfulMeetingDrop(meetings, draggedMeetingId, { projectId, index }) : { projectId, index });
  }

  function updateRowDropSpot(event: DragEvent, projectId: string | null, index: number): void {
    updateDropSpot(event, projectId, rowDropIndex(event, index));
  }

  function rowDropIndex(event: DragEvent, index: number): number {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? index : index + 1;
  }

  async function commitDrop(event: DragEvent, target: DropSpot): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const meetingId = event.dataTransfer.getData("application/listen-meeting")
      || event.dataTransfer.getData("text/plain")
      || draggedMeetingId;
    const destination = meetingId ? meaningfulMeetingDrop(meetings, meetingId, target) : null;
    finishMeetingDrag();
    if (meetingId && destination) await reorderMeeting(meetingId, destination.projectId, destination.index);
  }

  function openContextMenu(event: MouseEvent, meeting: Meeting): void {
    event.preventDefault();
    event.stopPropagation();
    const width = 238;
    const height = 94;
    setContextMenu({
      meetingId: meeting.id,
      x: Math.min(event.clientX, window.innerWidth - width - 10),
      y: Math.min(event.clientY, window.innerHeight - height - 10),
    });
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

  async function commitProjectRename(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const project = projects.find((candidate) => candidate.id === renamingProjectId);
    const nextName = projectRenameValue.trim();
    if (project && nextName && nextName !== project.name) {
      if (!await renameProject(project.id, nextName)) return;
    }
    setRenamingProjectId(null);
  }

  async function commitRename(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const meeting = meetings.find((candidate) => candidate.id === renamingId);
    const nextTitle = renameValue.trim();
    if (meeting && nextTitle && nextTitle !== meeting.title) {
      if (!await renameMeeting(meeting.id, nextTitle)) return;
    }
    setRenamingId(null);
  }

  function renderMeetingList(projectId: string | null, projectMeetings: Meeting[]) {
    return (
      <>
        {projectMeetings.map((meeting, index) => (
          <Fragment key={meeting.id}>
            <DropIndicator
              active={Boolean(draggedMeetingId && dropSpot?.projectId === projectId && dropSpot.index === index)}
              onDragOver={(event) => updateDropSpot(event, projectId, index)}
              onDrop={(event) => void commitDrop(event, { projectId, index })}
            />
            <MeetingRow
              meeting={meeting}
              selected={meeting.id === selectedMeetingId}
              dragging={meeting.id === draggedMeetingId}
              renaming={meeting.id === renamingId}
              renameValue={renameValue}
              onRenameValueChange={setRenameValue}
              onCommitRename={commitRename}
              onCancelRename={() => setRenamingId(null)}
              onSelect={() => selectMeeting(meeting.id)}
              onBeginRename={() => beginRename(meeting)}
              onContextMenu={(event) => openContextMenu(event, meeting)}
              onDragStart={(event) => beginMeetingDrag(event, meeting)}
              onDragEnd={finishMeetingDrag}
              onDragOver={(event) => updateRowDropSpot(event, projectId, index)}
              onDrop={(event) => void commitDrop(event, { projectId, index: rowDropIndex(event, index) })}
            />
          </Fragment>
        ))}
        <DropIndicator
          active={Boolean(draggedMeetingId && dropSpot?.projectId === projectId && dropSpot.index === projectMeetings.length)}
          onDragOver={(event) => updateDropSpot(event, projectId, projectMeetings.length)}
          onDrop={(event) => void commitDrop(event, { projectId, index: projectMeetings.length })}
        />
      </>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="brand-mark"><AudioLines size={18} strokeWidth={2.2} /></span>
        <span>Listen</span>
      </div>

      <button className="new-recording-button" onClick={() => onCreateMeeting(selectedProjectId)}>
        <Mic size={17} />
        <span>New recording</span>
        <kbd>⌘ N</kbd>
      </button>

      <nav className="sidebar-navigation" aria-label="Projects and recordings">
        <div className="sidebar-section-heading">
          <span>Projects</span>
          <button className="mini-icon-button" onClick={onCreateProject} aria-label="Create project">
            <FolderPlus size={16} />
          </button>
        </div>

        <Reorder.Group axis="y" values={orderedProjects} onReorder={setOrderedProjects} className="project-list" as="div">
          {orderedProjects.map((project) => {
            const projectMeetings = meetingsByProject.get(project.id) ?? [];
            const isExpanded = expanded.has(project.id);
            return (
              <Reorder.Item
                value={project}
                key={project.id}
                as="div"
                className="project-sort-item"
                onDragEnd={() => void reorderProjects(orderedProjects.map((candidate) => candidate.id))}
              >
                <div
                  className={`project-group ${hoveredCollectionKey === collectionKey(project.id) && draggedMeetingId ? "drop-target" : ""}`}
                  onDragEnter={() => setHoveredCollectionKey(collectionKey(project.id))}
                >
                  <div
                    className="sidebar-row project-row"
                    onDragOver={(event) => {
                      updateDropSpot(event, project.id, projectMeetings.length);
                      if (!isExpanded) setExpanded((current) => new Set(current).add(project.id));
                    }}
                    onDrop={(event) => void commitDrop(event, { projectId: project.id, index: projectMeetings.length })}
                  >
                    <button className="disclosure" onClick={() => toggleProject(project.id)} aria-label={`${isExpanded ? "Collapse" : "Expand"} ${project.name}`}>
                      {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                    {renamingProjectId === project.id ? (
                      <form
                        className="project-inline-rename"
                        onPointerDown={(event) => event.stopPropagation()}
                        onSubmit={(event) => void commitProjectRename(event)}
                      >
                        <Folder size={16} />
                        <input
                          autoFocus
                          value={projectRenameValue}
                          onChange={(event) => setProjectRenameValue(event.target.value)}
                          onFocus={(event) => event.currentTarget.select()}
                          onBlur={() => void commitProjectRename()}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setRenamingProjectId(null);
                          }}
                          aria-label={`Rename ${project.name}`}
                        />
                      </form>
                    ) : (
                      <button
                        className="row-main"
                        onClick={() => scheduleProjectToggle(project.id)}
                        onDoubleClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelScheduledProjectToggle();
                          beginProjectRename(project);
                        }}
                      >
                        <Folder size={16} />
                        <span>{project.name}</span>
                      </button>
                    )}
                    <ProjectActions project={project} placement="sidebar" />
                  </div>

                  {isExpanded ? (
                    <div className="meeting-list">
                      {renderMeetingList(project.id, projectMeetings)}
                    </div>
                  ) : null}
                </div>
              </Reorder.Item>
            );
          })}

          {projects.length === 0 ? (
            <button className="empty-project-prompt" onClick={onCreateProject}>
              <FolderPlus size={17} />
              <span>Create your first project</span>
            </button>
          ) : null}
        </Reorder.Group>

        <div
          className={`miscellaneous-section ${hoveredCollectionKey === collectionKey(null) && draggedMeetingId ? "drop-target" : ""}`}
          onDragEnter={() => setHoveredCollectionKey(collectionKey(null))}
          onDragLeave={(event) => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) {
              setDropSpot(null);
              setHoveredCollectionKey(null);
            }
          }}
        >
          <div
            className="sidebar-section-heading misc-heading"
            onDragOver={(event) => updateDropSpot(event, null, miscellaneous.length)}
            onDrop={(event) => void commitDrop(event, { projectId: null, index: miscellaneous.length })}
          >
            <span>Unsorted</span>
          </div>
          {renderMeetingList(null, miscellaneous)}
        </div>
      </nav>

      <footer className="sidebar-footer">
        <button onClick={onOpenPeople}><UserRound size={17} /><span>People</span></button>
        <button onClick={onOpenSettings}><Settings size={17} /><span>Settings</span></button>
      </footer>

      <AnimatePresence>
        {contextMenu && contextMeeting ? (
          <motion.div
            ref={contextMenuRef}
            className="recording-context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            initial={{ opacity: 0, scale: 0.97, y: -3 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -2 }}
            transition={{ duration: 0.12 }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button onClick={() => beginRename(contextMeeting)}><Pencil size={15} /> Rename</button>
            <div className="menu-divider" />
            <button className="danger-menu-item" onClick={() => { setContextMenu(null); setDeleteCandidate(contextMeeting); }}>
              <Trash2 size={15} /> Delete
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <Modal
        open={Boolean(deleteCandidate)}
        title="Delete?"
        description="You can undo this action with Ctrl+Z."
        onClose={() => setDeleteCandidate(null)}
        size="small"
      >
        <div className="confirmation-content">
          <p><strong>{deleteCandidate?.title}</strong> will be removed from the sidebar.</p>
          <div className="dialog-actions">
            <button className="secondary-button" onClick={() => setDeleteCandidate(null)}>Cancel</button>
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
    </aside>
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

function collectionKey(projectId: string | null): string {
  return projectId ?? "__unsorted__";
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
          <span className="meeting-row-copy"><span>{meeting.title}</span></span>
        </button>
      )}
    </div>
  );
}
