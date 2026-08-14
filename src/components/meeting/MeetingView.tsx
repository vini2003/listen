import { motion } from "framer-motion";
import type { Meeting } from "../../domain/models";
import { MeetingChat } from "./MeetingChat";
import { RecordingDock } from "./RecordingDock";
import { Transcript } from "./Transcript";

interface MeetingViewProps {
  meeting: Meeting;
  onOpenPeople: () => void;
}

export function MeetingView({ meeting, onOpenPeople }: MeetingViewProps) {
  return (
    <motion.main
      className="meeting-view"
      key={meeting.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <section className="transcript-container">
        <Transcript meeting={meeting} onOpenPeople={onOpenPeople} />
      </section>

      <RecordingDock meeting={meeting} />
      <MeetingChat meeting={meeting} />
    </motion.main>
  );
}
