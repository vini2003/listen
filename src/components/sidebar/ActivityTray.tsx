import { AnimatePresence, motion } from "framer-motion";
import type { ReactNode } from "react";
import { AudioLines, FileInput, Fingerprint } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { phaseLabel } from "../../lib/speechModels";
import { useWorkspace } from "../../store/workspace";
import { ProgressBar } from "../speech/SpeechModelsPanel";

/**
 * Everything Listen is doing in the background, pinned above the sidebar
 * footer so long jobs stay visible from any screen. Hidden when idle.
 */
export function ActivityTray() {
  const { progress, backgroundImport, meetings, voiceLearning, people, selectMeeting } = useWorkspace(useShallow((state) => ({
    progress: state.transcriptionProgress,
    backgroundImport: state.mediaImport && (state.mediaImport.meetingId === null || state.mediaImport.meetingId !== state.selectedMeetingId) ? state.mediaImport : null,
    meetings: state.meetings,
    voiceLearning: state.voiceLearning,
    people: state.people,
    selectMeeting: state.selectMeeting,
  })));

  const jobs = Object.values(progress);
  const active = jobs.find((job) => job.phase !== "queued") ?? null;
  const waiting = jobs.filter((job) => job !== active);
  const activeMeeting = active ? meetings.find((meeting) => meeting.id === active.meetingId) : null;
  const firstVoice = people.find((person) => person.id === voiceLearning[0]);
  const voiceName = firstVoice?.nickname || firstVoice?.fullName.split(/\s+/)[0];
  const importingMeeting = backgroundImport && meetings.find((meeting) => meeting.id === backgroundImport.meetingId);
  const ImportTarget = importingMeeting ? "button" : "div";

  return (
    <div className="activity-tray" aria-live="polite">
      <AnimatePresence initial={false}>
        {backgroundImport ? (
          <ActivityItem key="import">
            <ImportTarget className="activity-main" onClick={importingMeeting ? () => selectMeeting(importingMeeting.id) : undefined}>
              <span className="activity-icon"><FileInput size={14} /></span>
              <span className="activity-copy">
                <strong>{importingMeeting ? `Importing into ${importingMeeting.title}` : "Importing file"}</strong>
                {backgroundImport.progress !== null && <small>{Math.floor(backgroundImport.progress * 100)}%</small>}
              </span>
            </ImportTarget>
            {backgroundImport.progress !== null ? <ProgressBar fraction={backgroundImport.progress} label="File import progress" /> : (
              <div className="progress-track indeterminate" role="progressbar" aria-label="File import progress"><span className="progress-fill" /></div>
            )}
          </ActivityItem>
        ) : null}
        {active || waiting.length > 0 ? (
          <ActivityItem key="transcription">
            <button
              type="button"
              className="activity-main"
              onClick={() => selectMeeting((active ?? waiting[0]).meetingId)}
              title="Open this recording"
            >
              <span className="activity-icon"><AudioLines size={14} /></span>
              <span className="activity-copy">
                <strong>{activeMeeting ? `Transcribing ${activeMeeting.title}` : "Transcription queued"}</strong>
                <small>
                  {active ? `${phaseLabel(active.phase)} · ${Math.floor(active.progress * 100)}%` : "Starting…"}
                  {waiting.length > 0 ? ` · ${waiting.length} more waiting` : ""}
                </small>
              </span>
            </button>
            <ProgressBar fraction={active?.progress ?? 0} label="Transcription progress" />
          </ActivityItem>
        ) : null}

        {voiceLearning.length > 0 ? (
          <ActivityItem key="voices">
            <div className="activity-main">
              <span className="activity-icon"><Fingerprint size={14} /></span>
              <span className="activity-copy">
                <strong>{voiceLearning.length === 1 && voiceName ? `Learning ${voiceName}'s voice` : `Learning ${voiceLearning.length} voices`}</strong>
                {jobs.length > 0 ? <small>Queued after transcription</small> : null}
              </span>
            </div>
            <div className="progress-track indeterminate" role="progressbar" aria-label="Voice learning" aria-busy="true"><span className="progress-fill" /></div>
          </ActivityItem>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ActivityItem({ children }: { children: ReactNode }) {
  return (
    <motion.div
      className="activity-item"
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Small ring in a sidebar row that fills as the meeting is transcribed. */
export function TranscriptionRing({ meetingId }: { meetingId: string }) {
  const job = useWorkspace((state) => state.transcriptionProgress[meetingId]);
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  const fraction = job && job.phase !== "queued" ? Math.max(0.04, job.progress) : 0;
  const label = !job
    ? "Transcribing"
    : job.phase === "queued"
      ? "Waiting to transcribe"
      : `Transcribing, ${Math.floor(job.progress * 100)}%`;
  return (
    <svg className={`transcription-ring ${fraction === 0 ? "waiting" : ""}`} viewBox="0 0 14 14" role="img" aria-label={label}>
      <title>{label}</title>
      <circle className="ring-track" cx="7" cy="7" r={radius} />
      <circle
        className="ring-fill"
        cx="7"
        cy="7"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={fraction === 0 ? circumference * 0.75 : circumference * (1 - fraction)}
      />
    </svg>
  );
}
