import { create } from "zustand";
import type {
  AppSettings,
  ChatMessage,
  ChatScope,
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
  segmentsLoading: boolean;
  recordingPaused: boolean;
  chatMessages: ChatMessage[];
  chatScopeKey: string | null;
  chatLoading: boolean;
  chatBusy: boolean;
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
  deleteTranscriptSegments: (ids: string[]) => Promise<boolean>;
  eraseVoiceProfile: (personId: string) => Promise<boolean>;
  eraseAllVoiceProfiles: () => Promise<boolean>;
  enableVoiceLabeling: (personId: string) => Promise<boolean>;
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
  loadMeetingAudioUrl: (meetingId: string) => Promise<string>;
  loadChat: (scope: ChatScope) => Promise<void>;
  completeChat: (scope: ChatScope, content: string, messageId?: string | null) => Promise<boolean>;
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
    localSpeakerPersonId: null,
    preferLocalSpeakerForMicrophone: true,
  },
};

export const useWorkspace = create<WorkspaceState>((set, get) => {
  let recoveryStarted = false;
  let nextToastId = 1;
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  const enrollmentInFlight = new Set<string>();

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

  function storeMeeting(meeting: Meeting): void {
    set((state) => ({
      meetings: state.meetings.map((candidate) => candidate.id === meeting.id ? meeting : candidate),
    }));
  }

  function storePerson(person: WorkspaceSnapshot["people"][number]): void {
    set((state) => ({
      people: state.people.map((candidate) => candidate.id === person.id ? person : candidate),
    }));
  }

  async function loadSegmentsForMeeting(meetingId: string): Promise<void> {
    try {
      const segments = await desktop.loadMeetingSegments(meetingId);
      if (get().selectedMeetingId === meetingId) set({ segments, segmentsLoading: false });
    } catch (error) {
      if (get().selectedMeetingId === meetingId) {
        set({ segmentsLoading: false });
        showError(error);
      }
    }
  }

  async function enrollBestAvailableAssignment(personId: string): Promise<void> {
    try {
      const assigned = await desktop.findVoiceEnrollmentSegment(personId);
      if (assigned) await enrollFromAssignment(assigned.meetingId, assigned.speakerLabel, personId);
    } catch (error) {
      showError(error);
    }
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
    const currentMeetingId = get().selectedMeetingId;
    const selectedMeeting = snapshot.meetings.find((meeting) => meeting.id === currentMeetingId)
      ?? snapshot.meetings[0]
      ?? null;
    const segments = selectedMeeting
      ? await desktop.loadMeetingSegments(selectedMeeting.id)
      : [];
    set({
      ...snapshot,
      segments,
      segmentsLoading: false,
      selectedMeetingId: selectedMeeting?.id ?? null,
      selectedProjectId: selectedMeeting?.projectId ?? get().selectedProjectId,
    });
  }

  async function enrollFromAssignment(meetingId: string, speakerLabel: string, personId: string): Promise<void> {
    const state = get();
    const person = state.people.find((candidate) => candidate.id === personId);
    if (!person
      || !state.settings.pyannoteApiKeyConfigured
      || person.voiceProfile?.status === "ready"
      || person.voiceProfile?.status === "learning"
      || person.voiceProfile?.status === "disabled"
      || enrollmentInFlight.has(personId)) return;
    enrollmentInFlight.add(personId);
    try {
      const person = await desktop.enrollVoiceProfile(meetingId, speakerLabel, personId);
      storePerson(person);
    } catch (error) {
      showError(error);
    } finally {
      enrollmentInFlight.delete(personId);
    }
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
      const placements = new Map(after.map((placement) => [placement.id, placement]));
      set((state) => ({
        meetings: state.meetings.map((meeting) => {
          const placement = placements.get(meeting.id);
          return placement ? { ...meeting, projectId: placement.projectId, position: placement.position } : meeting;
        }),
      }));
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
        storeMeeting(await desktop.transcribeMeeting(meetingId));
        if (get().selectedMeetingId === meetingId) await loadSegmentsForMeeting(meetingId);
      } catch (error) {
        showError(error);
      }
    }
  }

  return {
    ...emptySnapshot,
    selectedMeetingId: null,
    selectedProjectId: null,
    loading: true,
    busy: false,
    segmentsLoading: false,
    recordingPaused: false,
    chatMessages: [],
    chatScopeKey: null,
    chatLoading: false,
    chatBusy: false,
    toasts: [],
    canUndo: false,
    canRedo: false,

    async load() {
      set({ loading: true });
      try {
        const snapshot = await desktop.loadWorkspace();
        const selectedMeetingId = snapshot.meetings[0]?.id ?? null;
        const segments = selectedMeetingId
          ? await desktop.loadMeetingSegments(selectedMeetingId)
          : [];
        set({
          ...snapshot,
          segments,
          segmentsLoading: false,
          selectedMeetingId,
          selectedProjectId: snapshot.meetings[0]?.projectId ?? null,
        });
        if (snapshot.settings.pyannoteApiKeyConfigured) {
          // Serialized on purpose: each retry may decode and upload meeting audio.
          void (async () => {
            for (const person of snapshot.people) {
              const status = person.voiceProfile?.status;
              // No profile row means an upgrader whose labeled people never enrolled.
              if (status !== undefined && status !== "pending_sample") continue;
              await enrollBestAvailableAssignment(person.id);
            }
          })();
        }
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
      set({ selectedMeetingId: id, selectedProjectId: meeting?.projectId ?? null, segments: [], segmentsLoading: true });
      void loadSegmentsForMeeting(id);
      if (meeting?.status === "failed" && meeting.errorMessage) showError(meeting.errorMessage);
    },

    selectProject(id) {
      set({ selectedProjectId: id, selectedMeetingId: null, segments: [], segmentsLoading: false });
    },

    async createProject(draft) {
      const created = await run(async () => {
        const project = await desktop.createProject(draft);
        set((state) => ({ projects: [...state.projects, project] }));
        return project;
      });
      return created !== null;
    },

    async renameProject(id, name) {
      const project = get().projects.find((candidate) => candidate.id === id);
      if (!project || project.name === name) return true;
      const previousName = project.name;
      const succeeded = await run(async () => {
        const renamed = await desktop.renameProject(id, name);
        set((state) => ({
          projects: state.projects.map((candidate) => candidate.id === id ? renamed : candidate),
        }));
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
        set((state) => ({
          projects: state.projects.filter((project) => project.id !== id),
          meetings: state.meetings.map((meeting) => meeting.projectId === id
            ? { ...meeting, projectId: null }
            : meeting),
          selectedProjectId: state.selectedProjectId === id ? null : state.selectedProjectId,
        }));
        return true;
      });
      return succeeded === true;
    },

    async reorderProjects(ids) {
      const previousIds = get().projects.map((project) => project.id);
      if (previousIds.join() === ids.join()) return true;
      const succeeded = await run(async () => {
        await desktop.reorderProjects(ids);
        const positions = new Map(ids.map((id, position) => [id, position]));
        set((state) => ({
          projects: state.projects
            .map((project) => ({ ...project, position: positions.get(project.id) ?? project.position }))
            .sort((a, b) => a.position - b.position),
        }));
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
        set((state) => ({
          meetings: [
            created,
            ...state.meetings.map((meeting) => meeting.projectId === created.projectId
              ? { ...meeting, position: meeting.position + 1 }
              : meeting),
          ],
          segments: [],
          segmentsLoading: false,
          selectedMeetingId: created.id,
          selectedProjectId: created.projectId,
        }));
        return created;
      });
    },

    async renameMeeting(id, title) {
      const meeting = get().meetings.find((candidate) => candidate.id === id);
      if (!meeting || meeting.title === title) return true;
      const previousTitle = meeting.title;
      const succeeded = await run(async () => {
        storeMeeting(await desktop.renameMeeting(id, title));
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
        const state = get();
        const remaining = state.meetings.filter((candidate) => candidate.id !== id);
        const deletingSelected = state.selectedMeetingId === id;
        const nextMeeting = deletingSelected ? remaining[0] ?? null : null;
        set({
          meetings: remaining,
          ...(deletingSelected ? {
            segments: [],
            segmentsLoading: nextMeeting !== null,
            selectedMeetingId: nextMeeting?.id ?? null,
            selectedProjectId: nextMeeting?.projectId ?? null,
          } : {}),
        });
        if (nextMeeting) void loadSegmentsForMeeting(nextMeeting.id);
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
        const person = await desktop.createPerson(draft);
        set((state) => ({ people: [...state.people, person] }));
        return true;
      });
      return result === true;
    },

    async updatePerson(id, draft) {
      const result = await run(async () => {
        storePerson(await desktop.updatePerson(id, draft));
        return true;
      });
      return result === true;
    },

    async deletePerson(id) {
      const result = await run(async () => {
        await desktop.deletePerson(id);
        set((state) => ({
          people: state.people.filter((person) => person.id !== id),
          segments: state.segments.map((segment) => segment.personId === id
            ? { ...segment, personId: null }
            : segment),
          settings: state.settings.localSpeakerPersonId === id
            ? { ...state.settings, localSpeakerPersonId: null }
            : state.settings,
        }));
        return true;
      });
      return result === true;
    },

    async assignSpeaker(meetingId, speakerLabel, personId) {
      const selectedMeetingId = get().selectedMeetingId;
      const previousSegments = get().segments;
      const previousSegment = previousSegments.find(
        (segment) => segment.meetingId === meetingId && segment.speakerLabel === speakerLabel,
      );
      const previousPersonId = previousSegment?.personId ?? null;
      const previousIdentitySource = previousSegment?.identitySource ?? null;
      set((state) => ({
        segments: state.segments.map((segment) =>
          segment.meetingId === meetingId && segment.speakerLabel === speakerLabel
            ? { ...segment, personId, identitySource: personId ? "manual" as const : null, identityConfidence: null }
            : segment),
      }));
      try {
        await desktop.assignSpeaker(meetingId, speakerLabel, personId);
        remember({
          // Restoring the original identity source keeps machine-attributed
          // labels out of the manual-only enrollment pool after an undo.
          undo: () => desktop.assignSpeaker(meetingId, speakerLabel, previousPersonId, previousIdentitySource),
          redo: () => desktop.assignSpeaker(meetingId, speakerLabel, personId),
        });
        if (personId) {
          void (async () => {
            await enrollBestAvailableAssignment(personId);
            const profile = get().people.find((candidate) => candidate.id === personId)?.voiceProfile;
            // The globally-longest segment can be chronically unusable
            // (crosstalk); fall back to the passage the user just labeled.
            if (profile?.status !== "ready" && profile?.status !== "learning") {
              await enrollFromAssignment(meetingId, speakerLabel, personId);
            }
          })();
        }
        return true;
      } catch (error) {
        if (get().selectedMeetingId === selectedMeetingId) set({ segments: previousSegments });
        showError(error);
        return false;
      }
    },

    async deleteTranscriptSegments(ids) {
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length === 0) return false;
      const selectedMeetingId = get().selectedMeetingId;
      const previousSegments = get().segments;
      const idSet = new Set(uniqueIds);
      set((state) => ({
        segments: state.segments.filter((segment) => !idSet.has(segment.id)),
      }));
      try {
        const backups = await desktop.deleteTranscriptSegments(uniqueIds);
        remember({
          undo: () => desktop.restoreTranscriptSegments(backups),
          redo: async () => { await desktop.deleteTranscriptSegments(uniqueIds); },
        });
        return true;
      } catch (error) {
        if (get().selectedMeetingId === selectedMeetingId) set({ segments: previousSegments });
        showError(error);
        return false;
      }
    },

    async eraseVoiceProfile(personId) {
      const result = await run(async () => {
        storePerson(await desktop.forgetVoiceProfile(personId));
        return true;
      });
      return result === true;
    },

    async eraseAllVoiceProfiles() {
      const result = await run(async () => {
        await desktop.forgetAllVoiceProfiles();
        set((state) => ({
          people: state.people.map((person) => person.voiceProfile
            ? {
                ...person,
                voiceProfile: {
                  status: "disabled" as const,
                  enrollmentDurationMs: null,
                  enrollmentClipCount: null,
                  source: null,
                  updatedAt: new Date().toISOString(),
                  lastError: null,
                },
              }
            : person),
        }));
        return true;
      });
      return result === true;
    },

    async enableVoiceLabeling(personId) {
      const result = await run(async () => {
        storePerson(await desktop.enableVoiceProfile(personId));
        return true;
      });
      if (result !== true) return false;
      void enrollBestAvailableAssignment(personId);
      return true;
    },

    async updateSettings(settings) {
      const result = await run(async () => {
        set({ settings: await desktop.updateSettings(settings) });
        return true;
      });
      return result === true;
    },

    async setApiKey(apiKey) {
      const result = await run(async () => {
        const configured = await desktop.setApiKey(apiKey);
        set((state) => ({
          settings: { ...state.settings, apiKeyConfigured: configured },
        }));
        return true;
      });
      return result === true;
    },

    async setPyannoteApiKey(apiKey) {
      const result = await run(async () => {
        const configured = await desktop.setPyannoteApiKey(apiKey);
        set((state) => ({
          settings: { ...state.settings, pyannoteApiKeyConfigured: configured },
        }));
        return true;
      });
      if (result === true && apiKey.trim()) {
        // Detached so saving the key resolves immediately; serialized because
        // each retry may decode and upload meeting audio.
        void (async () => {
          for (const person of get().people) {
            const status = person.voiceProfile?.status;
            if (status === "ready" || status === "learning" || status === "disabled") continue;
            await enrollBestAvailableAssignment(person.id);
          }
        })();
      }
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
        storeMeeting(await desktop.startRecording(request));
        return true;
      });
      return result === true;
    },

    async stopRecording(meetingId) {
      const stopped = await run(async () => {
        storeMeeting(await desktop.stopRecording(meetingId));
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
        storeMeeting(await desktop.transcribeMeeting(meetingId));
      } catch (error) {
        showError(error);
      } finally {
        if (get().selectedMeetingId === meetingId) await loadSegmentsForMeeting(meetingId);
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
        storeMeeting(await desktop.transcribeMeeting(meetingId));
        if (get().selectedMeetingId === meetingId) await loadSegmentsForMeeting(meetingId);
        return true;
      } catch (error) {
        showError(error);
        return false;
      } finally {
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

    async loadMeetingAudioUrl(meetingId) {
      try {
        return await desktop.loadMeetingAudioUrl(meetingId);
      } catch (error) {
        showError(error);
        throw error;
      }
    },

    async loadChat(scope) {
      const scopeKey = `${scope.scopeType}:${scope.scopeId}`;
      set({ chatScopeKey: scopeKey, chatMessages: [], chatLoading: true });
      try {
        const messages = await desktop.loadChatMessages(scope);
        if (get().chatScopeKey === scopeKey) set({ chatMessages: messages });
      } catch (error) {
        showError(error);
      } finally {
        if (get().chatScopeKey === scopeKey) set({ chatLoading: false });
      }
    },

    async completeChat(scope, content, messageId = null) {
      const scopeKey = `${scope.scopeType}:${scope.scopeId}`;
      const clientMessageId = messageId ? null : crypto.randomUUID();
      const currentMessages = get().chatMessages;
      const optimisticId = messageId || clientMessageId!;
      const existing = messageId
        ? currentMessages.find((message) => message.id === messageId && message.role === "user")
        : null;
      const optimistic: ChatMessage = {
        id: optimisticId,
        ...scope,
        role: "user",
        content: content.trim(),
        position: existing?.position ?? currentMessages.length,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        pending: true,
      };
      const optimisticMessages = existing
        ? currentMessages
            .filter((message) => message.position <= existing.position)
            .map((message) => message.id === existing.id ? optimistic : message)
        : [...currentMessages, optimistic];
      set({ chatBusy: true, chatMessages: optimisticMessages });
      try {
        const messages = await desktop.completeChat(scope, content, messageId, clientMessageId);
        if (get().chatScopeKey === scopeKey) {
          const visibleIds = new Set(get().chatMessages.map((message) => message.id));
          set({
            chatMessages: messages.map((message) => visibleIds.has(message.id)
              ? message
              : { ...message, justArrived: true }),
          });
          window.setTimeout(() => {
            if (get().chatScopeKey === scopeKey) {
              set((state) => ({
                chatMessages: state.chatMessages.map(({ justArrived: _, ...message }) => message),
              }));
            }
          }, 450);
        }
        return true;
      } catch (error) {
        showError(error);
        try {
          const messages = await desktop.loadChatMessages(scope);
          if (get().chatScopeKey === scopeKey) set({ chatMessages: messages });
        } catch {
          // The original error is the useful one.
        }
        return false;
      } finally {
        set({ chatBusy: false });
      }
    },

    undo: () => runHistory("undo"),
    redo: () => runHistory("redo"),
    dismissToast: (id) => set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    })),
  };
});
