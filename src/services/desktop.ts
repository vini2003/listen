import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AssistantContext,
  AppSettings,
  ChatMessage,
  ChatScope,
  Folder,
  FolderDraft,
  MediaImportFile,
  MediaImportProgress,
  Meeting,
  MeetingDraft,
  MeetingPlacement,
  Person,
  PersonDraft,
  Project,
  ProjectDraft,
  RecordingLevels,
  SpeechModelsStatus,
  TranscriptionPhase,
  TranscriptionProgress,
  TranscriptSegment,
  TranscriptSegmentBackup,
  WorkspaceSnapshot,
} from "../domain/models";
import { MAX_PLAYBACK_MS, silentWavDataUrl } from "../lib/previewAudio";

export interface RecordingRequest {
  meetingId: string;
  microphoneDeviceId: string | null;
  systemDeviceId: string | null;
  captureMicrophone: boolean;
  captureSystem: boolean;
}

export interface DesktopService {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  loadAssistantContext(meetingId: string): Promise<AssistantContext>;
  loadMeetingSegments(meetingId: string): Promise<TranscriptSegment[]>;
  findVoiceEnrollmentSegment(personId: string): Promise<TranscriptSegment | null>;
  createProject(draft: ProjectDraft): Promise<Project>;
  renameProject(id: string, name: string): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  reorderProjects(ids: string[]): Promise<void>;
  createFolder(draft: FolderDraft): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<Folder>;
  moveFolder(id: string, parentId: string | null): Promise<Folder>;
  deleteFolder(id: string): Promise<void>;
  createMeeting(draft: MeetingDraft): Promise<Meeting>;
  pickMeetingMedia(): Promise<MediaImportFile | null>;
  importMeetingMedia(target: string | MeetingDraft, path: string, progress: (value: number | null) => void): Promise<Meeting>;
  renameMeeting(id: string, title: string): Promise<Meeting>;
  moveMeeting(id: string, projectId: string | null): Promise<Meeting>;
  reorderMeetings(placements: MeetingPlacement[]): Promise<void>;
  deleteMeeting(id: string): Promise<void>;
  restoreMeeting(id: string): Promise<Meeting>;
  createPerson(draft: PersonDraft): Promise<Person>;
  updatePerson(id: string, draft: PersonDraft): Promise<Person>;
  deletePerson(id: string): Promise<void>;
  assignSpeaker(meetingId: string, speakerLabel: string, personId: string | null, identitySource?: TranscriptSegment["identitySource"]): Promise<void>;
  deleteTranscriptSegments(ids: string[]): Promise<TranscriptSegmentBackup[]>;
  restoreTranscriptSegments(backups: TranscriptSegmentBackup[]): Promise<void>;
  forgetVoiceProfile(personId: string): Promise<Person>;
  forgetAllVoiceProfiles(): Promise<void>;
  enableVoiceProfile(personId: string): Promise<Person>;
  enrollVoiceProfile(meetingId: string, speakerLabel: string, personId: string): Promise<Person>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  setApiKey(apiKey: string): Promise<boolean>;
  speechModelsStatus(): Promise<SpeechModelsStatus>;
  downloadSpeechModels(): Promise<SpeechModelsStatus>;
  cancelSpeechModelsDownload(): Promise<void>;
  removeSpeechModels(): Promise<SpeechModelsStatus>;
  transcriptionProgress(): Promise<TranscriptionProgress[]>;
  onSpeechModels(handler: (status: SpeechModelsStatus) => void): Promise<() => void>;
  onTranscriptionProgress(handler: (progress: TranscriptionProgress) => void): Promise<() => void>;
  openDiagnostics(): Promise<void>;
  startRecording(request: RecordingRequest): Promise<Meeting>;
  stopRecording(meetingId: string): Promise<Meeting>;
  setRecordingPaused(meetingId: string, paused: boolean): Promise<void>;
  recordingLevels(meetingId: string): Promise<RecordingLevels>;
  transcribeMeeting(meetingId: string): Promise<Meeting>;
  loadSegmentAudio(meetingId: string, startMs: number, endMs: number): Promise<string>;
  loadMeetingAudioUrl(meetingId: string): Promise<string>;
  loadChatMessages(scope: ChatScope): Promise<ChatMessage[]>;
  completeChat(scope: ChatScope, content: string, messageId?: string | null, clientMessageId?: string | null): Promise<ChatMessage[]>;
}

const personColors = ["#d96c4a", "#477a66", "#6256a5", "#b07a28", "#3c6e9b"];

const tauriService: DesktopService = {
  loadWorkspace: () => invoke("load_workspace"),
  loadAssistantContext: (meetingId) => invoke("load_assistant_context", { meetingId }),
  loadMeetingSegments: (meetingId) => invoke("load_meeting_segments", { meetingId }),
  findVoiceEnrollmentSegment: (personId) => invoke("find_voice_enrollment_segment", { personId }),
  createProject: (draft) => invoke("create_project", { draft }),
  renameProject: (id, name) => invoke("rename_project", { id, name }),
  deleteProject: (id) => invoke("delete_project", { id }),
  reorderProjects: (ids) => invoke("reorder_projects", { ids }),
  createFolder: (draft) => invoke("create_folder", { draft }),
  renameFolder: (id, name) => invoke("rename_folder", { id, name }),
  moveFolder: (id, parentId) => invoke("move_folder", { id, parentId }),
  deleteFolder: (id) => invoke("delete_folder", { id }),
  createMeeting: (draft) => invoke("create_meeting", { draft }),
  async pickMeetingMedia() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      title: "Import audio or video",
      multiple: false,
      directory: false,
      filters: [{ name: "Audio and video", extensions: [
        "mp4", "m4v", "mov", "mkv", "webm", "m4a", "aac", "mp3", "wav", "flac", "ogg", "oga", "opus", "aif", "aiff", "caf",
      ] }],
    });
    return path ? { path, name: path.split(/[\\/]/).pop() || path } : null;
  },
  async importMeetingMedia(target, path, progress) {
    const meetingId = typeof target === "string" ? target : null;
    let active = true;
    const stop = await listen<MediaImportProgress>("listen://media-import", ({ payload }) => {
      if (active && payload.meetingId === meetingId) progress(payload.progress);
    });
    try {
      return await invoke<Meeting>("import_meeting_media", { path, meetingId, draft: typeof target === "string" ? null : target });
    } finally {
      active = false;
      stop();
    }
  },
  renameMeeting: (id, title) => invoke("rename_meeting", { id, title }),
  moveMeeting: (id, projectId) => invoke("move_meeting", { id, projectId }),
  reorderMeetings: (placements) => invoke("reorder_meetings", { placements }),
  deleteMeeting: (id) => invoke("delete_meeting", { id }),
  restoreMeeting: (id) => invoke("restore_meeting", { id }),
  createPerson: (draft) => invoke("create_person", { draft }),
  updatePerson: (id, draft) => invoke("update_person", { id, draft }),
  deletePerson: (id) => invoke("delete_person", { id }),
  assignSpeaker: (meetingId, speakerLabel, personId, identitySource) =>
    invoke("assign_speaker", { meetingId, speakerLabel, personId, identitySource: identitySource ?? null }),
  deleteTranscriptSegments: (ids) => invoke("delete_transcript_segments", { ids }),
  restoreTranscriptSegments: (backups) => invoke("restore_transcript_segments", { backups }),
  forgetVoiceProfile: (personId) => invoke("forget_voice_profile", { personId }),
  forgetAllVoiceProfiles: () => invoke("forget_all_voice_profiles"),
  enableVoiceProfile: (personId) => invoke("enable_voice_profile", { personId }),
  enrollVoiceProfile: (meetingId, speakerLabel, personId) =>
    invoke("enroll_voice_profile", { meetingId, speakerLabel, personId }),
  updateSettings: (settings) => invoke("update_settings", { settings }),
  setApiKey: (apiKey) => invoke("set_api_key", { apiKey }),
  speechModelsStatus: () => invoke("speech_models_status"),
  downloadSpeechModels: () => invoke("download_speech_models"),
  cancelSpeechModelsDownload: () => invoke("cancel_speech_models_download"),
  removeSpeechModels: () => invoke("remove_speech_models"),
  transcriptionProgress: () => invoke("transcription_progress"),
  onSpeechModels: (handler) =>
    listen<SpeechModelsStatus>("listen://speech-models", (event) => handler(event.payload)),
  onTranscriptionProgress: (handler) =>
    listen<TranscriptionProgress>("listen://transcription-progress", (event) => handler(event.payload)),
  openDiagnostics: () => invoke("open_diagnostics"),
  startRecording: (request) => invoke("start_recording", { request }),
  stopRecording: (meetingId) => invoke("stop_recording", { meetingId }),
  setRecordingPaused: (meetingId, paused) => invoke("set_recording_paused", { meetingId, paused }),
  recordingLevels: (meetingId) => invoke("recording_levels", { meetingId }),
  transcribeMeeting: (meetingId) => invoke("transcribe_meeting", { meetingId }),
  loadSegmentAudio: (meetingId, startMs, endMs) =>
    invoke("load_segment_audio", { meetingId, startMs, endMs }),
  loadMeetingAudioUrl: async (meetingId) =>
    convertFileSrc(await invoke("export_meeting_audio", { meetingId })),
  loadChatMessages: ({ scopeType, scopeId }) =>
    invoke("load_chat_messages", { scopeType, scopeId }),
  completeChat: ({ scopeType, scopeId }, content, messageId = null, clientMessageId = null) =>
    invoke("complete_chat", { scopeType, scopeId, content, messageId, clientMessageId }),
};

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export const desktop: DesktopService = isTauri()
  ? tauriService
  : createBrowserPreviewService();

function createBrowserPreviewService(): DesktopService {
  const storageKey = "listen-browser-preview-v1";
  let snapshot = readPreviewState();
  let activeTimer: number | null = null;
  let activeStartedAt: number | null = null;
  const modelsKey = "listen-browser-preview-models-v1";
  let speechModels = readPreviewSpeechModels(localStorage.getItem(modelsKey));
  let downloadController: AbortController | null = null;
  const speechModelListeners = new Set<(status: SpeechModelsStatus) => void>();
  const progressListeners = new Set<(progress: TranscriptionProgress) => void>();
  const activeProgress = new Map<string, TranscriptionProgress>();

  function publishSpeechModels(next: SpeechModelsStatus): SpeechModelsStatus {
    speechModels = next;
    localStorage.setItem(modelsKey, next.state === "ready" ? "ready" : JSON.stringify(next.models.map((model) => model.downloadedBytes)));
    speechModelListeners.forEach((listener) => listener(structuredClone(next)));
    return structuredClone(next);
  }
  const deletedMeetings = new Map<string, { meeting: Meeting; segments: WorkspaceSnapshot["segments"] }>();

  function persist(): void {
    localStorage.setItem(storageKey, JSON.stringify(snapshot));
  }

  function mutateMeeting(id: string, update: Partial<Meeting>): Meeting {
    const index = snapshot.meetings.findIndex((meeting) => meeting.id === id);
    if (index < 0) throw new Error("Meeting not found");
    snapshot.meetings[index] = { ...snapshot.meetings[index], ...update };
    persist();
    return snapshot.meetings[index];
  }

  return {
    async pickMeetingMedia() { throw new Error("Open the Listen desktop app to import audio or video."); },
    async importMeetingMedia() { throw new Error("Open the Listen desktop app to import audio or video."); },
    async loadWorkspace() {
      if (!localStorage.getItem(storageKey)) persist();
      return { ...structuredClone(snapshot), segments: [] };
    },
    async loadAssistantContext(meetingId) {
      snapshot = readPreviewState();
      const meeting = snapshot.meetings.find((candidate) => candidate.id === meetingId);
      if (!meeting) throw new Error("Meeting not found");
      return {
        meeting: structuredClone(meeting),
        meetings: structuredClone(snapshot.meetings),
        settings: structuredClone(snapshot.settings),
      };
    },
    async loadMeetingSegments(meetingId) {
      return structuredClone(snapshot.segments.filter((segment) => segment.meetingId === meetingId));
    },
    async findVoiceEnrollmentSegment(personId) {
      return structuredClone(snapshot.segments
        .filter((segment) => segment.personId === personId && segment.identitySource === "manual")
        .sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs))[0] ?? null);
    },
    async createProject(draft) {
      const project: Project = {
        id: crypto.randomUUID(),
        name: draft.name,
        position: snapshot.projects.length,
        createdAt: new Date().toISOString(),
      };
      snapshot.projects.push(project);
      persist();
      return project;
    },
    async renameProject(id, name) {
      const project = snapshot.projects.find((candidate) => candidate.id === id);
      if (!project) throw new Error("Project not found");
      project.name = name;
      persist();
      return project;
    },
    async deleteProject(id) {
      snapshot.projects = snapshot.projects.filter((project) => project.id !== id);
      snapshot.folders = snapshot.folders.filter((folder) => folder.projectId !== id);
      snapshot.meetings = snapshot.meetings.map((meeting) =>
        meeting.projectId === id ? { ...meeting, projectId: null, folderId: null } : meeting,
      );
      persist();
    },
    async reorderProjects(ids) {
      snapshot.projects.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      snapshot.projects.forEach((project, index) => (project.position = index));
      persist();
    },
    async createFolder(draft) {
      const folder: Folder = {
        id: crypto.randomUUID(),
        projectId: draft.projectId,
        parentId: draft.parentId,
        name: draft.name,
        position: snapshot.folders.filter(
          (candidate) => candidate.projectId === draft.projectId && candidate.parentId === draft.parentId,
        ).length,
        createdAt: new Date().toISOString(),
      };
      snapshot.folders.push(folder);
      persist();
      return folder;
    },
    async renameFolder(id, name) {
      const folder = snapshot.folders.find((candidate) => candidate.id === id);
      if (!folder) throw new Error("Folder not found");
      folder.name = name;
      persist();
      return folder;
    },
    async moveFolder(id, parentId) {
      const folder = snapshot.folders.find((candidate) => candidate.id === id);
      if (!folder) throw new Error("Folder not found");
      for (let cursor = parentId; cursor !== null;) {
        if (cursor === id) throw new Error("A folder cannot be moved inside itself");
        cursor = snapshot.folders.find((candidate) => candidate.id === cursor)?.parentId ?? null;
      }
      folder.parentId = parentId;
      folder.position = snapshot.folders.filter(
        (candidate) => candidate.projectId === folder.projectId
          && candidate.parentId === parentId
          && candidate.id !== id,
      ).length;
      persist();
      return folder;
    },
    async deleteFolder(id) {
      const folder = snapshot.folders.find((candidate) => candidate.id === id);
      if (!folder) throw new Error("Folder not found");
      snapshot.folders = snapshot.folders.filter((candidate) => candidate.id !== id);
      snapshot.folders.forEach((candidate) => {
        if (candidate.parentId === id) candidate.parentId = folder.parentId;
      });
      snapshot.meetings = snapshot.meetings.map((meeting) =>
        meeting.folderId === id ? { ...meeting, folderId: folder.parentId } : meeting,
      );
      persist();
    },
    async createMeeting(draft) {
      snapshot.meetings
        .filter((meeting) => meeting.projectId === draft.projectId && meeting.folderId === null)
        .forEach((meeting) => (meeting.position += 1));
      const meeting = makeMeeting(draft);
      snapshot.meetings.unshift(meeting);
      persist();
      return meeting;
    },
    async renameMeeting(id, title) {
      return mutateMeeting(id, { title });
    },
    async moveMeeting(id, projectId) {
      const position = snapshot.meetings.filter(
        (meeting) => meeting.projectId === projectId && meeting.folderId === null,
      ).length;
      return mutateMeeting(id, { projectId, folderId: null, position });
    },
    async reorderMeetings(placements) {
      for (const placement of placements) {
        mutateMeeting(placement.id, {
          projectId: placement.projectId,
          folderId: placement.folderId,
          position: placement.position,
        });
      }
    },
    async deleteMeeting(id) {
      const meeting = snapshot.meetings.find((candidate) => candidate.id === id);
      if (meeting) {
        deletedMeetings.set(id, {
          meeting: structuredClone(meeting),
          segments: structuredClone(snapshot.segments.filter((segment) => segment.meetingId === id)),
        });
      }
      snapshot.meetings = snapshot.meetings.filter((meeting) => meeting.id !== id);
      snapshot.segments = snapshot.segments.filter((segment) => segment.meetingId !== id);
      persist();
    },
    async restoreMeeting(id) {
      const archived = deletedMeetings.get(id);
      if (!archived) throw new Error("Recording cannot be restored");
      snapshot.meetings.push(archived.meeting);
      snapshot.segments.push(...archived.segments);
      deletedMeetings.delete(id);
      persist();
      return archived.meeting;
    },
    async createPerson(draft) {
      const person: Person = {
        id: crypto.randomUUID(),
        ...draft,
        voiceProfile: null,
        color: personColors[snapshot.people.length % personColors.length],
        createdAt: new Date().toISOString(),
      };
      snapshot.people.push(person);
      persist();
      return person;
    },
    async updatePerson(id, draft) {
      const person = snapshot.people.find((candidate) => candidate.id === id);
      if (!person) throw new Error("Person not found");
      Object.assign(person, draft);
      persist();
      return person;
    },
    async deletePerson(id) {
      snapshot.people = snapshot.people.filter((person) => person.id !== id);
      snapshot.segments = snapshot.segments.map((segment) =>
        segment.personId === id ? { ...segment, personId: null } : segment,
      );
      persist();
    },
    async assignSpeaker(meetingId, speakerLabel, personId, identitySource) {
      const resolvedSource = personId ? identitySource ?? "manual" : null;
      snapshot.segments = snapshot.segments.map((segment) =>
        segment.meetingId === meetingId && segment.speakerLabel === speakerLabel
          ? { ...segment, personId, identitySource: resolvedSource, identityConfidence: null }
          : segment,
      );
      persist();
    },
    async deleteTranscriptSegments(ids) {
      const idSet = new Set(ids);
      const deleted = snapshot.segments
        .filter((segment) => idSet.has(segment.id))
        .map((segment) => ({ segment: structuredClone(segment), rawText: segment.text }));
      if (deleted.length !== idSet.size) throw new Error("Transcript segment not found");
      snapshot.segments = snapshot.segments.filter((segment) => !idSet.has(segment.id));
      persist();
      return deleted;
    },
    async restoreTranscriptSegments(backups) {
      const existingIds = new Set(snapshot.segments.map((segment) => segment.id));
      if (backups.some((backup) => existingIds.has(backup.segment.id))) {
        throw new Error("Transcript segment already exists");
      }
      snapshot.segments.push(...backups.map((backup) => structuredClone(backup.segment)));
      persist();
    },
    async forgetVoiceProfile(personId) {
      const person = snapshot.people.find((candidate) => candidate.id === personId);
      if (!person) throw new Error("Person not found");
      person.voiceProfile = {
        status: "disabled",
        enrollmentDurationMs: null,
        enrollmentClipCount: null,
        source: null,
        updatedAt: new Date().toISOString(),
        lastError: null,
      };
      persist();
      return person;
    },
    async forgetAllVoiceProfiles() {
      snapshot.people.forEach((person) => {
        if (!person.voiceProfile) return;
        person.voiceProfile = {
          status: "disabled",
          enrollmentDurationMs: null,
          enrollmentClipCount: null,
          source: null,
          updatedAt: new Date().toISOString(),
          lastError: null,
        };
      });
      persist();
    },
    async enableVoiceProfile(personId) {
      const person = snapshot.people.find((candidate) => candidate.id === personId);
      if (!person) throw new Error("Person not found");
      if (!person.voiceProfile || person.voiceProfile.status === "disabled") {
        person.voiceProfile = {
          status: "pending_sample",
          enrollmentDurationMs: null,
          enrollmentClipCount: null,
          source: null,
          updatedAt: new Date().toISOString(),
          lastError: null,
        };
      }
      persist();
      return person;
    },
    async enrollVoiceProfile(_meetingId, _speakerLabel, personId) {
      const person = snapshot.people.find((candidate) => candidate.id === personId);
      if (!person) throw new Error("Person not found");
      if (person.voiceProfile?.status === "disabled") {
        throw new Error("Automatic voice labeling is turned off for this person");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 2_500));
      person.voiceProfile = {
        status: "ready",
        enrollmentDurationMs: 12_000,
        enrollmentClipCount: 2,
        source: "microphone",
        updatedAt: new Date().toISOString(),
        lastError: null,
      };
      persist();
      return person;
    },
    async updateSettings(settings) {
      snapshot.settings = settings;
      persist();
      return settings;
    },
    async setApiKey(apiKey) {
      snapshot.settings.apiKeyConfigured = apiKey.trim().length > 0;
      persist();
      return snapshot.settings.apiKeyConfigured;
    },
    async speechModelsStatus() {
      return structuredClone(speechModels);
    },
    async downloadSpeechModels() {
      if (speechModels.state === "ready" || downloadController) return structuredClone(speechModels);
      const controller = new AbortController();
      downloadController = controller;
      publishSpeechModels(previewSpeechModels(speechModels.models.map((model) => model.downloadedBytes), true));
      while (!controller.signal.aborted && !speechModels.models.every((model) => model.installed)) {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        if (controller.signal.aborted) break;
        const bytes = speechModels.models.map((model) => {
          const increment = Math.max(1_800_000, Math.min(16_000_000, Math.round(model.sizeBytes / 28)));
          return Math.min(model.sizeBytes, model.downloadedBytes + increment);
        });
        publishSpeechModels(previewSpeechModels(bytes, true));
      }
      if (downloadController === controller) downloadController = null;
      return structuredClone(speechModels);
    },
    async cancelSpeechModelsDownload() {
      downloadController?.abort();
      downloadController = null;
      publishSpeechModels(previewSpeechModels(speechModels.models.map((model) => model.downloadedBytes)));
    },
    async removeSpeechModels() {
      return publishSpeechModels(previewSpeechModels([]));
    },
    async transcriptionProgress() {
      return [...activeProgress.values()].map((progress) => structuredClone(progress));
    },
    async onSpeechModels(handler) {
      speechModelListeners.add(handler);
      return () => speechModelListeners.delete(handler);
    },
    async onTranscriptionProgress(handler) {
      progressListeners.add(handler);
      return () => progressListeners.delete(handler);
    },
    async openDiagnostics() {},
    async startRecording(request) {
      const startedAt = new Date().toISOString();
      const meeting = mutateMeeting(request.meetingId, {
        status: "recording",
        startedAt,
        endedAt: null,
        durationMs: 0,
      });
      const started = Date.now();
      activeStartedAt = started;
      activeTimer = window.setInterval(() => {
        mutateMeeting(request.meetingId, { durationMs: Date.now() - started });
      }, 1000);
      return meeting;
    },
    async stopRecording(meetingId) {
      if (activeTimer !== null) window.clearInterval(activeTimer);
      activeTimer = null;
      activeStartedAt = null;
      return mutateMeeting(meetingId, {
        status: "ready",
        endedAt: new Date().toISOString(),
      });
    },
    async setRecordingPaused() {},
    async recordingLevels() {
      const now = Date.now();
      return {
        microphone: 0.18 + Math.abs(Math.sin(now / 173)) * 0.7,
        system: 0.08 + Math.abs(Math.sin(now / 241)) * 0.45,
        elapsedMs: activeStartedAt === null ? 0 : now - activeStartedAt,
      };
    },
    async transcribeMeeting(meetingId) {
      if (speechModels.state !== "ready") throw new Error("Finish downloading the models before transcribing");
      mutateMeeting(meetingId, { status: "processing", errorMessage: null });
      const phases: TranscriptionPhase[] = ["preparing", "separating", "transcribing", "identifying", "polishing"];
      for (let step = 0; step <= 40; step += 1) {
        const progress = step / 40;
        const update = { meetingId, phase: phases[Math.min(phases.length - 1, Math.floor(progress * phases.length))], progress };
        activeProgress.set(meetingId, update);
        progressListeners.forEach((listener) => listener(update));
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }
      activeProgress.delete(meetingId);
      return mutateMeeting(meetingId, { status: "ready" });
    },
    async loadSegmentAudio(_meetingId, startMs, endMs) {
      if (startMs < 0 || endMs <= startMs) throw new Error("Invalid playback range.");
      if (endMs - startMs > MAX_PLAYBACK_MS) throw new Error("Playback clips are limited to 5 minutes.");
      return silentWavDataUrl(endMs - startMs);
    },
    async loadMeetingAudioUrl(meetingId) {
      const meeting = snapshot.meetings.find((candidate) => candidate.id === meetingId);
      if (!meeting || meeting.durationMs <= 0 || !meeting.audioDirectory) {
        throw new Error("This recording has no saved audio");
      }
      return silentWavDataUrl(meeting.durationMs);
    },
    async loadChatMessages(scope) {
      return readPreviewChats().filter(
        (message) => message.scopeType === scope.scopeType && message.scopeId === scope.scopeId,
      );
    },
    async completeChat(scope, content, messageId = null, clientMessageId = null) {
      let chatMessages = readPreviewChats();
      const scoped = chatMessages.filter(
        (message) => message.scopeType === scope.scopeType && message.scopeId === scope.scopeId,
      );
      if (messageId) {
        const existing = scoped.find((message) => message.id === messageId && message.role === "user");
        if (!existing) throw new Error("User message not found");
        existing.content = content.trim();
        chatMessages = chatMessages.filter((message) =>
          message.scopeType !== scope.scopeType
          || message.scopeId !== scope.scopeId
          || message.position <= existing.position,
        );
      } else {
        chatMessages.push(makePreviewChatMessage(scope, "user", content, scoped.length, clientMessageId));
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700));
      const nextPosition = chatMessages.filter(
        (message) => message.scopeType === scope.scopeType && message.scopeId === scope.scopeId,
      ).length;
      const referencedMeeting = snapshot.meetings.find((meeting) => meeting.id === scope.scopeId);
      const previewReference = referencedMeeting
        ? ` [[recording:${referencedMeeting.id}|12000|${referencedMeeting.title} 0:12]]`
        : "";
      chatMessages.push(makePreviewChatMessage(
        scope,
        "assistant",
        `Open this meeting in the desktop app to ask about its transcript.${previewReference}`,
        nextPosition,
      ));
      chatMessages = [
        ...readPreviewChats().filter((message) => message.scopeType !== scope.scopeType || message.scopeId !== scope.scopeId),
        ...chatMessages.filter((message) => message.scopeType === scope.scopeType && message.scopeId === scope.scopeId),
      ];
      persistPreviewChats(chatMessages);
      return structuredClone(chatMessages.filter(
        (message) => message.scopeType === scope.scopeType && message.scopeId === scope.scopeId,
      ));
    },
  };
}

function makePreviewChatMessage(
  scope: ChatScope,
  role: "user" | "assistant",
  content: string,
  position: number,
  id?: string | null,
): ChatMessage {
  return {
    id: id || crypto.randomUUID(),
    ...scope,
    role,
    content: content.trim(),
    position,
    createdAt: new Date().toISOString(),
  };
}

function readPreviewChats(): ChatMessage[] {
  try {
    return JSON.parse(localStorage.getItem("listen-browser-preview-chat-v1") || "[]") as ChatMessage[];
  } catch {
    return [];
  }
}

function persistPreviewChats(messages: ChatMessage[]): void {
  localStorage.setItem("listen-browser-preview-chat-v1", JSON.stringify(messages));
}

function readPreviewSpeechModels(saved: string | null): SpeechModelsStatus {
  if (saved === "ready") return previewSpeechModels("ready");
  try {
    const bytes: unknown = JSON.parse(saved ?? "[]");
    if (Array.isArray(bytes) && bytes.every((value) => Number.isSafeInteger(value) && value >= 0)) {
      return previewSpeechModels(bytes);
    }
  } catch { /* Older previews stored the word "missing". */ }
  return previewSpeechModels([]);
}

function previewSpeechModels(bytes: number[] | "ready", active = false): SpeechModelsStatus {
  const catalogue = [
    { id: "nemotron-3-diarization", name: "Nemotron 3 Diarization", role: "Speaker separation", licence: "NVIDIA OpenMDW 1.1", sizeBytes: 402_170_175 },
    { id: "parakeet-tdt-0.6b-v3-int8", name: "Parakeet TDT 0.6B v3", role: "Transcription", licence: "CC BY 4.0", sizeBytes: 670_480_039 },
    { id: "wespeaker-resnet34-lm", name: "WeSpeaker ResNet34-LM", role: "Fingerprinting", licence: "CC BY 4.0", sizeBytes: 26_530_309 },
  ];
  const models = catalogue.map((model, index): SpeechModelsStatus["models"][number] => {
    const downloadedBytes = bytes === "ready" ? model.sizeBytes : Math.min(bytes[index] ?? 0, model.sizeBytes);
    const installed = downloadedBytes === model.sizeBytes;
    return { ...model, downloadedBytes, installed, state: installed ? "ready" : active ? "downloading" : "missing" };
  });
  return {
    state: models.every((model) => model.installed) ? "ready" : active ? "downloading" : "missing",
    downloadedBytes: models.reduce((total, model) => total + model.downloadedBytes, 0),
    totalBytes: models.reduce((total, model) => total + model.sizeBytes, 0),
    error: null,
    models,
  };
}

function makeMeeting(draft: MeetingDraft): Meeting {
  return {
    id: crypto.randomUUID(),
    projectId: draft.projectId,
    folderId: null,
    position: 0,
    title: draft.title,
    status: "draft",
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    audioDirectory: null,
    errorMessage: null,
  };
}

function readPreviewState(): WorkspaceSnapshot {
  const saved = localStorage.getItem("listen-browser-preview-v1");
  if (saved) {
    const snapshot = JSON.parse(saved) as WorkspaceSnapshot;
    snapshot.folders ??= [];
    delete (snapshot.settings as AppSettings & { pyannoteApiKeyConfigured?: boolean }).pyannoteApiKeyConfigured;
    snapshot.settings.localSpeakerPersonId ??= null;
    snapshot.settings.preferLocalSpeakerForMicrophone ??= true;
    snapshot.people.forEach((person) => {
      person.voiceProfile ??= null;
      // Profiles saved before consent removal may carry the retired status.
      if ((person.voiceProfile?.status as string) === "consent_required") {
        person.voiceProfile = { ...person.voiceProfile!, status: "pending_sample" };
      }
      delete (person as Person & { referenceAudioDataUrl?: string | null }).referenceAudioDataUrl;
    });
    snapshot.segments.forEach((segment) => {
      segment.identitySource ??= segment.personId ? "manual" : null;
      segment.identityConfidence ??= null;
    });
    snapshot.meetings.forEach((meeting, index) => {
      meeting.position ??= index;
      meeting.folderId ??= null;
      // A capture can't survive a page reload; normalize sessions interrupted mid-recording.
      if (meeting.status === "recording") meeting.status = meeting.durationMs > 0 ? "ready" : "draft";
    });
    snapshot.devices = snapshot.devices.map((device) => device.kind === "system"
      ? {
          ...device,
          name: device.name === "System audio" ? "Speaker" : device.name,
          subtitle: device.subtitle?.replace(/system audio/gi, "speaker"),
        }
      : device);
    return snapshot;
  }

  const projectId = crypto.randomUUID();
  const meetingId = crypto.randomUUID();
  const benId = crypto.randomUUID();
  const ethanId = crypto.randomUUID();
  const now = new Date();

  return {
    projects: [
      {
        id: projectId,
        name: "Soccer video",
        position: 0,
        createdAt: new Date(now.getTime() - 14 * 86_400_000).toISOString(),
      },
    ],
    folders: [],
    meetings: [
      {
        id: meetingId,
        projectId,
        folderId: null,
        position: 0,
        title: "Gameplay systems review",
        status: "ready",
        createdAt: new Date(now.getTime() - 42 * 60_000).toISOString(),
        startedAt: new Date(now.getTime() - 42 * 60_000).toISOString(),
        endedAt: new Date(now.getTime() - 8 * 60_000).toISOString(),
        durationMs: 2_064_000,
        audioDirectory: "browser-preview",
        errorMessage: null,
      },
      {
        ...makeMeeting({ title: "Quick thought", projectId: null }),
        position: 0,
        createdAt: new Date(now.getTime() - 86_400_000).toISOString(),
      },
    ],
    people: [
      {
        id: benId,
        fullName: "Ben Carter",
        nickname: "Ben",
        photoDataUrl: null,
        voiceProfile: null,
        color: personColors[0],
        createdAt: now.toISOString(),
      },
      {
        id: ethanId,
        fullName: "Ethan Brooks",
        nickname: "Ethan",
        photoDataUrl: null,
        voiceProfile: {
          status: "ready",
          enrollmentDurationMs: 14_000,
          enrollmentClipCount: 2,
          source: "microphone",
          updatedAt: now.toISOString(),
          lastError: null,
        },
        color: personColors[1],
        createdAt: now.toISOString(),
      },
    ],
    segments: [
      {
        id: crypto.randomUUID(),
        meetingId,
        speakerLabel: "A",
        personId: benId,
        identitySource: "manual",
        identityConfidence: null,
        startMs: 12_000,
        endMs: 31_000,
        text: "The movement is finally feeling responsive. I think the next pass should focus on how the camera settles after a sprint.",
      },
      {
        id: crypto.randomUUID(),
        meetingId,
        speakerLabel: "B",
        personId: ethanId,
        identitySource: "voiceprint",
        identityConfidence: 87,
        startMs: 33_000,
        endMs: 52_000,
        text: "Agreed. The acceleration curve feels right now, but the camera still arrives half a beat after the player does.",
      },
      {
        id: crypto.randomUUID(),
        meetingId,
        speakerLabel: "A",
        personId: benId,
        identitySource: "manual",
        identityConfidence: null,
        startMs: 55_000,
        endMs: 76_000,
        text: "Let’s put that into the polish pass and test it against the small stadium map before we touch the wider field.",
      },
    ],
    devices: [
      { id: "default-mic", name: "MacBook Microphone", kind: "microphone", isDefault: true, isAvailable: true },
      { id: "usb-mic", name: "Studio USB Microphone", kind: "microphone", isDefault: false, isAvailable: true },
      { id: "default-system", name: "Speaker", kind: "system", isDefault: true, isAvailable: true },
    ],
    settings: {
      microphoneDeviceId: "default-mic",
      systemDeviceId: "default-system",
      captureMicrophone: true,
      captureSystem: true,
      theme: "light",
      apiKeyConfigured: false,
      localSpeakerPersonId: null,
      preferLocalSpeakerForMicrophone: true,
    },
  };
}
