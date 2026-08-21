import { motion } from "framer-motion";
import { useState, type CSSProperties } from "react";
import type { Meeting } from "../../domain/models";
import { MeetingChat } from "./MeetingChat";
import { RecordingDock } from "./RecordingDock";
import { Transcript } from "./Transcript";

interface MeetingViewProps {
  meeting: Meeting;
  onOpenPeople: () => void;
}

export function MeetingView({ meeting, onOpenPeople }: MeetingViewProps) {
  const [wideChatWidth, setWideChatWidth] = useState(readWideChatWidth);

  return (
    <motion.main
      className="meeting-view"
      key={meeting.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      style={{ "--wide-chat-width": `${wideChatWidth}px` } as CSSProperties}
    >
      <section className="transcript-container">
        <Transcript meeting={meeting} onOpenPeople={onOpenPeople} />
      </section>

      <RecordingDock meeting={meeting} />
      <MeetingChat
        meeting={meeting}
        widePanelWidth={wideChatWidth}
        onWidePanelWidthChange={setWideChatWidth}
        onWidePanelResizeEnd={(width) => {
          try { window.localStorage.setItem("listen.askWidePanelWidth", String(width)); } catch { /* Optional preference. */ }
        }}
      />
    </motion.main>
  );
}

function readWideChatWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem("listen.askWidePanelWidth"));
    if (Number.isFinite(stored) && stored >= 320 && stored <= 760) return stored;
  } catch { /* Optional preference. */ }
  return 430;
}
