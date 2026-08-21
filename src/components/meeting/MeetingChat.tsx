import {
  AudioLines,
  Check,
  ChevronUp,
  Copy,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Send,
  Sparkles,
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
import { parseRecordingHref, renderableChatContent } from "../../lib/chatReferences";
import { shortcutAria, shortcutLabel } from "../../lib/shortcuts";
import { useWorkspace } from "../../store/workspace";

interface MeetingChatProps {
  meeting: Meeting;
  widePanelWidth: number;
  onWidePanelWidthChange: (width: number) => void;
  onWidePanelResizeEnd: (width: number) => void;
}

const ReactMarkdown = lazy(() => import("react-markdown"));
const DEFAULT_PANEL_HEIGHT = 360;

export function MeetingChat({ meeting, widePanelWidth, onWidePanelWidthChange, onWidePanelResizeEnd }: MeetingChatProps) {
  const {
    settings,
    meetings,
    selectMeeting,
    chatMessages,
    chatLoading,
    chatBusy,
    loadChat,
    completeChat,
  } = useWorkspace();
  const wideLayout = useWideChatLayout();
  const [expanded, setExpanded] = useState(false);
  const [panelHeight, setPanelHeight] = useState(readPanelHeight);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const wideResizeRef = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  const panelVisible = expanded || wideLayout;
  const chatRef = useDismissableLayer<HTMLElement>(expanded && !wideLayout, () => setExpanded(false));
  const scope = useMemo<ChatScope>(() => ({
    scopeType: "meeting",
    scopeId: meeting.id,
  }), [meeting.id]);

  useEffect(() => {
    setExpanded(false);
    setDraft("");
    setEditingId(null);
  }, [meeting.id]);

  useEffect(() => {
    void loadChat(scope);
  }, [loadChat, scope.scopeId, scope.scopeType]);

  useEffect(() => {
    if (!panelVisible) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages, chatBusy, panelVisible]);

  useEffect(() => resizeTextarea(textareaRef.current), [draft]);

  async function sendMessage(): Promise<void> {
    const content = draft.trim();
    if (!content || chatBusy || !settings.apiKeyConfigured) return;
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

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    resizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: panelHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizePanel(event: ReactPointerEvent<HTMLDivElement>): void {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const maximum = Math.max(240, window.innerHeight - 205);
    setPanelHeight(Math.max(220, Math.min(maximum, resize.startHeight + resize.startY - event.clientY)));
  }

  function finishResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    try { window.localStorage.setItem("listen.askPanelHeight", String(panelHeight)); } catch { /* Optional preference. */ }
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
    const meetingWidth = event.currentTarget.closest<HTMLElement>(".meeting-view")?.clientWidth ?? window.innerWidth;
    const maximum = Math.max(320, Math.min(760, meetingWidth - 460));
    const width = Math.max(320, Math.min(maximum, resize.startWidth + resize.startX - event.clientX));
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
    const meetingWidth = event.currentTarget.closest<HTMLElement>(".meeting-view")?.clientWidth ?? window.innerWidth;
    const maximum = Math.max(320, Math.min(760, meetingWidth - 460));
    const width = event.key === "Home"
      ? 320
      : event.key === "End"
        ? maximum
        : Math.max(320, Math.min(maximum, widePanelWidth + (event.key === "ArrowLeft" ? 24 : -24)));
    onWidePanelWidthChange(width);
    onWidePanelResizeEnd(width);
  }

  function openRecordingReference(meetingId: string, timeMs: number): void {
    if (!meetings.some((candidate) => candidate.id === meetingId)) return;
    selectMeeting(meetingId);
    window.setTimeout(() => focusTranscriptTime(meetingId, timeMs), 60);
  }

  return (
    <section
      ref={chatRef}
      className={`meeting-chat ${panelVisible ? "expanded" : "collapsed"} ${wideLayout ? "wide" : ""}`}
      style={{ "--chat-panel-height": `${panelHeight}px` } as CSSProperties}
    >
      {wideLayout ? (
        <div
          className="chat-wide-resize-handle"
          role="separator"
          aria-label="Resize Ask sidebar"
          aria-orientation="vertical"
          aria-valuemin={320}
          aria-valuemax={760}
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
      <AnimatePresence initial={false}>
        {panelVisible ? (
          <motion.div
            className="meeting-chat-panel"
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            transition={{ duration: 0.17 }}
          >
            {!wideLayout ? (
              <div
                className="chat-resize-handle"
                role="separator"
                aria-label="Resize Ask panel"
                aria-orientation="horizontal"
                onDoubleClick={() => setPanelHeight(DEFAULT_PANEL_HEIGHT)}
                onPointerDown={beginResize}
                onPointerMove={resizePanel}
                onPointerUp={finishResize}
                onPointerCancel={finishResize}
              ><span /></div>
            ) : null}
            {!wideLayout ? (
              <button className="chat-close-button" onClick={() => setExpanded(false)} aria-label="Close Ask">
                <X size={14} />
              </button>
            ) : null}

            <div className="meeting-chat-messages" ref={scrollRef}>
              {chatLoading ? (
                <div className="chat-loading"><LoaderCircle className="chat-spinner" size={16} /> Loading conversation</div>
              ) : chatMessages.length === 0 ? (
                <div className="chat-empty">
                  <Sparkles size={18} />
                  <strong>Ask about this recording</strong>
                  <span>Try “What was decided?” or “List the follow-up work.”</span>
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
                          maxLength={12_000}
                          value={editDraft}
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setEditingId(null);
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
                  <motion.div className="chat-thinking" initial={{ opacity: 0, y: 5, scale: .94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 3, scale: .96 }} transition={{ duration: .16 }}><span /><span /><span /></motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="meeting-chat-composer">
        {!wideLayout ? (
          <button
            className="chat-expand-button"
            onClick={() => setExpanded((current) => !current)}
            aria-label={expanded ? "Close conversation" : "Open conversation"}
            aria-expanded={expanded}
          >
            <ChevronUp size={16} />
          </button>
        ) : null}
        <Sparkles className="chat-composer-icon" size={16} />
        <textarea
          ref={textareaRef}
          data-ask-composer
          rows={1}
          maxLength={12_000}
          value={draft}
          placeholder={settings.apiKeyConfigured
            ? "Ask about this meeting…"
            : "Add a text model API key in Settings…"}
          onFocus={() => setExpanded(true)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => handleComposerKeyDown(event, sendMessage)}
          aria-label="Ask about this meeting"
          aria-keyshortcuts={shortcutAria("k")}
          title={`Focus Ask (${shortcutLabel("k")})`}
        />
        <button
          className="chat-send-button"
          onClick={() => void sendMessage()}
          disabled={!draft.trim() || chatBusy || !settings.apiKeyConfigured}
          aria-label="Send question"
        >
          <Send size={16} />
        </button>
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

function focusTranscriptTime(meetingId: string, timeMs: number): void {
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

function previousUserMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage | null {
  const index = messages.findIndex((candidate) => candidate.id === message.id);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (messages[cursor].role === "user") return messages[cursor];
  }
  return null;
}

function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, send: () => Promise<void>): void {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
}

function resizeTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea) return;
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`;
}

function readPanelHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem("listen.askPanelHeight"));
    if (Number.isFinite(stored) && stored >= 220) return stored;
  } catch { /* Optional preference. */ }
  return DEFAULT_PANEL_HEIGHT;
}

function useWideChatLayout(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1450px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1450px)");
    const update = (event: MediaQueryListEvent): void => setWide(event.matches);
    setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return wide;
}
