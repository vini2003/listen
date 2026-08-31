import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Meeting, Project, TranscriptSegment, WorkspaceSnapshot } from "../domain/models";

const service = vi.hoisted(() => ({
  loadWorkspace: vi.fn(),
  loadMeetingSegments: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock("../services/desktop", () => ({ desktop: service }));

import { useWorkspace } from "./workspace";

const firstMeeting: Meeting = {
  id: "meeting-1",
  projectId: null,
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
    privacyNoticeVersion: "2026-08-14",
    biometricConsentAcceptedAt: null,
    speakerIdentificationEnabled: false,
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
});
