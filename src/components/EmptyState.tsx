import { AudioLines, FolderPlus, Mic } from "lucide-react";
import { motion } from "framer-motion";

interface EmptyStateProps {
  onCreateProject: () => void;
  onCreateMeeting: () => void;
}

export function EmptyState({ onCreateProject, onCreateMeeting }: EmptyStateProps) {
  return (
    <motion.main className="welcome-view" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <div className="welcome-mark"><AudioLines size={28} /></div>
      <h1>Conversations, remembered.</h1>
      <p>Record meetings, identify the people in them, and keep every useful thought close at hand.</p>
      <div className="welcome-actions">
        <button className="primary-button" onClick={onCreateMeeting}><Mic size={17} /> Start recording</button>
        <button className="secondary-button" onClick={onCreateProject}><FolderPlus size={17} /> Create project</button>
      </div>
      <div className="welcome-note"><span /> Audio stays on this device until you choose to transcribe it.</div>
    </motion.main>
  );
}
