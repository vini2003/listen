import { create } from "zustand";
import type {
  AppSettings,
  Meeting,
  MeetingDraft,
  MeetingPlacement,
  PersonDraft,
  ProjectDraft,
  RecordingLevels,
  WorkspaceSnapshot,
} from "../domain/models";
import { friendlyError } from "../lib/errors";
import { desktop, type RecordingRequest } from "../services/desktop";

export interface AppToast {
  id: number;
  message: string;
}

interface HistoryEntry {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

interface WorkspaceState extends WorkspaceSnapshot {
  selectedMeetingId: string | null;
  selectedProjectId: string | null;
  loading: boolean;
  busy: boolean;
  recordingPaused: boolean;
  toasts: AppToast[];
  canUndo: boolean;
  canRedo: boolean;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  selectMeeting: (id: string) => void;
  selectProject: (id: string | null) => void;
  createProject: (draft: ProjectDraft) => Promise<boolean>;
  renameProject: (id: string, name: string) => Promise<boolean>;
  deleteProject: (id: string) => Promise<boolean>;
  reorderProjects: (ids: string[]) => Promise<boolean>;
  createMeeting: (draft: MeetingDraft) => Promise<Meeting | null>;
  renameMeeting: (id: string, title: string) => Promise<boolean>;
  moveMeeting: (id: string, projectId: string | null) => Promise<boolean>;
  reorderMeeting: (id: string, projectId: string | null, index: number) => Promise<boolean>;
  deleteMeeting: (id: string) => Promise<boolean>;
  createPerson: (draft: PersonDraft) => Promise<boolean>;
  updatePerson: (id: string, draft: PersonDraft) => Promise<boolean>;
  deletePerson: (id: string) => Promise<boolean>;
  assignSpeaker: (meetingId: string, speakerLabel: string, personId: string | null) => Promise<boolean>;
  updateSettings: (settings: AppSettings) => Promise<boolean>;
  setApiKey: (apiKey: string) => Promise<boolean>;
  setPyannoteApiKey: (apiKey: string) => Promise<boolean>;
  openDiagnostics: () => Promise<boolean>;
  startRecording: (request: RecordingRequest) => Promise<boolean>;
  stopRecording: (meetingId: string) => Promise<boolean>;
  setRecordingPaused: (meetingId: string, paused: boolean) => Promise<boolean>;
  getRecordingLevels: (meetingId: string) => Promise<RecordingLevels>;
  transcribeMeeting: (meetingId: string) => Promise<boolean>;
  loadSegmentAudio: (meetingId: string, startMs: number, endMs: number) => Promise<string>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  dismissToast: (id: number) => void;
}

const emptySnapshot: WorkspaceSnapshot = {
  projects: [],
  meetings: [],
  people: [],
  segments: [],
  devices: [],
  settings: {
    microphoneDeviceId: null,
    systemDeviceId: null,
    captureMicrophone: true,
    captureSystem: true,
    theme: "system",
    apiKeyConfigured: false,
    pyannoteApiKeyConfigured: false,
  },
};

export const useWorkspace = create<WorkspaceState>((set, get) => {
  let recoveryStarted = false;
  let nextToastId = 1;
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];

  function showError(error: unknown): void {
    const toast = { id: nextToastId++, message: friendlyError(error) };
    set((state) => ({ toasts: [...state.toasts.slice(-3), toast] }));
  }

  function syncHistoryState(): void {
    set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  }

  function remember(entry: HistoryEntry): void {
    undoStack.push(entry);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    syncHistoryState();
  }

  async function run<T>(action: () => Promise<T>): Promise<T | null> {
    set({ busy: true });
    try {
      return await action();
    } catch (error) {
      showError(error);
      return null;
    } finally {
      set({ busy: false });
    }
  }

  async function refresh(): Promise<void> {
    const snapshot = await desktop.loadWorkspace();
    set(snapshot);
  }

  async function runHistory(direction: "undo" | "redo"): Promise<void> {
    const source = direction === "undo" ? undoStack : redoStack;
    const destination = direction === "undo" ? redoStack : undoStack;
    const entry = source.pop();
    if (!entry) return;

    set({ busy: true });
    try {
      await (direction === "undo" ? entry.undo() : entry.redo());
      await refresh();
      destination.push(entry);
    } catch (error) {
      source.push(entry);
      showError(error);
    } finally {
      set({ busy: false });
      syncHistoryState();
    }
  }

  function currentPlacements(): MeetingPlacement[] {
    return get().meetings.map(({ id, projectId, position }) => ({ id, projectId, position }));
  }

  function placementsAfterMove(
    meetingId: string,
    projectId: string | null,
    targetIndex: number,
  ): MeetingPlacement[] {
    const meetings = [...get().meetings].sort((a, b) => a.position - b.position);
    const moving = meetings.find((meeting) => meeting.id === meetingId);
    if (!moving) return currentPlacements();
    const sourceGroup = meetings.filter((meeting) => meeting.projectId === moving.projectId);
    const sourceIndex = sourceGroup.findIndex((meeting) => meeting.id === meetingId);
    const adjustedTargetIndex = moving.projectId === projectId && sourceIndex < targetIndex
      ? targetIndex - 1
      : targetIndex;

    const projectKeys = new Set(meetings.map((meeting) => meeting.projectId ?? "__unsorted__"));
    projectKeys.add(projectId ?? "__unsorted__");
    const placements: MeetingPlacement[] = [];

    for (const key of projectKeys) {
      const destinationProjectId = key === "__unsorted__" ? null : key;
      const group = meetings.filter(
        (meeting) => meeting.id !== meetingId && meeting.projectId === destinationProjectId,
      );
      if (destinationProjectId === projectId) {
        group.splice(Math.max(0, Math.min(adjustedTargetIndex, group.length)), 0, {
          ...moving,
          projectId,
        });
      }
      group.forEach((meeting, position) => {
        placements.push({ id: meeting.id, projectId: destinationProjectId, position });
      });
    }

    return placements;
  }

  async function applyPlacements(
    before: MeetingPlacement[],
    after: MeetingPlacement[],
  ): Promise<boolean> {
    if (JSON.stringify(before) === JSON.stringify(after)) return true;
    const succeeded = await run(async () => {
      await desktop.reorderMeetings(after);
      await refresh();
      return true;
    });
    if (!succeeded) return false;

    remember({
      undo: () => desktop.reorderMeetings(before),
      redo: () => desktop.reorderMeetings(after),
    });
    return true;
  }

  async function resumeInterruptedTranscriptions(meetingIds: string[]): Promise<void> {
    for (const meetingId of meetingIds) {
      try {
        await desktop.transcribeMeeting(meetingId);
      } catch (error) {
        showError(error);
      } finally {
        await refresh();
      }
    }
  }

  return {
    ...emptySnapshot,
    selectedMeetingId: null,
    selectedProjectId: null,
    loading: true,
    busy: false,
    recordingPaused: false,
    toasts: [],
    canUndo: false,
    canRedo: false,

    async load() {
      set({ loading: true });
      try {
        const snapshot = await desktop.loadWorkspace();
        set({
          ...snapshot,
          selectedMeetingId: snapshot.meetings[0]?.id ?? null,
        });
        const selected = snapshot.meetings[0];
        if (selected?.status === "failed" && selected.errorMessage) {
          showError(selected.errorMessage);
        }
        if (!recoveryStarted) {
          recoveryStarted = true;
          const interruptedMeetingIds = snapshot.meetings
            .filter((meeting) => meeting.status === "processing" && meeting.durationMs > 0)
            .map((meeting) => meeting.id);
          if (interruptedMeetingIds.length > 0) {
            void resumeInterruptedTranscriptions(interruptedMeetingIds);
          }
        }
      } catch (error) {
        showError(error);
      } finally {
        set({ loading: false });
      }
    },

    refresh,

    selectMeeting(id) {
      const meeting = get().meetings.find((candidate) => candidate.id === id);
      set({ selectedMeetingId: id, selectedProjectId: meeting?.projectId ?? null });
      if (meeting?.status === "failed" && meeting.errorMessage) showError(meeting.errorMessage);
    },

    selectProject(id) {
      set({ selectedProjectId: id, selectedMeetingId: null });
    },

    async createProject(draft) {
      const created = await run(async () => {
        const project = await desktop.createProject(draft);
        await refresh();
        return project;
      });
      return created !== null;
    },

    async renameProject(id, name) {
      const project = get().projects.find((candidate) => candidate.id === id);
      if (!project || project.name === name) return true;
      const previousName = project.name;
      const succeeded = await run(async () => {
        await desktop.renameProject(id, name);
        await refresh();
        return true;
      });
      if (!succeeded) return false;
      remember({
        undo: async () => { await desktop.renameProject(id, previousName); },
        redo: async () => { await desktop.renameProject(id, name); },
      });
      return true;
    },

    async deleteProject(id) {
      const succeeded = await run(async () => {
        await desktop.deleteProject(id);
        await refresh();
        if (get().selectedProjectId === id) set({ selectedProjectId: null });
        return true;
      });
      return succeeded === true;
    },

    async reorderProjects(ids) {
      const previousIds = get().projects.map((project) => project.id);
      if (previousIds.join() === ids.join()) return true;
      const succeeded = await run(async () => {
        await desktop.reorderProjects(ids);
        await refresh();
        return true;
      });
      if (!succeeded) return false;
      remember({
        undo: () => desktop.reorderProjects(previousIds),
        redo: () => desktop.reorderProjects(ids),
      });
      return true;
    },

    async createMeeting(draft) {
      return run(async () => {
        const created = await desktop.createMeeting(draft);
        await refresh();
        set({ selectedMeetingId: created.id, selectedProjectId: created.projectId });
        return created;
      });
    },

    async renameMeeting(id, title) {
      const meeting = get().meetings.find((candidate) => candidate.id === id);
      if (!meeting || meeting.title === title) return true;
      const previousTitle = meeting.title;
      const succeeded = await run(async () => {
        await desktop.renameMeeting(id, title);
        await refresh();
        return true;
      });
      if (!succeeded) return false;
      remember({
        undo: async () => { await desktop.renameMeeting(id, previousTitle); },
        redo: async () => { await desktop.renameMeeting(id, title); },
      });
      return true;
    },

    async moveMeeting(id, projectId) {
      const targetCount = get().meetings.filter((meeting) => meeting.projectId === projectId).length;
      return get().reorderMeeting(id, projectId, targetCount);
    },

    async reorderMeeting(id, projectId, index) {
      const before = currentPlacements();
      const after = placementsAfterMove(id, projectId, index);
      const succeeded = await applyPlacements(before, after);
      if (succeeded) set({ selectedProjectId: projectId });
      return succeeded;
    },

    async deleteMeeting(id) {
      const meeting = get().meetings.find((candidate) => candidate.id === id);
      if (!meeting) return false;
      const succeeded = await run(async () => {
        await desktop.deleteMeeting(id);
        await refresh();
        if (get().selectedMeetingId === id) {
          const nextMeeting = get().meetings[0] ?? null;
          set({
            selectedMeetingId: nextMeeting?.id ?? null,
            selectedProjectId: nextMeeting?.projectId ?? null,
          });
        }
        return true;
      });
      if (!succeeded) return false;
      remember({
        undo: async () => { await desktop.restoreMeeting(id); },
        redo: async () => { await desktop.deleteMeeting(id); },
      });
      return true;
    },

    async createPerson(draft) {
      const result = await run(async () => {
        await desktop.createPerson(draft);
        await refresh();
        return true;
      });
      return result === true;
    },

    async updatePerson(id, draft) {
      const result = await run(async () => {
        await desktop.updatePerson(id, draft);
        await refresh();
        return true;
      });
      return result === true;
    },

    async deletePerson(id) {
      const result = await run(async () => {
        await desktop.deletePerson(id);
        await refresh();
        return true;
      });
      return result === true;
    },

    async assignSpeaker(meetingId, speakerLabel, personId) {
      const previousSegments = get().segments;
      const previousPersonId = previousSegments.find(
        (segment) => segment.meetingId === meetingId && segment.speakerLabel === speakerLabel,
      )?.personId ?? null;
      set((state) => ({
        segments: state.segments.map((segment) =>
          segment.meetingId === meetingId && segment.speakerLabel === speakerLabel
            ? { ...segment, personId }
            : segment),
      }));
      try {
        await desktop.assignSpeaker(meetingId, speakerLabel, personId);
        await refresh();
        remember({
          undo: () => desktop.assignSpeaker(meetingId, speakerLabel, previousPersonId),
          redo: () => desktop.assignSpeaker(meetingId, speakerLabel, personId),
        });
        return true;
      } catch (error) {
        set({ segments: previousSegments });
        showError(error);
        return false;
      }
    },

    async updateSettings(settings) {
      const result = await run(async () => {
        await desktop.updateSettings(settings);
        await refresh();
        return true;
      });
      return result === true;
    },

    async setApiKey(apiKey) {
      const result = await run(async () => {
        await desktop.setApiKey(apiKey);
        await refresh();
        return true;
      });
      return result === true;
    },

    async setPyannoteApiKey(apiKey) {
      const result = await run(async () => {
        await desktop.setPyannoteApiKey(apiKey);
        await refresh();
        return true;
      });
      return result === true;
    },

    async openDiagnostics() {
      const result = await run(async () => {
        await desktop.openDiagnostics();
        return true;
      });
      return result === true;
    },

    async startRecording(request) {
      const result = await run(async () => {
        set({ recordingPaused: false });
        await desktop.startRecording(request);
        await refresh();
        return true;
      });
      return result === true;
    },

    async stopRecording(meetingId) {
      const stopped = await run(async () => {
        await desktop.stopRecording(meetingId);
        await refresh();
        set({ recordingPaused: false });
        return true;
      });
      if (!stopped) return false;
      if (!get().settings.pyannoteApiKeyConfigured) return true;

      set((state) => ({
        meetings: state.meetings.map((meeting) => meeting.id === meetingId
          ? { ...meeting, status: "processing", errorMessage: null }
          : meeting),
      }));
      try {
        await desktop.transcribeMeeting(meetingId);
      } catch (error) {
        showError(error);
      } finally {
        await refresh();
      }
      return true;
    },

    async setRecordingPaused(meetingId, paused) {
      const result = await run(async () => {
        await desktop.setRecordingPaused(meetingId, paused);
        set({ recordingPaused: paused });
        return true;
      });
      return result === true;
    },

    getRecordingLevels(meetingId) {
      return desktop.recordingLevels(meetingId);
    },

    async transcribeMeeting(meetingId) {
      set({ busy: true });
      try {
        await desktop.transcribeMeeting(meetingId);
        return true;
      } catch (error) {
        showError(error);
        return false;
      } finally {
        await refresh();
        set({ busy: false });
      }
    },

    async loadSegmentAudio(meetingId, startMs, endMs) {
      try {
        return await desktop.loadSegmentAudio(meetingId, startMs, endMs);
      } catch (error) {
        showError(error);
        throw error;
      }
    },

    undo: () => runHistory("undo"),
    redo: () => runHistory("redo"),
    dismissToast: (id) => set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
  };
});
