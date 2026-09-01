import { useEffect, useMemo, useState } from "react";
import { CreateMeetingDialog, CreateProjectDialog } from "./components/dialogs/CreateDialogs";
import { PeopleDialog } from "./components/dialogs/PeopleDialog";
import { PrivacyNoticeDialog } from "./components/dialogs/PrivacyNoticeDialog";
import { SettingsDialog, type SettingsSection } from "./components/dialogs/SettingsDialog";
import { EmptyState } from "./components/EmptyState";
import { MeetingView } from "./components/meeting/MeetingView";
import { Sidebar } from "./components/sidebar/Sidebar";
import { AppUpdater } from "./components/ui/AppUpdater";
import { ToastViewport } from "./components/ui/ToastViewport";
import { watchTheme } from "./lib/theme";
import { focusTranscriptTime } from "./lib/transcriptFocus";
import {
  ASSISTANT_ATTACHED_EVENT,
  ASSISTANT_REFERENCE_EVENT,
  focusAssistantWindow,
  listenForAssistantEvent,
  listenForBrowserReference,
  type AssistantReference,
} from "./services/assistantWindow";
import { PRIVACY_NOTICE_VERSION } from "./domain/privacy";
import { useWorkspace } from "./store/workspace";

export default function App() {
  const workspace = useWorkspace();
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createMeetingOpen, setCreateMeetingOpen] = useState(false);
  const [newMeetingProjectId, setNewMeetingProjectId] = useState<string | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<{ section?: SettingsSection } | null>(null);

  useEffect(() => { void workspace.load(); }, []);

  useEffect(() => watchTheme(workspace.settings.theme), [workspace.settings.theme]);

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
      focusTimer = window.setTimeout(() => {
        document.querySelector<HTMLTextAreaElement>("textarea[data-ask-composer]")?.focus();
      }, 80);
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
      const target = event.target as HTMLElement | null;
      const editingText = target?.matches("input, textarea, [contenteditable='true']") ?? false;
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
        const composer = document.querySelector<HTMLElement>("[data-ask-composer]");
        if (composer?.matches("textarea")) composer.focus();
        else void focusAssistantWindow();
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

  function openSettings(section?: SettingsSection): void {
    setSettingsOpen({ section });
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
        onOpenSettings={() => openSettings()}
      />

      <div className="workspace-main">
        {selectedMeeting ? (
          <MeetingView
            meeting={selectedMeeting}
            onOpenPeople={() => setPeopleOpen(true)}
            onOpenSettings={openSettings}
          />
        ) : (
          <EmptyState onCreateProject={() => setCreateProjectOpen(true)} onCreateMeeting={() => openCreateMeeting(null)} />
        )}
      </div>

      <ToastViewport toasts={workspace.toasts} onDismiss={workspace.dismissToast}>
        <AppUpdater recording={workspace.meetings.some((meeting) => meeting.status === "recording")} />
      </ToastViewport>

      <CreateProjectDialog open={createProjectOpen} onClose={() => setCreateProjectOpen(false)} />
      <CreateMeetingDialog open={createMeetingOpen} initialProjectId={newMeetingProjectId} onClose={() => setCreateMeetingOpen(false)} />
      <PeopleDialog open={peopleOpen} onClose={() => setPeopleOpen(false)} />
      <SettingsDialog open={settingsOpen !== null} initialSection={settingsOpen?.section} onClose={() => setSettingsOpen(null)} />
      <PrivacyNoticeDialog open={workspace.settings.privacyNoticeVersion !== PRIVACY_NOTICE_VERSION} />
    </div>
  );
}
