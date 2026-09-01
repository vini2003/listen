import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, Person, Project, TranscriptSegment, WorkspaceSnapshot } from "../domain/models";

const service = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  loadMeetingSegments: vi.fn(),
  createProject: vi.fn(),
  assignSpeaker: vi.fn(),
  findVoiceEnrollmentSegment: vi.fn(),
  enrollVoiceProfile: vi.fn(),
  reorderMeetings: vi.fn(),
}));

vi.mock("../services/desktop", () => ({ desktop: service }));

import { useWorkspace } from "./workspace";

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
    pyannoteApiKeyConfigured: false,
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
      settings: { ...snapshot.settings, pyannoteApiKeyConfigured: true },
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
