import { useEffect, useMemo, useState } from "react";
import { CreateMeetingDialog, CreateProjectDialog } from "./components/dialogs/CreateDialogs";
import { PeopleDialog } from "./components/dialogs/PeopleDialog";
import { SettingsDialog } from "./components/dialogs/SettingsDialog";
import { EmptyState } from "./components/EmptyState";
import { MeetingView } from "./components/meeting/MeetingView";
import { Sidebar } from "./components/sidebar/Sidebar";
import { ToastViewport } from "./components/ui/ToastViewport";
import { useWorkspace } from "./store/workspace";

export default function App() {
  const workspace = useWorkspace();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createMeetingOpen, setCreateMeetingOpen] = useState(false);
  const [newMeetingProjectId, setNewMeetingProjectId] = useState<string | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => { void workspace.load(); }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = workspace.settings.theme;
  }, [workspace.settings.theme]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent): void {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const target = event.target as HTMLElement | null;
      const editingText = target?.matches("input, textarea, [contenteditable='true']") ?? false;
      const key = event.key.toLowerCase();

      if (key === "n") {
        event.preventDefault();
        openCreateMeeting(workspace.selectedProjectId);
      } else if (!editingText && key === "z") {
        event.preventDefault();
        if (event.shiftKey) void workspace.redo();
        else void workspace.undo();
      } else if (!editingText && key === "y") {
        event.preventDefault();
        void workspace.redo();
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [workspace.redo, workspace.selectedProjectId, workspace.undo]);

  const selectedMeeting = useMemo(
    () => workspace.meetings.find((meeting) => meeting.id === workspace.selectedMeetingId) ?? null,
    [workspace.meetings, workspace.selectedMeetingId],
  );
  function openCreateMeeting(projectId: string | null): void {
    setNewMeetingProjectId(projectId);
    setCreateMeetingOpen(true);
  }

  if (workspace.loading) {
    return <div className="app-loading"><span className="brand-loading-mark">L</span><p>Opening Listen…</p></div>;
  }

  return (
    <div className="app-shell">
      <Sidebar
        onCreateProject={() => setCreateProjectOpen(true)}
        onCreateMeeting={openCreateMeeting}
        onOpenPeople={() => setPeopleOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="workspace-main">
        {selectedMeeting ? (
          <MeetingView
            meeting={selectedMeeting}
            onOpenPeople={() => setPeopleOpen(true)}
          />
        ) : (
          <EmptyState onCreateProject={() => setCreateProjectOpen(true)} onCreateMeeting={() => openCreateMeeting(null)} />
        )}
      </div>

      <ToastViewport toasts={workspace.toasts} onDismiss={workspace.dismissToast} />

      <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />
      <CreateMeetingDialog open={createMeetingOpen} initialProjectId={newMeetingProjectId} onClose={() => setCreateMeetingOpen(false)} />
      <PeopleDialog open={peopleOpen} onClose={() => setPeopleOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
