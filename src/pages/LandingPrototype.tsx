import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Mic, Network, Plus } from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";

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
  "Hi. I'm LYKN. Before I can be useful, I want to know you — not just what you make, but who you are. Tell me about yourself.";

// Opener questions, ordered to match the `fact_kind` categories in
// `lykn_user_model_facts`: identity → focus → goal → style. These are
// intentionally about the PERSON (values, interests, personality, how they
// think) rather than only their projects or work.
const QUESTIONS = [
  "Who are you, in your own words?",
  "What lights you up right now — what are you into?",
  "What do you want more of in your life?",
  "How does your brain work best — lists, talking it out, sketching, walking?",
];

const FACT_KIND_ORDER = ["identity", "focus", "goal", "style"] as const;
type FactKind = (typeof FACT_KIND_ORDER)[number];

interface FactNode {
  id: string;
  kind: FactKind;
  text: string;
}

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

// Onboarding instruction. The model decides on its own whether to include
// the hidden <learned>...</learned> tag, and only does so when the user
// actually shared something personal.
const buildChatPrompt = (userText: string): string => {
  return [
    "You are LYKN, a curious and warm AI just meeting a new user. You are in casual onboarding conversation, and your PRIMARY GOAL right now is to learn about them as a PERSON — not just their job or projects.",
    "",
    "Reply naturally in 1 to 2 short sentences (max ~40 words). Sound human, not corporate. Don't lecture about LYKN's features.",
    "",
    "Lean your curiosity toward the HUMAN — their personality, values, interests, passions, how they think, what they care about, what kind of person they are. Projects and work are valid signals too, but don't only ask about output.",
    "",
    "Decide whether the user just shared something genuinely PERSONAL about themselves as a HUMAN — their identity, personality, values, interests, passions, what they care about, what they're working on, their goals, or how they think and work. Treat 'who they are' as broader than just their job or what they make.",
    "",
    "CASE A — they shared something personal:",
    "- Acknowledge it warmly in your reply",
    '- Include the phrase "I just learned something about you." somewhere natural in your reply',
    "- Ask one short curious follow-up question — bias the follow-up toward learning more about THEM (their why, their feelings, their personality), not just more details about the project",
    "- End your ENTIRE message with this hidden tag (do not explain it to the user):",
    "  <learned>2 to 6 word noun phrase summarizing what you learned about the person</learned>",
    "",
    "CASE B — they did NOT share personal info (greetings, questions to you, jokes, small talk, vague messages, asking what LYKN does):",
    "- Respond casually and naturally",
    "- Gently steer toward learning about THEM as a person (not 'what are you working on' as the default — try 'what are you into lately', 'what kind of person are you', 'what's been on your mind', etc.)",
    '- Do NOT include "I just learned something about you."',
    "- Do NOT include the <learned> tag",
    "",
    "Examples:",
    'User: "hey"',
    'You: "Hey! I\'d love to actually get to know you — what kind of person are you when you\'re not busy?"',
    "",
    'User: "what do you do?"',
    'You: "I\'m here to grow into your second brain, but I can\'t do much until I know you. Tell me something about yourself — what are you into?"',
    "",
    'User: "I\'m a really introverted person and I take long walks every morning"',
    'You: "Long walks sound like the perfect introvert recharge — moving without performing. I just learned something about you. What\'s usually going through your head out there? <learned>Introvert who walks daily</learned>"',
    "",
    'User: "I care a lot about climate stuff and animal welfare"',
    'You: "That\'s a lot to carry — both feel urgent in different ways. I just learned something about you. Which one pulls at you more day to day? <learned>Cares about climate and animals</learned>"',
    "",
    'User: "I\'m a content creator who makes videos about photography"',
    'You: "Photography content has such a specific audience. I just learned something about you. What got you into photography in the first place? <learned>Photography content creator</learned>"',
    "",
    "Now respond to this message:",
    `User: "${userText}"`,
  ].join("\n");
};

interface GuestHistoryMsg {
  role: "user" | "model";
  content: string;
}

// During streaming, hide everything from <learned> onward so the user never
// sees the tag flicker into view as the model writes it.
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

async function streamChatResponse(
  prompt: string,
  history: GuestHistoryMsg[],
  onChunk: (visibleText: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${API_BASE_URL}/api/ai/stream-guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, history }),
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
  const [chatVisible, setChatVisible] = useState(false);
  const [thinkingDone, setThinkingDone] = useState(false);
  const [typedGreeting, setTypedGreeting] = useState("");
  const [greetingDone, setGreetingDone] = useState(false);
  const [visibleQuestions, setVisibleQuestions] = useState(0);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [factNodes, setFactNodes] = useState<FactNode[]>([]);
  const [synthesisOpen, setSynthesisOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const sendDisabled = draft.trim().length === 0;
  const showCursor = thinkingDone && (!greetingDone || !allQuestionsShown);

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    const idx = messages.length;
    const msgId = `msg_${Date.now()}_${idx}`;

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
      buildChatPrompt(text),
      history,
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

        // Map the new fact onto its category. We use the message index so
        // the first thing learned is `identity`, second `focus`, etc. — but
        // only when the AI actually decided to learn something.
        let newNode: FactNode | undefined;
        if (learned) {
          const usedKinds = new Set(factNodes.map((n) => n.kind));
          const nextKind: FactKind =
            FACT_KIND_ORDER.find((k) => !usedKinds.has(k)) ??
            FACT_KIND_ORDER[FACT_KIND_ORDER.length - 1];
          newNode = {
            id: `fact_${Date.now()}_${idx}`,
            kind: nextKind,
            text: learned,
          };
          setFactNodes((prev) => [...prev, newNode!]);
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

      {/* Main column shifts left to make room for the synthesis sidebar
          when it's open, so the chat conversation doesn't get covered. */}
      <div
        className={`relative z-10 flex-1 w-full flex flex-col transition-all duration-500 ease-out ${
          synthesisOpen ? "lg:pr-[380px]" : ""
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
                                onClick={() => setSynthesisOpen(true)}
                                className="lykn-wake-neuron-pill inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold tracking-wide text-blue-100 border border-blue-400/45 bg-blue-500/[0.08] hover:bg-blue-500/[0.16] hover:text-white transition-colors cursor-pointer"
                                title="Open the synthesis layer"
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

      {/* Synthesis layer sidebar — slides in when the user clicks the
          "Click to see it" button on any AI response. */}
      <aside
        aria-hidden={!synthesisOpen}
        className={`lykn-wake-synth-panel fixed top-0 right-0 bottom-0 w-[360px] max-w-[88vw] z-[60] flex flex-col transition-transform duration-500 ease-out ${
          synthesisOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-white/8">
          <div className="lykn-wake-synth-icon w-7 h-7 rounded-lg flex items-center justify-center">
            <Network className="w-3.5 h-3.5 text-blue-300" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[13px] font-semibold text-white/90 tracking-tight">
              Synthesis Layer
            </span>
            <span className="text-[10px] text-white/40 tracking-wide">
              {factNodes.length === 0
                ? "Listening…"
                : `${factNodes.length} neuron${factNodes.length === 1 ? "" : "s"}`}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scrollbar-hide px-4 py-4 space-y-3">
          {factNodes.length === 0 ? (
            <div className="text-xs text-white/35 text-center py-8 px-4">
              Nothing here yet. Whatever you tell LYKN about yourself will
              appear here as a neuron it remembers.
            </div>
          ) : (
            factNodes.map((node) => (
              <div
                key={node.id}
                className="lykn-wake-synth-node group relative rounded-xl border border-blue-400/25 bg-gradient-to-br from-[#1a2230] to-[#131a26] p-3.5"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span
                    aria-hidden
                    className="w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_10px_rgba(96,165,250,0.95)]"
                  />
                  <span className="text-[10px] uppercase tracking-[0.12em] text-blue-300/80 font-semibold">
                    {node.kind}
                  </span>
                </div>
                <p className="text-[13px] text-white/85 leading-snug">
                  {node.text}
                </p>
                <p className="mt-2.5 text-[10px] text-white/35 tracking-wide">
                  1 source &middot; just now
                </p>
              </div>
            ))
          )}
        </div>
      </aside>
    </div>
  );
};

export default LandingPrototype;
