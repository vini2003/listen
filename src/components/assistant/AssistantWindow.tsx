import { LoaderCircle, MessageSquareText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantContext } from "../../domain/models";
import {
  ASSISTANT_NAVIGATE_EVENT,
  listenForAssistantEvent,
  openReferenceInMain,
} from "../../services/assistantWindow";
import { watchTheme } from "../../lib/theme";
import { desktop } from "../../services/desktop";
import { useWorkspace } from "../../store/workspace";
import { MeetingChat } from "../meeting/MeetingChat";
import { ToastViewport } from "../ui/ToastViewport";

interface AssistantWindowProps {
  initialMeetingId: string | null;
}

export function AssistantWindow({ initialMeetingId }: AssistantWindowProps) {
  const { toasts, dismissToast } = useWorkspace();
  const [meetingId, setMeetingId] = useState(initialMeetingId);
  const [context, setContext] = useState<AssistantContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const contextRequest = useRef(0);

  const loadContext = useCallback(async (nextMeetingId: string, showLoading: boolean): Promise<void> => {
    const request = ++contextRequest.current;
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const next = await desktop.loadAssistantContext(nextMeetingId);
      if (request !== contextRequest.current) return;
      setContext(next);
      useWorkspace.setState({
        meetings: next.meetings,
        settings: next.settings,
      });
    } catch {
      if (request !== contextRequest.current) return;
      setContext(null);
      setError("This recording is no longer available.");
    } finally {
      if (request === contextRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (meetingId) void loadContext(meetingId, true);
    else {
      contextRequest.current += 1;
      setLoading(false);
      setError("No recording was selected for Ask.");
    }
  }, [loadContext, meetingId]);

  useEffect(() => {
    let disposed = false;
    let cleanup = (): void => {};
    void listenForAssistantEvent<string>(ASSISTANT_NAVIGATE_EVENT, (nextMeetingId) => {
      setMeetingId(nextMeetingId);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanup = unlisten;
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  useEffect(() => {
    function refreshContext(): void {
      if (meetingId) void loadContext(meetingId, false);
    }
    window.addEventListener("focus", refreshContext);
    return () => window.removeEventListener("focus", refreshContext);
  }, [loadContext, meetingId]);

  useEffect(() => {
    document.title = context ? `Ask — ${context.meeting.title}` : "Ask — Listen";
    return watchTheme(context?.settings.theme ?? "system");
  }, [context]);

  if (loading) {
    return (
      <main className="assistant-window-state" aria-busy="true">
        <LoaderCircle className="chat-spinner" size={20} />
        <span>Opening Ask…</span>
      </main>
    );
  }

  if (!context || error) {
    return (
      <main className="assistant-window-state">
        <MessageSquareText size={22} />
        <strong>Ask could not open</strong>
        <span>{error}</span>
      </main>
    );
  }

  return (
    <main className="assistant-window-shell">
      <MeetingChat
        key={context.meeting.id}
        meeting={context.meeting}
        mode="detached"
        onOpenRecordingReference={(reference) => void openReferenceInMain(reference)}
      />
      <ToastViewport toasts={toasts} onDismiss={dismissToast} />
    </main>
  );
}
