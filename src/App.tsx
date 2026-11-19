import { useEventCallback } from "./hooks/useEventCallback";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useMemo, useState } from "react";
import { CreateMeetingDialog, CreateProjectDialog } from "./components/dialogs/CreateDialogs";
import { PeopleDialog } from "./components/dialogs/PeopleDialog";
import { SettingsDialog, type SettingsSection } from "./components/dialogs/SettingsDialog";
import { EmptyState } from "./components/EmptyState";
import { MeetingView } from "./components/meeting/MeetingView";
import { Sidebar } from "./components/sidebar/Sidebar";
import { AppUpdater } from "./components/ui/AppUpdater";
import { ToastViewport } from "./components/ui/ToastViewport";
import { focusTranscriptTime } from "./lib/transcriptFocus";
import {
  ASSISTANT_ATTACHED_EVENT,
  ASSISTANT_REFERENCE_EVENT,
  CHAT_SETTINGS_EVENT,
  focusAssistantWindow,
  listenForAssistantEvent,
  listenForBrowserReference,
  type AssistantReference,
} from "./services/assistantWindow";
import { useWorkspace } from "./store/workspace";

export default function App() {
  const workspace = useWorkspace(useShallow((state) => ({
    dismissToast: state.dismissToast,
    meetings: state.meetings,
    redo: state.redo,
    selectMeeting: state.selectMeeting,
    selectedMeetingId: state.selectedMeetingId,
    selectedProjectId: state.selectedProjectId,
    toasts: state.toasts,
    undo: state.undo,
  })));
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createMeetingOpen, setCreateMeetingOpen] = useState(false);
  const [newMeetingProjectId, setNewMeetingProjectId] = useState<string | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<{ section?: SettingsSection } | null>(null);

  useEffect(() => {
    const cleanup = listenForAssistantEvent(CHAT_SETTINGS_EVENT, () => setSettingsOpen({ section: "text-model" }));
    return () => { void cleanup.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    function openReference(reference: AssistantReference): void {
      if (!workspace.meetings.some((meeting) => meeting.id === reference.meetingId)) return;
      workspace.selectMeeting(reference.meetingId);
      window.setTimeout(() => focusTranscriptTime(reference.meetingId, reference.timeMs), 100);
    }

    let disposed = false;
    let unlisten = (): void => {};
    const stopBrowserListener = listenForBrowserReference(openReference);
    void listenForAssistantEvent<AssistantReference>(ASSISTANT_REFERENCE_EVENT, openReference)
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      });
    return () => {
      disposed = true;
      unlisten();
      stopBrowserListener();
    };
  }, [workspace.meetings, workspace.selectMeeting]);

  useEffect(() => {
    let disposed = false;
    let focusTimer: number | null = null;
    let unlisten = (): void => {};
    void listenForAssistantEvent<string>(ASSISTANT_ATTACHED_EVENT, (meetingId) => {
      if (!workspace.meetings.some((meeting) => meeting.id === meetingId)) return;
      workspace.selectMeeting(meetingId);
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(focusChat, 80);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten();
      if (focusTimer !== null) window.clearTimeout(focusTimer);
    };
  }, [workspace.meetings, workspace.selectMeeting]);

  const selectedMeeting = useMemo(
    () => workspace.meetings.find((meeting) => meeting.id === workspace.selectedMeetingId) ?? null,
    [workspace.meetings, workspace.selectedMeetingId],
  );

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent): void {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier) return;
      const editingText = event.target instanceof Element && event.target.matches("input, textarea, [contenteditable='true']");
      const key = event.key.toLowerCase();
      const dialogOpen = Boolean(document.querySelector('[role="dialog"]'));

      if (dialogOpen) return;

      if (key === "n" && event.shiftKey) {
        event.preventDefault();
        setCreateProjectOpen(true);
      } else if (key === "n") {
        event.preventDefault();
        openCreateMeeting(workspace.selectedProjectId);
      } else if (key === ",") {
        event.preventDefault();
        setSettingsOpen({});
      } else if (key === "k") {
        event.preventDefault();
        focusChat();
      } else if (key === "r" && event.shiftKey && selectedMeeting) {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(`[data-record-meeting="${selectedMeeting.id}"]`)?.click();
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
  }, [selectedMeeting, workspace.redo, workspace.selectedProjectId, workspace.undo]);
  function openCreateMeeting(projectId: string | null): void {
    setNewMeetingProjectId(projectId);
    setCreateMeetingOpen(true);
  }

  const openSettings = useEventCallback((section?: SettingsSection): void => {
    setSettingsOpen({ section });
  });
  const openPeople = useEventCallback(() => setPeopleOpen(true));

  return (
    <div className="app-shell">
      <Sidebar
        onCreateProject={() => setCreateProjectOpen(true)}
        onCreateMeeting={openCreateMeeting}
        onOpenPeople={openPeople}
        onOpenSettings={openSettings}
      />

      <div className="workspace-main">
        {selectedMeeting ? (
          <MeetingView
            meeting={selectedMeeting}
            onOpenPeople={openPeople}
            onOpenSettings={openSettings}
          />
        ) : (
          <EmptyState hasMeetings={workspace.meetings.length > 0} onCreateMeeting={() => openCreateMeeting(workspace.selectedProjectId)} />
        )}
      </div>

      <ToastViewport toasts={workspace.toasts} onDismiss={workspace.dismissToast}>
        <AppUpdater recording={workspace.meetings.some((meeting) => meeting.status === "recording")} />
      </ToastViewport>

      <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />
      <CreateMeetingDialog open={createMeetingOpen} initialProjectId={newMeetingProjectId} onClose={() => setCreateMeetingOpen(false)} />
      <PeopleDialog open={peopleOpen} onClose={() => setPeopleOpen(false)} />
      <SettingsDialog open={settingsOpen !== null} initialSection={settingsOpen?.section} onClose={() => setSettingsOpen(null)} />
    </div>
  );
}

function focusChat(): void {
  const control = document.querySelector<HTMLElement>("[data-ask-composer]");
  if (control instanceof HTMLButtonElement) control.click();
  else if (control) control.focus();
  else void focusAssistantWindow();
}
