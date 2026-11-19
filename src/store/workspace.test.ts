import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, Person, Project, SpeechModelsStatus, TranscriptSegment, WorkspaceSnapshot } from "../domain/models";

const service = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  loadMeetingSegments: vi.fn(),
  createProject: vi.fn(),
  reorderProjects: vi.fn(),
  pickMeetingMedia: vi.fn(),
  importMeetingMedia: vi.fn(),
  transcribeMeeting: vi.fn(),
  assignSpeaker: vi.fn(),
  findVoiceEnrollmentSegment: vi.fn(),
  enrollVoiceProfile: vi.fn(),
  reorderMeetings: vi.fn(),
  speechModelsStatus: vi.fn(),
  transcriptionProgress: vi.fn(),
  onSpeechModels: vi.fn(),
  onTranscriptionProgress: vi.fn(),
}));

vi.mock("../services/desktop", () => ({ desktop: service }));

import { useWorkspace } from "./workspace";

const readyModels: SpeechModelsStatus = {
  state: "ready",
  downloadedBytes: 1_099_180_523,
  totalBytes: 1_099_180_523,
  error: null,
  models: [],
};

beforeEach(() => {
  service.speechModelsStatus.mockReset().mockResolvedValue(structuredClone(readyModels));
  service.transcriptionProgress.mockReset().mockResolvedValue([]);
  service.onSpeechModels.mockReset().mockResolvedValue(() => undefined);
  service.onTranscriptionProgress.mockReset().mockResolvedValue(() => undefined);
});

const firstMeeting: Meeting = {
  id: "meeting-1",
  projectId: null,
  folderId: null,
  position: 0,
  title: "First",
  status: "ready",
  createdAt: "2026-08-31T00:00:00Z",
  startedAt: null,
  endedAt: null,
  durationMs: 1_000,
  audioDirectory: null,
  errorMessage: null,
};

const selectedSegment: TranscriptSegment = {
  id: "segment-1",
  meetingId: firstMeeting.id,
  speakerLabel: "A",
  personId: null,
  identitySource: null,
  identityConfidence: null,
  startMs: 0,
  endMs: 1_000,
  text: "Selected meeting only",
};

const snapshot: WorkspaceSnapshot = {
  projects: [],
  folders: [],
  meetings: [firstMeeting, { ...firstMeeting, id: "meeting-2", position: 1, title: "Second" }],
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
    localSpeakerPersonId: null,
    preferLocalSpeakerForMicrophone: true,
  },
};

describe("workspace loading", () => {
  beforeEach(() => {
    service.loadWorkspace.mockReset().mockResolvedValue(structuredClone(snapshot));
    service.loadMeetingSegments.mockReset().mockResolvedValue([selectedSegment]);
    service.createProject.mockReset();
  });

  it("loads transcript rows only for the selected meeting and avoids a broad refresh after mutations", async () => {
    await useWorkspace.getState().load();

    expect(service.loadWorkspace).toHaveBeenCalledTimes(1);
    expect(service.loadMeetingSegments).toHaveBeenCalledWith(firstMeeting.id);
    expect(useWorkspace.getState().segments).toEqual([selectedSegment]);

    const project: Project = {
      id: "project-1",
      name: "New project",
      position: 0,
      createdAt: "2026-08-31T00:00:00Z",
    };
    service.createProject.mockResolvedValue(project);

    await expect(useWorkspace.getState().createProject({ name: project.name })).resolves.toBe(true);
    expect(service.loadWorkspace).toHaveBeenCalledTimes(1);
    expect(useWorkspace.getState().projects).toContainEqual(project);
  });

  it("tracks segment loading while switching meetings", async () => {
    await useWorkspace.getState().load();
    expect(useWorkspace.getState().segmentsLoading).toBe(false);

    let releaseSegments!: (segments: TranscriptSegment[]) => void;
    service.loadMeetingSegments.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSegments = resolve; }),
    );

    useWorkspace.getState().selectMeeting("meeting-2");
    expect(useWorkspace.getState().segmentsLoading).toBe(true);
    expect(useWorkspace.getState().segments).toEqual([]);

    releaseSegments([]);
    await vi.waitFor(() => expect(useWorkspace.getState().segmentsLoading).toBe(false));
  });

  it("ignores stale segment responses after a second selection", async () => {
    await useWorkspace.getState().load();

    let releaseStale!: (segments: TranscriptSegment[]) => void;
    service.loadMeetingSegments.mockImplementationOnce(
      () => new Promise((resolve) => { releaseStale = resolve; }),
    );

    useWorkspace.getState().selectMeeting("meeting-2");
    useWorkspace.getState().selectMeeting(firstMeeting.id);
    await vi.waitFor(() => expect(useWorkspace.getState().segmentsLoading).toBe(false));
    expect(useWorkspace.getState().segments).toEqual([selectedSegment]);

    releaseStale([{ ...selectedSegment, id: "stale", meetingId: "meeting-2" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useWorkspace.getState().segments).toEqual([selectedSegment]);
    expect(useWorkspace.getState().segmentsLoading).toBe(false);
  });
});

describe("project order", () => {
  const projectIds = () => useWorkspace.getState().projects.map((project) => project.id);
  beforeEach(() => {
    const projects = ["a", "b", "c"].map((id, position) => ({ id, position, name: id, createdAt: firstMeeting.createdAt }));
    useWorkspace.setState({ projects, toasts: [] });
    service.reorderProjects.mockReset();
  });

  it("shows consecutive drops immediately and persists them in order", async () => {
    let finishFirst!: () => void;
    service.reorderProjects.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    service.reorderProjects.mockResolvedValueOnce(undefined);
    const { reorderProjects } = useWorkspace.getState();
    const first = reorderProjects(["c", "a", "b"]);
    expect(projectIds()).toEqual(["c", "a", "b"]);
    const second = reorderProjects(["c", "b", "a"]);
    expect(projectIds()).toEqual(["c", "b", "a"]);
    await vi.waitFor(() => expect(service.reorderProjects).toHaveBeenCalledTimes(1));
    finishFirst();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(service.reorderProjects.mock.calls).toEqual([[["c", "a", "b"]], [["c", "b", "a"]]]);
    expect(useWorkspace.getState().projects.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it("rolls back to the last saved order while preserving changes to the project list", async () => {
    let failLast!: (error: Error) => void;
    service.reorderProjects.mockResolvedValueOnce(undefined);
    service.reorderProjects.mockImplementationOnce(() => new Promise<void>((_, reject) => { failLast = reject; }));
    const { reorderProjects } = useWorkspace.getState();
    const first = reorderProjects(["b", "c", "a"]);
    const second = reorderProjects(["a", "c", "b"]);
    expect(await first).toBe(true);
    await vi.waitFor(() => expect(service.reorderProjects).toHaveBeenCalledTimes(2));
    useWorkspace.setState(({ projects }) => ({ projects: [
      ...projects.filter((p) => p.id !== "b").map((p) => ({ ...p, name: p.id === "c" ? "Renamed" : p.name })),
      { id: "d", position: 2, name: "New", createdAt: firstMeeting.createdAt },
    ] }));
    failLast(new Error("Couldn't save project order"));
    expect(await second).toBe(false);
    expect(projectIds()).toEqual(["c", "a", "d"]);
    expect(useWorkspace.getState().projects[0].name).toBe("Renamed");
    expect(useWorkspace.getState().toasts.at(-1)?.message).toBe("Couldn't save project order");
    service.reorderProjects.mockResolvedValueOnce(undefined);
    expect(await reorderProjects(["d", "c", "a"])).toBe(true);
    expect(projectIds()).toEqual(["d", "c", "a"]);
  });

  it("keeps the newer drop visible if the first write fails and undoes to the saved order", async () => {
    let failFirst!: (error: Error) => void;
    let finishLast!: () => void;
    service.reorderProjects
      .mockImplementationOnce(() => new Promise<void>((_, reject) => { failFirst = reject; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishLast = resolve; }))
      .mockResolvedValue(undefined);
    const original = useWorkspace.getState().projects;
    const { reorderProjects, undo } = useWorkspace.getState();
    const first = reorderProjects(["b", "a", "c"]);
    const second = reorderProjects(["c", "b", "a"]);
    await vi.waitFor(() => expect(service.reorderProjects).toHaveBeenCalledTimes(1));
    failFirst(new Error("First save failed"));
    expect(await first).toBe(false);
    expect(projectIds()).toEqual(["c", "b", "a"]);
    await vi.waitFor(() => expect(service.reorderProjects).toHaveBeenCalledTimes(2));
    service.loadWorkspace.mockResolvedValueOnce({ ...snapshot, projects: original });
    const undoWhileSaving = undo();
    finishLast();
    expect(await second).toBe(true);
    await undoWhileSaving;
    expect(service.reorderProjects).toHaveBeenLastCalledWith(["a", "b", "c"]);
    expect(projectIds()).toEqual(["a", "b", "c"]);
  });
});

describe("media imports", () => {
  const file = { path: "/archive/Review.mp4", name: "Review.mp4" };
  beforeEach(() => {
    useWorkspace.setState({
      ...structuredClone(snapshot), speechModels: readyModels, mediaImport: null, toasts: [],
      selectedMeetingId: firstMeeting.id, segments: [selectedSegment], segmentsLoading: false,
    });
    service.importMeetingMedia.mockReset();
    service.transcribeMeeting.mockReset();
    service.loadMeetingSegments.mockResolvedValue([]);
  });

  it("does not create a meeting or start transcription when the file has no audio", async () => {
    service.importMeetingMedia.mockRejectedValue(new Error("Audio error: This video has no supported audio track."));
    const before = useWorkspace.getState().meetings;
    expect(await useWorkspace.getState().importMeetingMedia({ title: "Review", projectId: null }, file)).toBe(false);
    const state = useWorkspace.getState();
    expect(state.meetings).toEqual(before);
    expect(state.segments).toEqual([selectedSegment]);
    expect(state.mediaImport).toBeNull();
    expect(state.toasts.at(-1)?.message).toBe("This video has no supported audio track.");
    expect(service.transcribeMeeting).not.toHaveBeenCalled();
  });

  it("queues one transcription for the imported meeting even after the user navigates away", async () => {
    let finish!: (meeting: Meeting) => void;
    const created = { ...firstMeeting, id: "imported", title: "Review", status: "processing" as const };
    service.importMeetingMedia.mockImplementation((_target, _path, progress) => {
      progress(0.4);
      return new Promise<Meeting>((resolve) => { finish = resolve; });
    });
    service.transcribeMeeting.mockResolvedValue({ ...created, status: "ready" });
    const state = useWorkspace.getState();
    const pending = state.importMeetingMedia({ title: "Review", projectId: null }, file);
    expect(useWorkspace.getState().mediaImport).toEqual({ meetingId: null, progress: 0.4 });
    expect(await state.importMeetingMedia(firstMeeting.id, file)).toBe(false);
    state.selectMeeting("meeting-2");
    finish(created);
    expect(await pending).toBe(true);
    expect(service.transcribeMeeting).toHaveBeenCalledExactlyOnceWith("imported");
    expect(useWorkspace.getState().selectedMeetingId).toBe("meeting-2");
    expect(useWorkspace.getState().meetings[0].id).toBe("imported");
    expect(useWorkspace.getState().mediaImport).toBeNull();
  });

  it("updates the duration of an existing meeting without inserting another row", async () => {
    const appended = { ...firstMeeting, durationMs: 8000, status: "processing" as const };
    service.importMeetingMedia.mockResolvedValue(appended);
    service.transcribeMeeting.mockResolvedValue({ ...appended, status: "ready" });
    expect(await useWorkspace.getState().importMeetingMedia(firstMeeting.id, file)).toBe(true);
    expect(service.transcribeMeeting).toHaveBeenCalledExactlyOnceWith(firstMeeting.id);
    expect(useWorkspace.getState().meetings.map((meeting) => meeting.durationMs)).toEqual([8000, 1000]);
  });
});

describe("folder placement", () => {
  beforeEach(() => {
    service.loadMeetingSegments.mockReset().mockResolvedValue([]);
    service.reorderMeetings.mockReset().mockResolvedValue(undefined);
    service.loadWorkspace.mockReset().mockResolvedValue(structuredClone({
      ...snapshot,
      projects: [{ id: "project-1", name: "Leads", position: 0, createdAt: "2026-08-31T00:00:00Z" }],
      folders: [{
        id: "folder-1",
        projectId: "project-1",
        parentId: null,
        name: "August",
        position: 0,
        createdAt: "2026-08-31T00:00:00Z",
      }],
      meetings: [
        { ...firstMeeting, projectId: "project-1" },
        { ...firstMeeting, id: "meeting-2", projectId: "project-1", position: 1, title: "Second" },
      ],
    }));
  });

  it("moves a recording into a folder and re-indexes both groups", async () => {
    await useWorkspace.getState().load();

    await expect(useWorkspace.getState().reorderMeeting(
      "meeting-1",
      { projectId: "project-1", folderId: "folder-1", index: 0 },
    )).resolves.toBe(true);

    expect(service.reorderMeetings).toHaveBeenCalledWith([
      { id: "meeting-2", projectId: "project-1", folderId: null, position: 0 },
      { id: "meeting-1", projectId: "project-1", folderId: "folder-1", position: 0 },
    ]);
    const moved = useWorkspace.getState().meetings.find((meeting) => meeting.id === "meeting-1");
    expect(moved?.folderId).toBe("folder-1");
  });

  it("treats a drop back onto the same spot as a no-op", async () => {
    await useWorkspace.getState().load();

    await expect(useWorkspace.getState().reorderMeeting(
      "meeting-1",
      { projectId: "project-1", folderId: null, index: 0 },
    )).resolves.toBe(true);

    expect(service.reorderMeetings).not.toHaveBeenCalled();
  });
});

describe("automatic voice enrollment", () => {
  const person: Person = {
    id: "person-1",
    fullName: "Ben Carter",
    nickname: null,
    photoDataUrl: null,
    voiceProfile: null,
    color: "#d96c4a",
    createdAt: "2026-08-31T00:00:00Z",
  };

  function enrollmentSnapshot(profile: Person["voiceProfile"]): WorkspaceSnapshot {
    return structuredClone({
      ...snapshot,
      people: [{ ...person, voiceProfile: profile }],
    });
  }

  beforeEach(() => {
    service.loadWorkspace.mockReset();
    service.loadMeetingSegments.mockReset().mockResolvedValue([selectedSegment]);
    service.assignSpeaker.mockReset().mockResolvedValue(undefined);
    service.findVoiceEnrollmentSegment.mockReset().mockResolvedValue({
      ...selectedSegment,
      personId: person.id,
      identitySource: "manual",
    });
    service.enrollVoiceProfile.mockReset().mockResolvedValue({
      ...person,
      voiceProfile: {
        status: "ready",
        enrollmentDurationMs: 12_000,
        enrollmentClipCount: 2,
        source: "microphone",
        updatedAt: "2026-08-31T00:00:00Z",
        lastError: null,
      },
    });
  });

  it("labels a speaker manually and enrolls from the best assigned segment", async () => {
    service.loadWorkspace.mockResolvedValue(enrollmentSnapshot(null));
    await useWorkspace.getState().load();

    await expect(
      useWorkspace.getState().assignSpeaker(firstMeeting.id, "A", person.id),
    ).resolves.toBe(true);

    const assigned = useWorkspace.getState().segments.find((segment) => segment.speakerLabel === "A");
    expect(assigned?.identitySource).toBe("manual");
    await vi.waitFor(() => {
      expect(service.enrollVoiceProfile).toHaveBeenCalledWith(
        selectedSegment.meetingId,
        selectedSegment.speakerLabel,
        person.id,
      );
    });
  });

  it("does not re-enroll a ready profile", async () => {
    service.loadWorkspace.mockResolvedValue(enrollmentSnapshot({
      status: "ready",
      enrollmentDurationMs: 12_000,
      enrollmentClipCount: 2,
      source: "microphone",
      updatedAt: "2026-08-31T00:00:00Z",
      lastError: null,
    }));
    await useWorkspace.getState().load();

    await useWorkspace.getState().assignSpeaker(firstMeeting.id, "A", person.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.enrollVoiceProfile).not.toHaveBeenCalled();
  });

  it("relearns pending voices once, shows the work, and reports the outcome", async () => {
    service.loadWorkspace.mockResolvedValue(enrollmentSnapshot({
      status: "pending_sample",
      enrollmentDurationMs: null,
      enrollmentClipCount: null,
      source: null,
      updatedAt: "2026-08-31T00:00:00Z",
      lastError: "Relearning this voice on this device",
    }));
    let finish: (value: Person) => void = () => undefined;
    service.enrollVoiceProfile.mockImplementation(() => new Promise<Person>((resolve) => { finish = resolve; }));
    useWorkspace.setState({ toasts: [], voiceLearning: [] });
    await useWorkspace.getState().load();

    await vi.waitFor(() => expect(service.enrollVoiceProfile).toHaveBeenCalledTimes(1));
    expect(useWorkspace.getState().voiceLearning).toEqual([person.id]);
    finish({ ...person, voiceProfile: { status: "ready", enrollmentDurationMs: 12_000, enrollmentClipCount: 2, source: "microphone", updatedAt: "2026-08-31T00:00:00Z", lastError: null } });

    await vi.waitFor(() => expect(useWorkspace.getState().voiceLearning).toEqual([]));
    expect(useWorkspace.getState().toasts.at(-1)).toMatchObject({ tone: "notice", message: "Learned Ben's voice." });
  });

  it("explains a voice that could not be learned after labelling", async () => {
    service.loadWorkspace.mockResolvedValue(enrollmentSnapshot(null));
    service.enrollVoiceProfile.mockResolvedValue({
      ...person,
      voiceProfile: { status: "failed", enrollmentDurationMs: null, enrollmentClipCount: null, source: null, updatedAt: "2026-08-31T00:00:00Z", lastError: "The voice matching model could not run." },
    });
    useWorkspace.setState({ toasts: [] });
    await useWorkspace.getState().load();
    useWorkspace.setState({ toasts: [] });

    await useWorkspace.getState().assignSpeaker(firstMeeting.id, "A", person.id);
    await vi.waitFor(() => expect(useWorkspace.getState().toasts.some((toast) => toast.tone === "error"
      && toast.message.includes("Couldn't learn Ben's voice"))).toBe(true));
  });

  it("never enrolls a person whose automatic labeling is turned off", async () => {
    service.loadWorkspace.mockResolvedValue(enrollmentSnapshot({
      status: "disabled",
      enrollmentDurationMs: null,
      enrollmentClipCount: null,
      source: null,
      updatedAt: "2026-08-31T00:00:00Z",
      lastError: null,
    }));
    await useWorkspace.getState().load();

    await useWorkspace.getState().assignSpeaker(firstMeeting.id, "A", person.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.enrollVoiceProfile).not.toHaveBeenCalled();
  });
});
