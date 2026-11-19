import { motion } from "framer-motion";
import { memo, useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Meeting } from "../../domain/models";
import { useMeetingPlayback } from "../../hooks/useMeetingPlayback";
import type { SettingsSection } from "../dialogs/SettingsDialog";
import { MeetingChat } from "./MeetingChat";
import { MeetingHeader } from "./MeetingHeader";
import { RecordingDock } from "./RecordingDock";
import { Transcript } from "./Transcript";

interface MeetingViewProps {
  meeting: Meeting;
  onOpenPeople: () => void;
  onOpenSettings: (section?: SettingsSection) => void;
}

function MeetingViewImpl({ meeting, onOpenPeople, onOpenSettings }: MeetingViewProps) {
  const [wideChatWidth, setWideChatWidth] = useState(readWideChatWidth);
  const [askClearance, setAskClearance] = useState(0);
  const meetingRef = useRef<HTMLElement>(null);
  const [meetingWidth, setMeetingWidth] = useState(0);
  useLayoutEffect(() => {
    const element = meetingRef.current;
    if (!element) return;
    setMeetingWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setMeetingWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [meeting.id]);
  const maxChatWidth = meetingWidth >= 1120 ? Math.min(760, meetingWidth - 520) : undefined;
  const chatWidth = Math.min(wideChatWidth, maxChatWidth ?? wideChatWidth);
  const saveWidePanelWidth = useCallback((width: number) => {
    try { window.localStorage.setItem("listen.askWidePanelWidth", String(width)); } catch { /* Optional preference. */ }
  }, []);
  const playback = useMeetingPlayback(meeting);
  const hasSavedAudio = Boolean(meeting.audioDirectory && meeting.durationMs > 0 && meeting.status !== "recording");

  return (
    <motion.main
      ref={meetingRef}
      className={`meeting-view${hasSavedAudio ? " has-saved-audio" : ""}`}
      key={meeting.id}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      style={{ "--wide-chat-width": `${chatWidth}px`, "--ask-clearance": `${askClearance}px` } as CSSProperties}
    >
      <MeetingHeader meeting={meeting} playback={playback}>
        {hasSavedAudio && meeting.status !== "processing" ? <RecordingDock meeting={meeting} compact /> : null}
      </MeetingHeader>
      <section className="transcript-container">
        <Transcript meeting={meeting} onOpenPeople={onOpenPeople} transport={playback} />
      </section>

      {!hasSavedAudio ? <RecordingDock meeting={meeting} /> : null}
      <MeetingChat
        meeting={meeting}
        onOpenSettings={onOpenSettings}
        onPanelClearanceChange={setAskClearance}
        widePanelWidth={chatWidth}
        maxWidePanelWidth={maxChatWidth}
        onWidePanelWidthChange={setWideChatWidth}
        onWidePanelResizeEnd={saveWidePanelWidth}
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

export const MeetingView = memo(MeetingViewImpl);
