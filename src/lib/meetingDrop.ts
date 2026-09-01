import type { Meeting } from "../domain/models";

export interface MeetingDropSpot {
  projectId: string | null;
  folderId: string | null;
  index: number;
}

export function meaningfulMeetingDrop(
  meetings: Meeting[],
  meetingId: string,
  target: MeetingDropSpot,
): MeetingDropSpot | null {
  const orderedMeetings = [...meetings].sort((a, b) => a.position - b.position);
  const moving = orderedMeetings.find((meeting) => meeting.id === meetingId);
  if (!moving || moving.projectId !== target.projectId || moving.folderId !== target.folderId) {
    return target;
  }

  const sourceIndex = orderedMeetings
    .filter((meeting) => meeting.projectId === moving.projectId && meeting.folderId === moving.folderId)
    .findIndex((meeting) => meeting.id === meetingId);
  return target.index === sourceIndex || target.index === sourceIndex + 1 ? null : target;
}
