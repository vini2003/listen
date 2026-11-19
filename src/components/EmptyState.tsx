import { AudioLines, Plus } from "lucide-react";
import { motion } from "framer-motion";

interface EmptyStateProps {
  hasMeetings: boolean;
  onCreateMeeting: () => void;
}

export function EmptyState({ hasMeetings, onCreateMeeting }: EmptyStateProps) {
  return (
    <motion.main className="welcome-view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
      <AudioLines className="welcome-mark" size={32} strokeWidth={1.5} aria-hidden="true" />
      <h1>{hasMeetings ? "Select a meeting" : "No meetings yet"}</h1>
      <button className="primary-button" onClick={onCreateMeeting}><Plus size={16} /> New meeting</button>
    </motion.main>
  );
}
