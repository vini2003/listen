import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  Meeting,
  MeetingDraft,
  MeetingPlacement,
  Person,
  PersonDraft,
  Project,
  ProjectDraft,
  RecordingLevels,
  WorkspaceSnapshot,
} from "../domain/models";

export interface RecordingRequest {
  meetingId: string;
  microphoneDeviceId: string | null;
  systemDeviceId: string | null;
  captureMicrophone: boolean;
  captureSystem: boolean;
}

export interface DesktopService {
  loadWorkspace(): Promise<WorkspaceSnapshot>;
  createProject(draft: ProjectDraft): Promise<Project>;
  renameProject(id: string, name: string): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  reorderProjects(ids: string[]): Promise<void>;
  createMeeting(draft: MeetingDraft): Promise<Meeting>;
  renameMeeting(id: string, title: string): Promise<Meeting>;
  moveMeeting(id: string, projectId: string | null): Promise<Meeting>;
  reorderMeetings(placements: MeetingPlacement[]): Promise<void>;
  deleteMeeting(id: string): Promise<void>;
  restoreMeeting(id: string): Promise<Meeting>;
  createPerson(draft: PersonDraft): Promise<Person>;
  updatePerson(id: string, draft: PersonDraft): Promise<Person>;
  deletePerson(id: string): Promise<void>;
  assignSpeaker(meetingId: string, speakerLabel: string, personId: string | null): Promise<void>;
  updateSettings(settings: AppSettings): Promise<AppSettings>;
  setApiKey(apiKey: string): Promise<boolean>;
  setPyannoteApiKey(apiKey: string): Promise<boolean>;
  openDiagnostics(): Promise<void>;
  startRecording(request: RecordingRequest): Promise<Meeting>;
  stopRecording(meetingId: string): Promise<Meeting>;
  setRecordingPaused(meetingId: string, paused: boolean): Promise<void>;
  recordingLevels(meetingId: string): Promise<RecordingLevels>;
  transcribeMeeting(meetingId: string): Promise<Meeting>;
  loadSegmentAudio(meetingId: string, startMs: number, endMs: number): Promise<string>;
}

const personColors = ["#d96c4a", "#477a66", "#6256a5", "#b07a28", "#3c6e9b"];

const tauriService: DesktopService = {
  loadWorkspace: () => invoke("load_workspace"),
  createProject: (draft) => invoke("create_project", { draft }),
  renameProject: (id, name) => invoke("rename_project", { id, name }),
  deleteProject: (id) => invoke("delete_project", { id }),
  reorderProjects: (ids) => invoke("reorder_projects", { ids }),
  createMeeting: (draft) => invoke("create_meeting", { draft }),
  renameMeeting: (id, title) => invoke("rename_meeting", { id, title }),
  moveMeeting: (id, projectId) => invoke("move_meeting", { id, projectId }),
  reorderMeetings: (placements) => invoke("reorder_meetings", { placements }),
  deleteMeeting: (id) => invoke("delete_meeting", { id }),
  restoreMeeting: (id) => invoke("restore_meeting", { id }),
  createPerson: (draft) => invoke("create_person", { draft }),
  updatePerson: (id, draft) => invoke("update_person", { id, draft }),
  deletePerson: (id) => invoke("delete_person", { id }),
  assignSpeaker: (meetingId, speakerLabel, personId) =>
    invoke("assign_speaker", { meetingId, speakerLabel, personId }),
  updateSettings: (settings) => invoke("update_settings", { settings }),
  setApiKey: (apiKey) => invoke("set_api_key", { apiKey }),
  setPyannoteApiKey: (apiKey) => invoke("set_pyannote_api_key", { apiKey }),
  openDiagnostics: () => invoke("open_diagnostics"),
  startRecording: (request) => invoke("start_recording", { request }),
  stopRecording: (meetingId) => invoke("stop_recording", { meetingId }),
  setRecordingPaused: (meetingId, paused) => invoke("set_recording_paused", { meetingId, paused }),
  recordingLevels: (meetingId) => invoke("recording_levels", { meetingId }),
  transcribeMeeting: (meetingId) => invoke("transcribe_meeting", { meetingId }),
  loadSegmentAudio: (meetingId, startMs, endMs) =>
    invoke("load_segment_audio", { meetingId, startMs, endMs }),
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
    async loadWorkspace() {
      return structuredClone(snapshot);
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
      snapshot.meetings = snapshot.meetings.map((meeting) =>
        meeting.projectId === id ? { ...meeting, projectId: null } : meeting,
      );
      persist();
    },
    async reorderProjects(ids) {
      snapshot.projects.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
      snapshot.projects.forEach((project, index) => (project.position = index));
      persist();
    },
    async createMeeting(draft) {
      snapshot.meetings
        .filter((meeting) => meeting.projectId === draft.projectId)
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
      const position = snapshot.meetings.filter((meeting) => meeting.projectId === projectId).length;
      return mutateMeeting(id, { projectId, position });
    },
    async reorderMeetings(placements) {
      for (const placement of placements) {
        mutateMeeting(placement.id, {
          projectId: placement.projectId,
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
    async assignSpeaker(meetingId, speakerLabel, personId) {
      snapshot.segments = snapshot.segments.map((segment) =>
        segment.meetingId === meetingId && segment.speakerLabel === speakerLabel
          ? { ...segment, personId }
          : segment,
      );
      persist();
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
    async setPyannoteApiKey(apiKey) {
      snapshot.settings.pyannoteApiKeyConfigured = apiKey.trim().length > 0;
      persist();
      return snapshot.settings.pyannoteApiKeyConfigured;
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
      mutateMeeting(meetingId, { status: "processing" });
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      return mutateMeeting(meetingId, { status: "ready" });
    },
    async loadSegmentAudio() {
      throw new Error("Audio playback is available in the desktop app.");
    },
  };
}

function makeMeeting(draft: MeetingDraft): Meeting {
  return {
    id: crypto.randomUUID(),
    projectId: draft.projectId,
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
    snapshot.settings.pyannoteApiKeyConfigured ??= false;
    snapshot.meetings.forEach((meeting, index) => (meeting.position ??= index));
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
    meetings: [
      {
        id: meetingId,
        projectId,
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
        referenceAudioDataUrl: null,
        color: personColors[0],
        createdAt: now.toISOString(),
      },
      {
        id: ethanId,
        fullName: "Ethan Brooks",
        nickname: "Ethan",
        photoDataUrl: null,
        referenceAudioDataUrl: null,
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
        startMs: 12_000,
        endMs: 31_000,
        text: "The movement is finally feeling responsive. I think the next pass should focus on how the camera settles after a sprint.",
      },
      {
        id: crypto.randomUUID(),
        meetingId,
        speakerLabel: "B",
        personId: ethanId,
        startMs: 33_000,
        endMs: 52_000,
        text: "Agreed. The acceleration curve feels right now, but the camera still arrives half a beat after the player does.",
      },
      {
        id: crypto.randomUUID(),
        meetingId,
        speakerLabel: "A",
        personId: benId,
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
      pyannoteApiKeyConfigured: false,
    },
  };
}
