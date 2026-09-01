export function focusTranscriptTime(meetingId: string, timeMs: number): void {
  const rows = [...document.querySelectorAll<HTMLElement>(
    `[data-meeting-id="${CSS.escape(meetingId)}"][data-transcript-start-ms]`,
  )];
  const target = rows.reduce<HTMLElement | null>((nearest, row) => {
    if (!nearest) return row;
    const rowDistance = Math.abs(Number(row.dataset.transcriptStartMs) - timeMs);
    const nearestDistance = Math.abs(Number(nearest.dataset.transcriptStartMs) - timeMs);
    return rowDistance < nearestDistance ? row : nearest;
  }, null);
  if (!target) return;
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("reference-target");
  window.setTimeout(() => target.classList.remove("reference-target"), 1_500);
}
