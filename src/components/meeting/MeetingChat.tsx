import {
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
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { ChatMessage, ChatScope, Meeting } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { useWorkspace } from "../../store/workspace";

interface MeetingChatProps {
  meeting: Meeting;
}

const ReactMarkdown = lazy(() => import("react-markdown"));
const DEFAULT_PANEL_HEIGHT = 360;

export function MeetingChat({ meeting }: MeetingChatProps) {
  const {
    settings,
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
    if (await completeChat(scope, content)) setDraft("");
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

  return (
    <section
      ref={chatRef}
      className={`meeting-chat ${panelVisible ? "expanded" : "collapsed"} ${wideLayout ? "wide" : ""}`}
      style={{ "--chat-panel-height": `${panelHeight}px` } as CSSProperties}
    >
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
            <div className="meeting-chat-header">
              <span className="meeting-chat-title"><Sparkles size={15} /> Ask</span>
              {!wideLayout ? (
                <button className="chat-icon-button" onClick={() => setExpanded(false)} aria-label="Close Ask">
                  <X size={15} />
                </button>
              ) : null}
            </div>

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
                  <article className={`chat-message ${message.role}`} key={message.id}>
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
                          <ReactMarkdown>{message.content}</ReactMarkdown>
                        </Suspense>
                      </div>
                    )}
                    {editingId !== message.id ? (
                      <div className="chat-message-actions">
                        {message.role === "user" ? (
                          <button onClick={() => { setEditingId(message.id); setEditDraft(message.content); }} title="Edit and resend"><Pencil size={13} /></button>
                        ) : (
                          <button onClick={() => void copyMessage(message)} title="Copy response">
                            {copiedId === message.id ? <Check size={13} /> : <Copy size={13} />}
                          </button>
                        )}
                        <button onClick={() => resend(message)} title="Resend" disabled={chatBusy}><RotateCcw size={13} /></button>
                      </div>
                    ) : null}
                  </article>
                ))
              )}
              {chatBusy ? (
                <div className="chat-thinking"><span /><span /><span /></div>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="meeting-chat-composer">
        {!panelVisible ? (
          <button className="chat-expand-button" onClick={() => setExpanded(true)} aria-label="Open conversation">
            <ChevronUp size={16} />
          </button>
        ) : null}
        <Sparkles className="chat-composer-icon" size={16} />
        <textarea
          ref={textareaRef}
          rows={1}
          maxLength={12_000}
          value={draft}
          disabled={chatBusy}
          placeholder={settings.apiKeyConfigured
            ? "Ask about this meeting…"
            : "Add a text model API key in Settings…"}
          onFocus={() => setExpanded(true)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => handleComposerKeyDown(event, sendMessage)}
        />
        <button
          className="chat-send-button"
          onClick={() => void sendMessage()}
          disabled={!draft.trim() || chatBusy || !settings.apiKeyConfigured}
          aria-label="Send question"
        >
          {chatBusy ? <LoaderCircle className="chat-spinner" size={16} /> : <Send size={16} />}
        </button>
      </div>
    </section>
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
