import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Mic, Plus } from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";
import AppSidebar from "@/components/AppSidebar";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  GUEST_CHAT_SESSION_CAP,
  guestChatCapReached,
  incrementGuestChatCount,
  PROTO_GRID_INTRO_SS_KEY,
  PROTO_VAULT_INTRO_SS_KEY,
  PROTOTYPE_CHAT_LS_KEY,
  PROTOTYPE_NEURONS_LS_KEY,
  writePrototypeStep,
} from "@/lib/prototypeHandoff";

// Prototype "wake" landing experience.
//
// Sequence:
//   1. Electric blue conic-gradient sweep around the screen perimeter
//   2. Chat bar fades in vertically centered, AI greeting + opener questions
//      type / fade in at the top of the conversation column
//   3. On each user message:
//      a. Chat bar drops to the bottom (first send only)
//      b. AI "thinking" bubble appears, then a real conversational reply
//         streams in from /api/ai/stream-guest (Gemini)
//      c. The AI itself decides whether the message contained a learnable
//         fact about the user. If yes, it acknowledges it in its reply
//         ("I just learned something about you.") and ends with a hidden
//         <learned>phrase</learned> tag — we strip the tag from display
//         and use the phrase to create a neuron in the synthesis layer
//      d. If a neuron was created, a glowing "Neuron created" pill +
//         "Click to see it" button appears below the AI message
//      e. Clicking the button slides the synthesis sidebar in from the right
//
// Casual messages ("hey", "what can you do?", jokes, small talk) get a
// natural reply with NO neuron — only genuine personal info triggers one.

const GREETING =
  "I'm LYKN — your synthetic intelligence layer, custom-built for you. Right now I'm empty. Unlike general AI trained on everyone, synthetic intelligence is synthesized from you alone — your sources, your taste, the way you think.";

// Opener questions, ordered to match the `fact_kind` categories in
// `lykn_user_model_facts`: identity → focus → goal → style. Mix is
// deliberate — half work / half "who you are" — but nothing private.
// "What you do" + "what you're known for" + "what you're after" is
// enough signal to start synthesizing without prying for personal
// details a visitor wouldn't share with an empty chat.
const QUESTIONS = [
  "What do you do, and what are you known for?",
  "What are you working on right now?",
  "What are you trying to make happen next?",
  "How do you work best — deep focus, fast iteration, lots of research?",
];

const FACT_KIND_ORDER = ["identity", "focus", "goal", "style"] as const;
type FactKind = (typeof FACT_KIND_ORDER)[number];

interface FactNode {
  id: string;
  kind: FactKind;
  text: string;
  /**
   * Brief 1-sentence "why was this neuron created" description, supplied
   * by the model alongside the learned phrase. Surfaced in the Synthesis
   * Layer detail panel so each neuron explains itself.
   */
  reason?: string;
}

const persistPrototypeNeurons = (nodes: FactNode[]) => {
  try {
    if (nodes.length === 0) {
      window.localStorage.removeItem(PROTOTYPE_NEURONS_LS_KEY);
      return;
    }
    window.localStorage.setItem(
      PROTOTYPE_NEURONS_LS_KEY,
      JSON.stringify(
        nodes.map((n, i) => ({
          id: n.id,
          kind: n.kind,
          text: n.text,
          reason: n.reason || "",
          ordinal: i + 1,
          createdAt: Date.now(),
        })),
      ),
    );
  } catch {
    // localStorage can fail in private mode — non-critical.
  }
};

// Persist the conversation transcript so the Synthesis Layer can render
// the user's first chat as a "grid" — a tangible artifact alongside the
// freshly-formed neuron — instead of showing an empty Grids category.
const persistPrototypeChat = (
  greeting: string,
  questions: string[],
  messages: ChatMsg[],
) => {
  try {
    const turns: { role: "user" | "ai"; content: string }[] = [];
    turns.push({
      role: "ai",
      content: `${greeting}\n\n${questions.map((q) => `• ${q}`).join("\n")}`,
    });
    messages.forEach((m) => {
      turns.push({ role: "user", content: m.content });
      if (m.aiStreamComplete && m.aiResponse) {
        turns.push({ role: "ai", content: m.aiResponse });
      }
    });
    if (turns.length <= 1) {
      window.localStorage.removeItem(PROTOTYPE_CHAT_LS_KEY);
      return;
    }
    window.localStorage.setItem(PROTOTYPE_CHAT_LS_KEY, JSON.stringify(turns));
  } catch {
    // localStorage can fail in private mode — non-critical.
  }
};

interface ChatMsg {
  id: string;
  content: string;
  aiResponse: string;
  aiStreamComplete: boolean;
  factNodeId?: string;
}

const TYPING_GREETING_MS = 32;
const CHAT_REVEAL_DELAY_MS = 460;
const THINKING_DURATION_MS = 1100;
const QUESTION_START_DELAY_MS = 500;
const QUESTION_STAGGER_MS = 180;
const CHAT_TIMEOUT_MS = 30_000;

const FALLBACK_REPLY =
  "Hmm — I had trouble responding just now. Mind trying that again?";

// All onboarding instructions (CASE A/B, <learned> tag mechanic, anti-
// repetition rule, examples) live SERVER-SIDE in the system prompt and
// are activated by passing `mode: "landing-onboarding"` to
// /api/ai/stream-guest. We deliberately do NOT wrap the user's text in
// instructions on the client — when this content was sent as the user
// message, the model occasionally echoed it back into the visible reply.
// See server.js → buildLandingOnboardingSystemPrompt().

interface GuestHistoryMsg {
  role: "user" | "model";
  content: string;
}

// During streaming, hide everything from <learned> onward so the user never
// sees either the <learned> or trailing <reason> tag flicker into view.
const stripLearnedTag = (text: string): string => {
  const idx = text.indexOf("<learned>");
  if (idx === -1) return text;
  return text.slice(0, idx).trimEnd();
};

// After the stream completes, parse out the learned phrase if present.
const extractLearnedPhrase = (text: string): string | null => {
  const match = text.match(/<learned>\s*([\s\S]+?)\s*<\/learned>/i);
  if (!match) return null;
  const phrase = match[1]
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .replace(/[.!?]$/, "")
    .slice(0, 90);
  if (!phrase || phrase.length > 90) return null;
  return phrase;
};

// Extract the model-supplied "why was this neuron created" sentence. The
// neuron's detail panel surfaces this so each neuron explains itself.
const extractLearnedReason = (text: string): string | null => {
  const match = text.match(/<reason>\s*([\s\S]+?)\s*<\/reason>/i);
  if (!match) return null;
  const reason = match[1]
    .trim()
    .replace(/^["'`]|["'`]$/g, "")
    .slice(0, 240);
  if (!reason) return null;
  return reason;
};

async function streamChatResponse(
  prompt: string,
  history: GuestHistoryMsg[],
  alreadyLearned: string[],
  onChunk: (visibleText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/ai/stream-guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      history,
      mode: "landing-onboarding",
      alreadyLearned,
    }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error("chat: bad response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload);
        if (typeof parsed.t === "string") {
          result += parsed.t;
          onChunk(stripLearnedTag(result));
        }
        if (parsed.error) throw new Error(String(parsed.error));
      } catch {
        // Ignore partial JSON chunks.
      }
    }
  }

  return result;
}

const LandingPrototype = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [chatVisible, setChatVisible] = useState(false);
  const [thinkingDone, setThinkingDone] = useState(false);
  const [typedGreeting, setTypedGreeting] = useState("");
  const [greetingDone, setGreetingDone] = useState(false);
  const [visibleQuestions, setVisibleQuestions] = useState(0);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [factNodes, setFactNodes] = useState<FactNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Signed-in users have no business on the synthetic-intelligence
  // onboarding chat — bounce them straight into the app. Catches both
  // the post-login `from = "/"` case and any signed-in user who lands
  // on `/` (or `/landing-prototype`) by typing the URL or following an
  // old marketing link.
  useEffect(() => {
    if (!authLoading && user) {
      navigate("/app", { replace: true });
    }
  }, [authLoading, user, navigate]);

  const hasSentFirst = messages.length > 0;
  const allQuestionsShown = visibleQuestions >= QUESTIONS.length;

  useEffect(() => {
    const reveal = window.setTimeout(() => setChatVisible(true), CHAT_REVEAL_DELAY_MS);
    const swap = window.setTimeout(
      () => setThinkingDone(true),
      CHAT_REVEAL_DELAY_MS + THINKING_DURATION_MS,
    );
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(swap);
    };
  }, []);

  useEffect(() => {
    if (!thinkingDone) return;
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setTypedGreeting(GREETING.slice(0, i));
      if (i >= GREETING.length) {
        window.clearInterval(id);
        setGreetingDone(true);
      }
    }, TYPING_GREETING_MS);
    return () => window.clearInterval(id);
  }, [thinkingDone]);

  useEffect(() => {
    if (!greetingDone) return;
    const timeoutIds: number[] = [];
    const start = window.setTimeout(() => {
      QUESTIONS.forEach((_, i) => {
        const id = window.setTimeout(
          () => setVisibleQuestions((prev) => Math.max(prev, i + 1)),
          i * QUESTION_STAGGER_MS,
        );
        timeoutIds.push(id);
      });
    }, QUESTION_START_DELAY_MS);
    return () => {
      window.clearTimeout(start);
      timeoutIds.forEach((id) => window.clearTimeout(id));
    };
  }, [greetingDone]);

  useEffect(() => {
    if (!chatVisible) return;
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [chatVisible]);

  useEffect(() => {
    if (!hasSentFirst) return;
    const id = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [hasSentFirst]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Mirror created neurons into localStorage so the SynthesisLayer page can
  // pick them up when the user navigates over from the prototype.
  //
  // Walkthrough nudge: when the AI learns the FIRST neuron of this
  // session (factNodes flipping from 0 → 1+), reset the walkthrough
  // back to the "synthesis" step. We deliberately overwrite any stale
  // "vault" / "grid" / "done" value that may be sitting in localStorage
  // from a previous test run — this is the canonical "user just
  // started over" signal, so the guided tour should always replay from
  // the top when the user creates a fresh first neuron.
  const prevFactCountRef = useRef(0);
  useEffect(() => {
    persistPrototypeNeurons(factNodes);
    const prev = prevFactCountRef.current;
    if (prev === 0 && factNodes.length > 0) {
      writePrototypeStep("synthesis");
      // Re-arm any one-shot session flags downstream pages set so they
      // don't replay across visits (e.g. the vault's typed intro chat).
      // The walkthrough is starting over — those nudges should fire
      // again on this run.
      try {
        sessionStorage.removeItem(PROTO_VAULT_INTRO_SS_KEY);
        sessionStorage.removeItem(PROTO_GRID_INTRO_SS_KEY);
      } catch {
        // ignore (private mode etc.)
      }
    }
    prevFactCountRef.current = factNodes.length;
  }, [factNodes]);

  // Mirror the conversation so the SynthesisLayer can render the chat as
  // the user's very first "grid" (an artifact of their first session
  // with LYKN).
  useEffect(() => {
    persistPrototypeChat(GREETING, [...QUESTIONS], messages);
  }, [messages]);

  const sendDisabled = draft.trim().length === 0;
  const showCursor = thinkingDone && (!greetingDone || !allQuestionsShown);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    const idx = messages.length;
    const msgId = `msg_${Date.now()}_${idx}`;

    // Session-scoped guest cap. Server enforces per-IP / per-day too,
    // but stopping here keeps the UI honest and saves an LLM call.
    if (guestChatCapReached()) {
      setMessages((prev) => [
        ...prev,
        {
          id: msgId,
          content: text,
          aiResponse:
            `You've hit the free preview limit (${GUEST_CHAT_SESSION_CAP} messages). ` +
            "Sign in (it's free) to keep chatting and save what you've made.",
          aiStreamComplete: true,
        },
      ]);
      setDraft("");
      return;
    }
    incrementGuestChatCount();

    // Build conversational history so Gemini sees the full thread, not just
    // the latest message in isolation. We use the visible (tag-stripped)
    // version of prior AI replies — the model doesn't need to see its own
    // <learned> tags echoed back.
    const history: GuestHistoryMsg[] = [
      {
        role: "model",
        content: `${GREETING}\n\n${QUESTIONS.map((q) => `- ${q}`).join("\n")}`,
      },
    ];
    messages.forEach((m) => {
      history.push({ role: "user", content: m.content });
      if (m.aiStreamComplete && m.aiResponse) {
        history.push({ role: "model", content: m.aiResponse });
      }
    });

    setMessages((prev) => [
      ...prev,
      { id: msgId, content: text, aiResponse: "", aiStreamComplete: false },
    ]);
    setDraft("");

    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      CHAT_TIMEOUT_MS,
    );

    streamChatResponse(
      text,
      history,
      factNodes.map((n) => n.text),
      (partial) => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId ? { ...m, aiResponse: partial } : m,
          ),
        );
      },
      controller.signal,
    )
      .then((finalRaw) => {
        window.clearTimeout(timeoutId);
        const visible = stripLearnedTag(finalRaw).trim() || FALLBACK_REPLY;
        const learned = extractLearnedPhrase(finalRaw);
        const reason = extractLearnedReason(finalRaw);

        // Map the new fact onto its category. We use the message index so
        // the first thing learned is `identity`, second `focus`, etc. — but
        // only when the AI actually decided to learn something.
        //
        // Dedupe defensively: if the model emits a phrase we've already
        // turned into a neuron (case-insensitive, punctuation/whitespace
        // normalized), skip the create. Otherwise the synthesis layer
        // ends up with multiple "Photography content creator" nodes
        // sitting on top of each other after a chatty conversation.
        let newNode: FactNode | undefined;
        if (learned) {
          const normalize = (s: string) =>
            s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          const candidate = normalize(learned);
          const isDuplicate =
            candidate.length > 0 &&
            factNodes.some((n) => normalize(n.text) === candidate);
          if (!isDuplicate) {
            const usedKinds = new Set(factNodes.map((n) => n.kind));
            const nextKind: FactKind =
              FACT_KIND_ORDER.find((k) => !usedKinds.has(k)) ??
              FACT_KIND_ORDER[FACT_KIND_ORDER.length - 1];
            newNode = {
              id: `fact_${Date.now()}_${idx}`,
              kind: nextKind,
              text: learned,
              reason: reason || undefined,
            };
            setFactNodes((prev) => [...prev, newNode!]);
          }
        }

        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  aiResponse: visible,
                  aiStreamComplete: true,
                  factNodeId: newNode?.id,
                }
              : m,
          ),
        );
      })
      .catch(() => {
        window.clearTimeout(timeoutId);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  aiResponse: m.aiResponse || FALLBACK_REPLY,
                  aiStreamComplete: true,
                }
              : m,
          ),
        );
      });
  };

  const aiMessageBlock = (
    <div
      className={`flex justify-start transition-all duration-500 ease-out ${
        chatVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      <div className="max-w-[80%] w-full">
        {!thinkingDone ? (
          <div className="omnia-ai-thinking-glow rounded-2xl rounded-bl-md max-w-fit px-4 py-3 text-sm leading-relaxed border bg-white/8 border-white/10 text-white/60 backdrop-blur-sm flex items-center gap-3">
            <div className="brick-spinner" />
            Waking up…
          </div>
        ) : (
          <div className="px-4 py-3 text-sm leading-relaxed break-words text-white/85">
            <span>{typedGreeting}</span>
            {showCursor && !greetingDone && (
              <span aria-hidden className="lykn-wake-cursor">|</span>
            )}

            {greetingDone && visibleQuestions > 0 && (
              <ul className="mt-3 space-y-1.5">
                {QUESTIONS.slice(0, visibleQuestions).map((q, i) => (
                  <li
                    key={i}
                    className="lykn-wake-question-fade flex items-start gap-2 text-white/65"
                  >
                    <span className="text-blue-400/80 mt-[1px] leading-tight">•</span>
                    <span>{q}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const chatBarBlock = (
    <div className="lykn-wake-chat-shell omnia-neu-chat-shell omnia-chat-border-run-once p-2.5 sm:p-3 w-full flex flex-col gap-1.5">
      <textarea
        ref={inputRef}
        data-min-h="52"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder="Tell me about yourself…"
        rows={1}
        className="w-full min-h-[3.25rem] max-h-[180px] omnia-neu-chat-field px-3 py-2 text-xs leading-4 text-white placeholder:text-white/45 outline-none resize-none scrollbar-hide"
      />

      {/* Toolbar row — visual replica of OmniaChatBarToolbar */}
      <div className="flex items-center gap-1.5 pt-1">
        <button
          type="button"
          className="omnia-neu-chat-toolbar-select-trigger inline-flex items-center justify-start gap-0 h-9 max-w-[9rem] min-w-0 shrink rounded-lg border-0 bg-transparent text-xs px-1.5 font-medium text-white/80 shadow-none overflow-hidden"
          title="Model"
        >
          <span className="truncate">Claude Sonnet 4.6</span>
          <ChevronDown className="w-3.5 h-3.5 opacity-40 shrink-0 ml-1" />
        </button>
        <div className="flex-1 min-w-[4px]" aria-hidden />
        <button
          type="button"
          className="h-9 w-9 omnia-neu-chat-icon-plain flex items-center justify-center text-white/85 shrink-0"
          title="Add attachments"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="h-9 w-9 omnia-neu-chat-icon-plain flex items-center justify-center text-white/80 shrink-0"
          title="Dictate"
        >
          <Mic className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={handleSend}
          disabled={sendDisabled}
          className={`h-9 w-9 omnia-neu-chat-send-btn flex items-center justify-center shrink-0 ${
            sendDisabled
              ? "opacity-40 cursor-not-allowed"
              : "text-blue-400"
          }`}
          title="Send"
        >
          <ArrowUp className="w-3.5 h-3.5" strokeWidth={2.25} />
        </button>
      </div>
    </div>
  );

  return (
    <div className="dark lykn-wake-stage relative w-screen min-h-screen overflow-hidden flex flex-col">
      <div aria-hidden className="lykn-wake-screen-trace" />

      {/* Main column shifts right when the left sidebar opens, so the
          chat conversation isn't covered by the sidebar. */}
      <div
        className={`relative z-10 flex-1 w-full flex flex-col transition-all duration-500 ease-out ${
          sidebarOpen ? "lg:pl-[12rem]" : ""
        }`}
      >
        {!hasSentFirst ? (
          // Empty state — AI greeting anchored at the top, chat bar centered
          <div className="flex-1 w-full flex flex-col">
            <div className="w-full flex justify-center px-4 pt-6">
              <div className="w-full max-w-2xl">{aiMessageBlock}</div>
            </div>
            <div className="flex-1" aria-hidden />
            <div className="w-full flex justify-center px-4">
              <div className="w-full max-w-2xl">{chatBarBlock}</div>
            </div>
            <div className="flex-1" aria-hidden />
          </div>
        ) : (
          // Active conversation — messages stack from the top, chat bar pinned bottom
          <>
            <div
              ref={scrollRef}
              className="flex-1 w-full flex justify-center overflow-y-auto scrollbar-hide"
            >
              <div className="w-full max-w-2xl mx-auto px-4 pt-6 pb-4 space-y-4">
                {aiMessageBlock}
                {messages.map((msg) => (
                  <Fragment key={msg.id}>
                    <div className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-3 text-sm leading-relaxed text-white/90 border border-white/10 bg-white/5 shadow-[0_4px_14px_rgba(0,0,0,0.25)]">
                        {msg.content}
                      </div>
                    </div>

                    {!msg.aiResponse ? (
                      <div className="flex justify-start">
                        <div className="omnia-ai-thinking-glow rounded-2xl rounded-bl-md max-w-fit px-4 py-3 text-sm leading-relaxed border bg-white/8 border-white/10 text-white/60 backdrop-blur-sm flex items-center gap-3">
                          <div className="brick-spinner" />
                          Thinking…
                        </div>
                      </div>
                    ) : (
                      <div className="flex justify-start">
                        <div className="max-w-[80%] w-full px-4 py-3 text-sm leading-relaxed text-white/85">
                          <p className="whitespace-pre-wrap">
                            {msg.aiResponse}
                            {!msg.aiStreamComplete && (
                              <span aria-hidden className="lykn-wake-cursor">|</span>
                            )}
                          </p>
                          {msg.aiStreamComplete && msg.factNodeId && (
                            <div className="mt-3 lykn-wake-question-fade">
                              <button
                                type="button"
                                onClick={() => setSidebarOpen(true)}
                                className="lykn-wake-neuron-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide text-blue-100 border border-blue-400/45 bg-blue-500/[0.08] hover:bg-blue-500/[0.16] hover:text-white transition-colors cursor-pointer"
                                title="Open your sidebar"
                              >
                                <span
                                  aria-hidden
                                  className="w-1.5 h-1.5 rounded-full bg-blue-300 shadow-[0_0_8px_rgba(96,165,250,1)]"
                                />
                                Neuron created
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </Fragment>
                ))}
              </div>
            </div>
            <div className="w-full flex justify-center px-4 pb-6 pt-2">
              <div className="w-full max-w-2xl">{chatBarBlock}</div>
            </div>
          </>
        )}
      </div>

      {/* Once the AI has learned at least one thing about the user, the
          real left sidebar mounts in. The Synthesis Layer item glows so
          the user knows where to find the neuron they just created.
          NOTE: AppSidebar must be rendered as a direct child of the
          stage (no opacity-animated wrapper). A wrapper with an opacity
          animation creates a stacking context, which trapped the
          sidebar's fixed-position z-70/z-80 elements below the
          screen-trace overlay (z-50, fixed) — making the synthesis
          button visually visible but unclickable depending on the
          mount/animation timing. */}
      {factNodes.length > 0 && (
        <AppSidebar
          controlledOpen={sidebarOpen}
          onOpenChange={setSidebarOpen}
          highlightSynthesis
          restrictToSynthesis
        />
      )}
    </div>
  );
};

export default LandingPrototype;
