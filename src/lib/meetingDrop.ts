import type { Meeting } from "../domain/models";

export interface MeetingDropSpot {
  projectId: string | null;
  index: number;
}

export function meaningfulMeetingDrop(
  meetings: Meeting[],
  meetingId: string,
  target: MeetingDropSpot,
): MeetingDropSpot | null {
  const orderedMeetings = [...meetings].sort((a, b) => a.position - b.position);
  const moving = orderedMeetings.find((meeting) => meeting.id === meetingId);
  if (!moving || moving.projectId !== target.projectId) return target;

  const sourceIndex = orderedMeetings
    .filter((meeting) => meeting.projectId === moving.projectId)
    .findIndex((meeting) => meeting.id === meetingId);
  return target.index === sourceIndex || target.index === sourceIndex + 1 ? null : target;
}
