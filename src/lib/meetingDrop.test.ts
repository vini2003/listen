import { describe, expect, it } from "vitest";
import type { Meeting } from "../domain/models";
import { meaningfulMeetingDrop } from "./meetingDrop";

const meetings = [meeting("a", null, 0), meeting("b", null, 1), meeting("c", null, 2)];

describe("meaningfulMeetingDrop", () => {
  it("hides both insertion points that leave a recording in place", () => {
    expect(meaningfulMeetingDrop(meetings, "b", { projectId: null, folderId: null, index: 1 })).toBeNull();
    expect(meaningfulMeetingDrop(meetings, "b", { projectId: null, folderId: null, index: 2 })).toBeNull();
  });

  it("keeps insertion points that change the order", () => {
    expect(meaningfulMeetingDrop(meetings, "b", { projectId: null, folderId: null, index: 0 }))
      .toEqual({ projectId: null, folderId: null, index: 0 });
    expect(meaningfulMeetingDrop(meetings, "b", { projectId: null, folderId: null, index: 3 }))
      .toEqual({ projectId: null, folderId: null, index: 3 });
  });

  it("keeps moves into another project", () => {
    expect(meaningfulMeetingDrop(meetings, "b", { projectId: "project", folderId: null, index: 0 }))
      .toEqual({ projectId: "project", folderId: null, index: 0 });
  });

  it("keeps moves into a folder of the same project", () => {
    const projectMeetings = [meeting("a", "project", 0), meeting("b", "project", 1)];
    expect(meaningfulMeetingDrop(projectMeetings, "b", { projectId: "project", folderId: "folder", index: 0 }))
      .toEqual({ projectId: "project", folderId: "folder", index: 0 });
  });
});

function meeting(id: string, projectId: string | null, position: number): Meeting {
  return {
    id,
    projectId,
    folderId: null,
    position,
    title: id,
    status: "ready",
    createdAt: "2026-08-13T00:00:00Z",
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    audioDirectory: null,
    errorMessage: null,
  };
}
