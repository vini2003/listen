import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  AudioLines,
  Check,
  Copy,
  LoaderCircle,
  MessageSquare,
  PanelRightClose,
  Pencil,
  PictureInPicture2,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChatMessage, ChatScope, Meeting } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { readAssistantDraft, writeAssistantDraft } from "../../lib/assistantDraft";
import { parseRecordingHref, renderableChatContent } from "../../lib/chatReferences";
import { shortcutAria, shortcutLabel } from "../../lib/shortcuts";
import { focusTranscriptTime } from "../../lib/transcriptFocus";
import {
  ASSISTANT_ATTACHED_EVENT,
  ASSISTANT_CLOSED_EVENT,
  CHAT_UPDATED_EVENT,
  attachAssistantWindow,
  attachedAssistantMeeting,
  focusAssistantWindow,
  isMatchingChatScope,
  listenForAssistantEvent,
  openAssistantWindow,
  type AssistantReference,
} from "../../services/assistantWindow";
import { useWorkspace } from "../../store/workspace";
import type { SettingsSection } from "../dialogs/SettingsDialog";

interface MeetingChatProps {
  meeting: Meeting;
  widePanelWidth?: number;
  maxWidePanelWidth?: number;
  onWidePanelWidthChange?: (width: number) => void;
  onWidePanelResizeEnd?: (width: number) => void;
  mode?: "embedded" | "detached";
  onOpenRecordingReference?: (reference: AssistantReference) => void;
  onOpenSettings?: (section?: SettingsSection) => void | Promise<void>;
  onPanelClearanceChange?: (px: number) => void;
}

const ReactMarkdown = lazy(() => import("react-markdown"));
const DEFAULT_PANEL_HEIGHT = 360;
const EMPTY_PANEL_HEIGHT = 118;

function MeetingChatImpl({
  meeting,
  widePanelWidth = 430,
  maxWidePanelWidth,
  onWidePanelWidthChange = () => {},
  onWidePanelResizeEnd = () => {},
  mode = "embedded",
  onOpenRecordingReference,
  onOpenSettings,
  onPanelClearanceChange,
}: MeetingChatProps) {
  const {
    settings,
    meetings,
    selectMeeting,
    chatMessages,
    chatLoading,
    chatBusy,
    loadChat,
    completeChat,
  } = useWorkspace(useShallow((state) => ({
    settings: state.settings,
    meetings: state.meetings,
    selectMeeting: state.selectMeeting,
    chatMessages: state.chatMessages,
    chatLoading: state.chatLoading,
    chatBusy: state.chatBusy,
    loadChat: state.loadChat,
    completeChat: state.completeChat,
  })));
  const [expanded, setExpanded] = useState(false);
  const wideLayout = mode === "embedded" && maxWidePanelWidth !== undefined && expanded;
  const [detachedToWindow, setDetachedToWindow] = useState(false);
  const [windowActionBusy, setWindowActionBusy] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);
  const [preferredHeight, setPanelHeight] = useState(readPanelHeight);
  const panelHeight = preferredHeight ?? (chatMessages.length || chatBusy ? DEFAULT_PANEL_HEIGHT : EMPTY_PANEL_HEIGHT);
  const [draft, setDraft] = useState(() => readAssistantDraft(meeting.id));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const wideResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const panelVisible = mode === "detached" || (!detachedToWindow && expanded);
  const floating = mode === "embedded" && panelVisible && !wideLayout;
  function closePanel(): void {
    setExpanded(false);
    window.requestAnimationFrame(() => expandRef.current?.focus());
  }
  const chatRef = useDismissableLayer<HTMLElement>(floating, (reason) => {
    if (document.querySelector('[aria-modal="true"]')) return;
    if (reason === "escape") closePanel();
    if (reason === "pointer") setExpanded(false);
  });
  const scope = useMemo<ChatScope>(() => ({
    scopeType: "meeting",
    scopeId: meeting.id,
  }), [meeting.id]);

  useEffect(() => {
    setExpanded(false);
    setDraft(readAssistantDraft(meeting.id));
    setEditingId(null);
    setWindowError(null);
  }, [meeting.id]);

  useEffect(() => {
    writeAssistantDraft(meeting.id, draft);
  }, [draft, meeting.id]);

  useEffect(() => {
    void loadChat(scope);
  }, [loadChat, scope.scopeId, scope.scopeType]);

  useEffect(() => {
    let disposed = false;
    let cleanup = (): void => {};
    void listenForAssistantEvent<ChatScope>(CHAT_UPDATED_EVENT, (payload) => {
      if (isMatchingChatScope(payload, scope)) void loadChat(scope);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else cleanup = unlisten;
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [loadChat, scope.scopeId, scope.scopeType]);

  useEffect(() => {
    if (mode !== "embedded") return;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void attachedAssistantMeeting().then((meetingId) => {
      if (!disposed) setDetachedToWindow(meetingId === meeting.id);
    });
    for (const [eventName, handler] of [
      [ASSISTANT_ATTACHED_EVENT, (meetingId: string) => {
        if (meetingId !== meeting.id) return;
        setDetachedToWindow(false);
        setDraft(readAssistantDraft(meeting.id));
        setExpanded(true);
        void loadChat(scope);
      }],
      [ASSISTANT_CLOSED_EVENT, () => {
        setDetachedToWindow(false);
        setDraft(readAssistantDraft(meeting.id));
        void loadChat(scope);
      }],
    ] as const) {
      void listenForAssistantEvent(eventName, handler).then((unlisten) => {
        if (disposed) unlisten();
        else cleanups.push(unlisten);
      });
    }
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [loadChat, meeting.id, mode, scope.scopeId, scope.scopeType]);

  useEffect(() => {
    if (!panelVisible) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages, chatBusy, panelVisible]);

  useEffect(() => resizeTextarea(textareaRef.current), [draft, panelVisible]);

  useEffect(() => {
    if (!onPanelClearanceChange) return;
    const panel = panelRef.current;
    if (!floating || !panel) {
      onPanelClearanceChange(0);
      return;
    }
    onPanelClearanceChange(panel.offsetHeight);
    const observer = new ResizeObserver(() => onPanelClearanceChange(panel.offsetHeight));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [floating, onPanelClearanceChange]);

  async function sendMessage(question = draft): Promise<void> {
    const content = question.trim();
    if (!content || chatBusy) return;
    if (!settings.apiKeyConfigured) {
      setDraft(question);
      await openChatSettings();
      return;
    }
    setExpanded(true);
    setDraft("");
    await completeChat(scope, content);
  }

  async function saveEdit(message: ChatMessage): Promise<void> {
    const content = editDraft.trim();
    if (!content || chatBusy) return;
    if (await completeChat(scope, content, message.id)) {
      setEditingId(null);
      setEditDraft("");
    }
  }

  function resend(message: ChatMessage): void {
    const userMessage = message.role === "user"
      ? message
      : previousUserMessage(chatMessages, message);
    if (userMessage) void completeChat(scope, userMessage.content, userMessage.id);
  }

  async function copyMessage(message: ChatMessage): Promise<void> {
    await navigator.clipboard.writeText(message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId((current) => current === message.id ? null : current), 1_400);
  }

  async function openChatSettings(): Promise<void> {
    try {
      await onOpenSettings?.("text-model");
    } catch {
      setWindowError("Couldn’t open Settings in the main window.");
    }
  }

  async function detachConversation(): Promise<void> {
    if (chatBusy || editingId || windowActionBusy) return;
    setWindowActionBusy(true);
    setWindowError(null);
    try {
      await openAssistantWindow(meeting.id);
      setDetachedToWindow(true);
      setExpanded(false);
    } catch {
      setWindowError("Couldn’t open the chat window. Try again.");
    } finally {
      setWindowActionBusy(false);
    }
  }

  async function attachConversation(): Promise<void> {
    if (chatBusy || editingId || windowActionBusy) return;
    setWindowActionBusy(true);
    setWindowError(null);
    try {
      await attachAssistantWindow(meeting.id);
    } catch {
      setWindowError("Couldn’t return chat to the main window. Try again.");
      setWindowActionBusy(false);
    }
  }

  async function showDetachedConversation(): Promise<void> {
    setWindowError(null);
    try {
      if (!await focusAssistantWindow()) await openAssistantWindow(meeting.id);
    } catch {
      setDetachedToWindow(false);
      setWindowError("The chat window closed.");
    }
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    resizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: panelRef.current?.offsetHeight ?? panelHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizePanel(event: ReactPointerEvent<HTMLDivElement>): void {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const maximum = Math.max(240, window.innerHeight - 205);
    setPanelHeight(Math.max(EMPTY_PANEL_HEIGHT, Math.min(maximum, resize.startHeight + resize.startY - event.clientY)));
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try { window.localStorage.setItem("listen.askPanelHeight", String(panelHeight)); } catch { /* Optional preference. */ }
  }

  function resizePanelWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const maximum = Math.max(240, window.innerHeight - 205);
    const height = event.key === "Home"
      ? EMPTY_PANEL_HEIGHT
      : event.key === "End"
        ? maximum
        : Math.max(EMPTY_PANEL_HEIGHT, Math.min(maximum, panelHeight + (event.key === "ArrowUp" ? 24 : -24)));
    setPanelHeight(height);
    try { window.localStorage.setItem("listen.askPanelHeight", String(height)); } catch { /* Optional preference. */ }
  }

  function beginWideResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    wideResizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widePanelWidth,
      width: widePanelWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeWidePanel(event: ReactPointerEvent<HTMLDivElement>): void {
    const resize = wideResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const width = Math.max(320, Math.min(maxWidePanelWidth ?? 760, resize.startWidth + resize.startX - event.clientX));
    resize.width = width;
    onWidePanelWidthChange(width);
  }

  function finishWideResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const resize = wideResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    wideResizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onWidePanelResizeEnd(resize.width);
  }

  function resetWidePanel(): void {
    onWidePanelWidthChange(430);
    onWidePanelResizeEnd(430);
  }

  function resizeWidePanelWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const maximum = maxWidePanelWidth ?? 760;
    const width = event.key === "Home"
      ? 320
      : event.key === "End"
        ? maximum
        : Math.max(320, Math.min(maximum, widePanelWidth + (event.key === "ArrowLeft" ? 24 : -24)));
    onWidePanelWidthChange(width);
    onWidePanelResizeEnd(width);
  }

  function openRecordingReference(meetingId: string, timeMs: number): void {
    if (onOpenRecordingReference) {
      onOpenRecordingReference({ meetingId, timeMs });
      return;
    }
    if (!meetings.some((candidate) => candidate.id === meetingId)) return;
    selectMeeting(meetingId);
    window.setTimeout(() => focusTranscriptTime(meetingId, timeMs), 60);
  }

  if (mode === "embedded" && detachedToWindow) {
    return (
      <section className="meeting-chat detached-placeholder" aria-label="Detached chat">
        <button
          type="button"
          data-ask-composer
          className="detached-placeholder-button"
          onClick={() => void showDetachedConversation()}
          title="Show the chat window"
        >
          <PictureInPicture2 size={16} /> Show chat window
        </button>
      </section>
    );
  }

  if (!panelVisible) {
    return (
      <section className="meeting-chat collapsed" aria-label={`Chat about ${meeting.title}`}>
        <button
          ref={expandRef}
          data-ask-composer
          className="chat-launcher"
          onClick={() => setExpanded(true)}
          aria-label="Open chat"
          title={`Open chat (${shortcutLabel("k")})`}
          aria-keyshortcuts={shortcutAria("k")}
          aria-expanded={false}
        >
          <MessageSquare size={16} /> Chat <kbd aria-hidden="true">{shortcutLabel("k")}</kbd>
        </button>
      </section>
    );
  }

  return (
    <section
      ref={chatRef}
      className={`meeting-chat expanded ${wideLayout ? "wide" : ""} ${mode === "detached" ? "detached" : ""}`}
      style={{ "--chat-panel-height": `${panelHeight}px` } as CSSProperties}
      aria-label={`Chat about ${meeting.title}`}
      onKeyDown={(event) => {
        if (wideLayout && event.key === "Escape") closePanel();
      }}
    >
      {wideLayout ? (
        <div
          className="chat-wide-resize-handle"
          role="separator"
          aria-label="Resize chat sidebar"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={maxWidePanelWidth}
          aria-valuenow={Math.round(widePanelWidth)}
          tabIndex={0}
          onDoubleClick={resetWidePanel}
          onKeyDown={resizeWidePanelWithKeyboard}
          onPointerDown={beginWideResize}
          onPointerMove={resizeWidePanel}
          onPointerUp={finishWideResize}
          onPointerCancel={finishWideResize}
        ><span /></div>
      ) : null}
      <div ref={panelRef} className="meeting-chat-panel">
        {mode === "embedded" ? (
          <header className="meeting-chat-header">
            <h2>Chat</h2>
            {!wideLayout ? (
              <div
                className="chat-resize-handle"
                role="separator"
                aria-label="Resize chat panel"
                aria-orientation="horizontal"
                aria-valuemin={EMPTY_PANEL_HEIGHT}
                aria-valuemax={Math.max(240, window.innerHeight - 205)}
                aria-valuenow={Math.round(Math.min(panelHeight, Math.max(240, window.innerHeight - 205)))}
                tabIndex={0}
                onDoubleClick={() => {
                  setPanelHeight(null);
                  try { window.localStorage.removeItem("listen.askPanelHeight"); } catch { /* Optional preference. */ }
                }}
                onKeyDown={resizePanelWithKeyboard}
                onPointerDown={beginResize}
                onPointerMove={resizePanel}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
              ><span /></div>
            ) : null}
            <div className="meeting-chat-window-actions">
              <button
                className="chat-window-action"
                onClick={() => void detachConversation()}
                disabled={chatBusy || editingId !== null || windowActionBusy}
                aria-label="Detach chat"
                title="Detach chat"
              >
                <PictureInPicture2 size={15} />
              </button>
              <button className="chat-window-action" onClick={closePanel} aria-label="Close chat" title="Close chat">
                <X size={15} />
              </button>
            </div>
          </header>
        ) : null}

        {windowError ? <div className="chat-window-error" role="status">{windowError}</div> : null}

        <div className="meeting-chat-messages" ref={scrollRef}>
          {chatLoading ? (
            <div className="chat-loading" role="status"><LoaderCircle className="chat-spinner" size={16} /> Loading chat…</div>
          ) : chatMessages.length === 0 && !draft.trim() ? (
            <div className="chat-prompts" role="group" aria-label="Suggested questions">
              {["Summarize this meeting", "List action items"].map((prompt) => (
                <button key={prompt} onClick={() => void sendMessage(prompt)}>{prompt}</button>
              ))}
            </div>
          ) : (
            chatMessages.map((message) => (
              <motion.article
                layout="position"
                className={`chat-message ${message.role} ${message.pending ? "pending" : ""}`}
                key={message.id}
                initial={message.pending || message.justArrived ? { opacity: 0, y: 8, scale: 0.96 } : false}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 470, damping: 34, mass: 0.72 }}
              >
                {editingId === message.id ? (
                  <div className="chat-edit-box">
                    <textarea
                      autoFocus
                      aria-label="Edit message"
                      maxLength={12_000}
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Escape") {
                          event.stopPropagation();
                          setEditingId(null);
                        }
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void saveEdit(message);
                        }
                      }}
                    />
                    <div>
                      <button onClick={() => setEditingId(null)}><X size={13} /> Cancel</button>
                      <button onClick={() => void saveEdit(message)} disabled={!editDraft.trim() || chatBusy}><Send size={13} /> Send</button>
                    </div>
                  </div>
                ) : (
                  <div className="chat-message-content">
                    <Suspense fallback={<p>{message.content}</p>}>
                      <ReactMarkdown
                        components={{
                          a: (props) => <ChatLink {...props} onOpenRecording={openRecordingReference} />,
                        }}
                      >
                        {renderableChatContent(message.content, meeting.id)}
                      </ReactMarkdown>
                    </Suspense>
                  </div>
                )}
                {editingId !== message.id && !message.pending ? (
                  <div className="message-action-bar chat-message-actions">
                    {message.role === "user" ? (
                      <button onClick={() => { setEditingId(message.id); setEditDraft(message.content); }} title="Edit and resend" aria-label="Edit and resend message"><Pencil size={13} /></button>
                    ) : null}
                    <button onClick={() => void copyMessage(message)} title="Copy" aria-label={copiedId === message.id ? "Message copied" : "Copy message"}>
                      {copiedId === message.id ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                    <button onClick={() => resend(message)} title="Resend" aria-label="Resend message" disabled={chatBusy}><RotateCcw size={13} /></button>
                  </div>
                ) : null}
              </motion.article>
            ))
          )}
          <AnimatePresence initial={false}>
            {chatBusy ? (
              <motion.div className="chat-thinking" role="status" aria-label="Assistant is thinking" initial={{ opacity: 0, y: 5, scale: .94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 3, scale: .96 }} transition={{ duration: .16 }}><span className="chat-thinking-dot" /><span className="chat-thinking-dot" /><span className="chat-thinking-dot" /></motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>

      <div className="meeting-chat-composer">
        {mode === "detached" ? (
          <button className="chat-window-action" onClick={() => void attachConversation()}
            disabled={chatBusy || editingId !== null || windowActionBusy}
            aria-label="Return chat to main window" title="Return chat to main window">
            <PanelRightClose size={16} />
          </button>
        ) : null}
        <textarea
          ref={textareaRef}
          data-ask-composer
          rows={1}
          maxLength={12_000}
          value={draft}
          autoFocus
          placeholder="Ask about this meeting…"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => handleComposerKeyDown(event, sendMessage)}
          aria-label="Ask about this meeting"
          aria-keyshortcuts={shortcutAria("k")}
          title={`Focus chat (${shortcutLabel("k")})`}
        />
        {!settings.apiKeyConfigured && onOpenSettings ? (
          <button
            className="chat-key-button"
            onClick={() => void openChatSettings()}
            title="Add an OpenAI API key in Settings"
          >
            Add OpenAI key
          </button>
        ) : (
          <button
            className="chat-send-button"
            onClick={() => void sendMessage()}
            disabled={!draft.trim() || chatBusy || !settings.apiKeyConfigured}
            aria-label="Send question"
            title="Send question"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </section>
  );
}

function ChatLink({ href, children, onOpenRecording, ...props }: ComponentPropsWithoutRef<"a"> & {
  onOpenRecording: (meetingId: string, timeMs: number) => void;
}) {
  const reference = parseRecordingHref(href);
  if (!reference) {
    return <a {...props} href={href} target="_blank" rel="noreferrer">{children}</a>;
  }
  return (
    <a
      {...props}
      href={href}
      className="recording-reference"
      onClick={(event) => {
        event.preventDefault();
        onOpenRecording(reference.meetingId, reference.timeMs);
      }}
    >
      <AudioLines size={12} />
      <span>{children}</span>
    </a>
  );
}

function previousUserMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage | null {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === "user") return messages[cursor];
  }
  return null;
}

function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, send: () => Promise<void>): void {
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    void send();
  }
}

function resizeTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`;
}

function readPanelHeight(): number | null {
  try {
    const stored = Number(window.localStorage.getItem("listen.askPanelHeight"));
    if (Number.isFinite(stored) && stored >= EMPTY_PANEL_HEIGHT) return stored;
  } catch { /* Optional preference. */ }
  return null;
}

export const MeetingChat = memo(MeetingChatImpl);
