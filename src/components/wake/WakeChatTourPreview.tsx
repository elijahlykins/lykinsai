import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import LyknChatBarToolbar from "@/components/lyknChat/LyknChatBarToolbar";
import WakeModelMenuPreview from "@/components/wake/WakeModelMenuPreview";
import { resizeLyknChatInput } from "@/components/lyknChat/LyknChatComposer";
import { getCollapsedPreview } from "@/lib/chatChunks";
import { LYKN_ID } from "@/lib/modelCatalog";
import { AI_GUEST_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import { WAKE_CHAT_TYPED_WELCOME } from "@/lib/wake/wakeChatTour";
import { WAKE_WALKTHROUGH_GATE_TEXT } from "@/components/wake/wakeSynthesisAddMenu";
import {
  incrementWakeChatPreviewSendCount,
  readWakeChatPreviewSendCount,
  streamWakeChatPreview,
  wakeChatPreviewCapReached,
  WAKE_CHAT_PREVIEW_LIMIT_TEXT,
  WAKE_CHAT_PREVIEW_MESSAGE_CAP,
  type WakeChatPreviewHistoryMsg,
} from "@/lib/wake/wakeChatPreviewStream";

interface PreviewMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

interface WakeChatTourPreviewProps {
  active?: boolean;
  /** Show the model selector "pulled up" above the chat bar. Only the
      standalone chat feature preview opts in; the full app-shell preview
      leaves it closed. */
  showModelMenu?: boolean;
  /** Render the pulled-up model menu on a light surface (light-theme preview). */
  lightModelMenu?: boolean;
}

const CHAT_TIMEOUT_MS = 30_000;
const LONG_PROMPT_CHARS = 320;

type PreviewTurn = {
  user: PreviewMessage;
  assistant?: PreviewMessage;
};

function groupPreviewTurns(messages: PreviewMessage[]): PreviewTurn[] {
  const turns: PreviewTurn[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    const next = messages[i + 1];
    const assistant = next?.role === "assistant" ? next : undefined;
    turns.push({ user: msg, assistant });
    if (assistant) i += 1;
  }
  return turns;
}

export default function WakeChatTourPreview({
  active = true,
  showModelMenu = false,
  lightModelMenu = false,
}: WakeChatTourPreviewProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sendCount, setSendCount] = useState(() => readWakeChatPreviewSendCount());
  const [walkthroughGateOpen, setWalkthroughGateOpen] = useState(false);
  const [gateText, setGateText] = useState(WAKE_WALKTHROUGH_GATE_TEXT);
  const [expandedAiMsgIds, setExpandedAiMsgIds] = useState<Set<string>>(() => new Set());
  const [expandedUserPromptIds, setExpandedUserPromptIds] = useState<Set<string>>(() => new Set());
  const prevMessageCountRef = useRef(0);

  const capReached = sendCount >= WAKE_CHAT_PREVIEW_MESSAGE_CAP;
  const remaining = Math.max(0, WAKE_CHAT_PREVIEW_MESSAGE_CAP - sendCount);
  const hasMessages = messages.length > 0;
  const turns = useMemo(() => groupPreviewTurns(messages), [messages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    resizeLyknChatInput(el);
  }, [input]);

  useEffect(() => {
    if (!active || !hasMessages) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isLoading, active, hasMessages]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const count = messages.length;
    if (count > prevMessageCountRef.current && count > 0) {
      const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
      if (latestAssistant) {
        setExpandedAiMsgIds(new Set([latestAssistant.id]));
      }
    }
    prevMessageCountRef.current = count;
    // Only re-expand when a new message is appended, not on stream updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  const toggleAiExpanded = useCallback((msgId: string) => {
    setExpandedAiMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }, []);

  const toggleUserPromptExpanded = useCallback((msgId: string) => {
    setExpandedUserPromptIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId);
      else next.add(msgId);
      return next;
    });
  }, []);

  const showFeatureGate = useCallback(() => {
    setGateText(WAKE_WALKTHROUGH_GATE_TEXT);
    setWalkthroughGateOpen(true);
  }, []);

  const showLimitGate = useCallback(() => {
    setGateText(WAKE_CHAT_PREVIEW_LIMIT_TEXT);
    setWalkthroughGateOpen(true);
  }, []);

  const buildHistory = useCallback((): WakeChatPreviewHistoryMsg[] => {
    const history: WakeChatPreviewHistoryMsg[] = [];
    for (const msg of messages) {
      if (msg.streaming) continue;
      if (!msg.content.trim()) continue;
      history.push({
        role: msg.role === "user" ? "user" : "model",
        content: msg.content,
      });
    }
    return history;
  }, [messages]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isLoading) return;

    if (wakeChatPreviewCapReached()) {
      showLimitGate();
      return;
    }

    const userId = `wake-user-${Date.now()}`;
    const assistantId = `wake-ai-${Date.now()}`;
    const history = buildHistory();

    setInput("");
    setIsLoading(true);
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: text },
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);

    const nextCount = incrementWakeChatPreviewSendCount();
    setSendCount(nextCount);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);

    streamWakeChatPreview(
      text,
      history,
      (visible) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: visible, streaming: true } : m,
          ),
        );
      },
      controller.signal,
    )
      .then((full) => {
        window.clearTimeout(timeoutId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: full.trim() || AI_GUEST_TEMPORARY_FAILURE_TEXT,
                  streaming: false,
                }
              : m,
          ),
        );
      })
      .catch(() => {
        window.clearTimeout(timeoutId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: m.content.trim() || AI_GUEST_TEMPORARY_FAILURE_TEXT,
                  streaming: false,
                }
              : m,
          ),
        );
      })
      .finally(() => {
        setIsLoading(false);
        abortRef.current = null;
      });
  }, [buildHistory, input, isLoading, showLimitGate]);

  const noop = useCallback(() => {}, []);

  return (
    <div className="lykn-wake-chat-preview">
      <div className="lykn-wake-chat-preview-stage">
        <div
          className={`lykn-wake-chat-preview-inner ${
            hasMessages ? "lykn-wake-chat-preview-inner-active" : ""
          }`}
        >
          {hasMessages ? (
            <div ref={scrollRef} className="lykn-wake-chat-preview-messages scrollbar-hide">
              <div className="lykn-wake-chat-preview-thread">
                {turns.map(({ user, assistant }) => {
                  const promptText = user.content || "";
                  const isLongPrompt = promptText.length > LONG_PROMPT_CHARS;
                  const isPromptExpanded = expandedUserPromptIds.has(user.id);
                  const collapsedClampStyle =
                    isLongPrompt && !isPromptExpanded
                      ? {
                          display: "-webkit-box" as const,
                          WebkitLineClamp: 5 as const,
                          WebkitBoxOrient: "vertical" as const,
                          overflow: "hidden" as const,
                        }
                      : undefined;

                  const isStreaming = Boolean(assistant?.streaming);
                  const isAiExpanded =
                    isStreaming || (assistant ? expandedAiMsgIds.has(assistant.id) : false);

                  return (
                    <div key={user.id} className="lykn-wake-chat-preview-turn">
                      <div className="lykn-wake-chat-preview-row lykn-wake-chat-preview-row-user">
                        <div className="lykn-wake-chat-preview-user-col">
                          <div
                            className="lykn-wake-chat-preview-bubble lykn-wake-chat-preview-bubble-user"
                            style={collapsedClampStyle}
                          >
                            {promptText}
                          </div>
                          {isLongPrompt && (
                            <button
                              type="button"
                              onClick={() => toggleUserPromptExpanded(user.id)}
                              title={isPromptExpanded ? "Show less" : "Show full prompt"}
                              aria-label={isPromptExpanded ? "Show less" : "Show full prompt"}
                              className="lykn-wake-chat-preview-show-more"
                            >
                              {isPromptExpanded ? (
                                <span>Show less</span>
                              ) : (
                                <>
                                  <MoreHorizontal className="w-3.5 h-3.5" />
                                  <span>Show more</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>
                      </div>

                      {assistant && isStreaming && !assistant.content ? (
                        <div className="lykn-wake-chat-preview-row lykn-wake-chat-preview-row-assistant">
                          <div className="lykn-chat-ai-thinking-glow lykn-wake-chat-preview-thinking">
                            <div className="brick-spinner" />
                            Thinking…
                          </div>
                        </div>
                      ) : assistant ? (
                        <div className="lykn-wake-chat-preview-row lykn-wake-chat-preview-row-assistant">
                          <div className="lykn-wake-chat-preview-assistant-col">
                            <button
                              type="button"
                              className={`lykn-wake-chat-preview-collapse-btn ${
                                isAiExpanded ? "lykn-wake-chat-preview-collapse-btn-expanded" : ""
                              }`}
                              onClick={() => toggleAiExpanded(assistant.id)}
                            >
                              <ChevronRight
                                className={`lykn-wake-chat-preview-collapse-chevron ${
                                  isAiExpanded ? "lykn-wake-chat-preview-collapse-chevron-open" : ""
                                }`}
                              />
                              {!isAiExpanded && (
                                <span className="lykn-wake-chat-preview-collapse-preview">
                                  {getCollapsedPreview(assistant.content || "")}
                                </span>
                              )}
                              {isAiExpanded && (
                                <span className="lykn-wake-chat-preview-collapse-label">AI Response</span>
                              )}
                            </button>
                            <div
                              className={`lykn-wake-chat-preview-collapse-panel ${
                                isAiExpanded ? "lykn-wake-chat-preview-collapse-panel-open" : ""
                              }`}
                            >
                              <div className="lykn-wake-chat-preview-collapse-panel-inner">
                                <div className="lykn-wake-chat-preview-bubble lykn-wake-chat-preview-bubble-assistant">
                                  <p className="whitespace-pre-wrap">
                                    {assistant.content}
                                    {assistant.streaming && (
                                      <span aria-hidden className="lykn-wake-cursor">
                                        |
                                      </span>
                                    )}
                                  </p>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="lykn-wake-chat-preview-prompt">{WAKE_CHAT_TYPED_WELCOME}</p>
          )}

          <div className="lykn-wake-chat-preview-composer">
            {hasMessages && !capReached && sendCount > 0 && (
              <p className="lykn-wake-chat-preview-remaining">
                {remaining} preview {remaining === 1 ? "message" : "messages"} left
              </p>
            )}
            {capReached && (
              <p className="lykn-wake-chat-preview-remaining lykn-wake-chat-preview-remaining-done">
                Preview limit reached
              </p>
            )}

            {/* Model selector shown pulled-up, mirroring the in-app menu.
                Only the standalone chat feature preview opts into this. */}
            {showModelMenu && (
              <div className="lykn-wake-chat-preview-model-menu" aria-hidden>
                <WakeModelMenuPreview selectedModel={LYKN_ID} lightMode={lightModelMenu} />
              </div>
            )}

            <div className="lykn-chat-neu-chat-shell p-2.5 sm:p-3 w-full transition-all duration-300 flex flex-col gap-1.5">
              <textarea
                ref={inputRef}
                data-min-h="52"
                value={input}
                disabled={capReached || isLoading}
                onChange={(e) => {
                  setInput(e.target.value);
                  resizeLyknChatInput(e.currentTarget);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={
                  capReached ? "Create an account to keep chatting…" : "Ask me anything..."
                }
                rows={1}
                className="w-full min-h-[3.25rem] max-h-[120px] lykn-chat-neu-chat-field px-3 py-2 text-xs leading-4 text-black dark:text-white placeholder:text-black/50 dark:placeholder:text-white/45 outline-none resize-none scrollbar-hide disabled:opacity-50"
              />

              <LyknChatBarToolbar
                onSend={handleSend}
                chatInputHasText={input.trim().length > 0 && !capReached}
                isChatLoading={isLoading}
                isDictating={false}
                isTranscribing={false}
                selectedModel={LYKN_ID}
                persistSelectedModel={noop}
                modelTier="free"
                handleOpenAttachments={showFeatureGate}
                handleStopAi={noop}
                handleDictateToggle={showFeatureGate}
              />
            </div>
          </div>
        </div>
      </div>

      {walkthroughGateOpen && (
        <div
          className="lykn-wake-synth-gate-backdrop"
          role="presentation"
          onClick={() => setWalkthroughGateOpen(false)}
        >
          <div
            className="lykn-wake-synth-gate-card"
            role="alertdialog"
            aria-label="Walkthrough notice"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="lykn-wake-synth-gate-text">{gateText}</p>
          </div>
        </div>
      )}
    </div>
  );
}
