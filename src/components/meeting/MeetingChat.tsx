import {
  Check,
  ChevronDown,
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
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage, ChatScope, Meeting, Project } from "../../domain/models";
import { useWorkspace } from "../../store/workspace";
import { CustomSelect } from "../ui/CustomSelect";

interface MeetingChatProps {
  meeting: Meeting;
  project: Project | null;
}

const ReactMarkdown = lazy(() => import("react-markdown"));

export function MeetingChat({ meeting, project }: MeetingChatProps) {
  const {
    settings,
    chatMessages,
    chatLoading,
    chatBusy,
    loadChat,
    completeChat,
  } = useWorkspace();
  const [scopeType, setScopeType] = useState<"meeting" | "project">("meeting");
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scope = useMemo<ChatScope>(() => ({
    scopeType,
    scopeId: scopeType === "project" && project ? project.id : meeting.id,
  }), [meeting.id, project, scopeType]);

  useEffect(() => {
    setScopeType("meeting");
    setExpanded(false);
    setDraft("");
    setEditingId(null);
  }, [meeting.id]);

  useEffect(() => {
    if (scopeType === "project" && !project) setScopeType("meeting");
  }, [project, scopeType]);

  useEffect(() => {
    void loadChat(scope);
  }, [loadChat, scope.scopeId, scope.scopeType]);

  useEffect(() => {
    if (chatMessages.length > 0) setExpanded(true);
  }, [chatMessages.length]);

  useEffect(() => {
    if (!expanded) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatMessages, chatBusy, expanded]);

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

  const scopeOptions = [
    { value: "meeting", label: "This recording" },
    ...(project ? [{ value: "project", label: project.name, description: "Entire project" }] : []),
  ];

  return (
    <section
      className={`meeting-chat ${expanded ? "expanded" : "collapsed"}`}
    >
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            className="meeting-chat-panel"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.17 }}
          >
            <div className="meeting-chat-header">
              <span className="meeting-chat-title"><Sparkles size={15} /> Ask Listen</span>
              <div className="meeting-chat-scope">
                <CustomSelect
                  compact
                  ariaLabel="Conversation scope"
                  value={scopeType}
                  options={scopeOptions}
                  onChange={(value) => setScopeType(value as "meeting" | "project")}
                />
              </div>
              <button className="chat-icon-button" onClick={() => setExpanded(false)} aria-label="Collapse conversation">
                <ChevronDown size={16} />
              </button>
            </div>

            <div className="meeting-chat-messages" ref={scrollRef}>
              {chatLoading ? (
                <div className="chat-loading"><LoaderCircle className="chat-spinner" size={16} /> Loading conversation</div>
              ) : chatMessages.length === 0 ? (
                <div className="chat-empty">
                  <Sparkles size={18} />
                  <strong>Ask about this {scopeType === "project" ? "project" : "recording"}</strong>
                  <span>Try “What was decided?” or “List the follow-up work.”</span>
                </div>
              ) : (
                chatMessages.map((message) => (
                  <article className={`chat-message ${message.role}`} key={message.id}>
                    <div className="chat-message-label">{message.role === "user" ? "You" : "Listen"}</div>
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
        {!expanded ? (
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
            ? `Ask about this ${scopeType === "project" ? "project" : "meeting"}…`
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
