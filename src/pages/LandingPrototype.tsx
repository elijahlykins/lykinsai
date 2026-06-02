import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, ChevronDown, Mic, Plus } from "lucide-react";
import { API_BASE_URL } from "@/lib/api-config";
import AppSidebar from "@/components/AppSidebar";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  PROTOTYPE_CHAT_LS_KEY,
  PROTOTYPE_NEURONS_LS_KEY,
} from "@/lib/prototypeHandoff";
import {
  stripModelTruncationNote,
  stripModelTruncationNoteFromStream,
} from "@/lib/ai/learnedTag";
import { AI_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";
import WakeProblemsFixesSlide from "@/components/wake/WakeProblemsFixesSlide";
import WakeCreateAccountSlide from "@/components/wake/WakeCreateAccountSlide";
import WakeProductSlide from "@/components/wake/WakeProductSlide";
import WakeSynthesisSubwindow from "@/components/wake/WakeSynthesisSubwindow";
import WakeVaultSubwindow from "@/components/wake/WakeVaultSubwindow";
import WakeChatSubwindow from "@/components/wake/WakeChatSubwindow";
import WakeIntroTagline from "@/components/wake/WakeIntroTagline";

// Prototype "wake" landing experience.
//
// Sequence:
//   1. Black screen + blue perimeter trace sweeps the edge while the
//      logo + "Create beyond yourself" fade in at center together.
//   2. Left/right arrows slide between welcome, problems, synthesis, vault, chat, and create account.
//   3. Synthesis, vault, and chat slides show a product preview plus a
//      scroll-down landing-page explainer beneath it.
//   4. Create-account slide is the last carousel step (Google or email signup).
//      a. Chat bar drops to the bottom (first send only)
//      b. AI "thinking" bubble appears, then a real conversational reply
//         streams in from /api/ai/stream-guest. The first turn (which
//         mints the user's first neuron) is served by Gemini Flash for a
//         meatier reply; every later turn drops to Gemini Flash-Lite to
//         keep the preview cheap. See GUEST_MODEL_CHAIN_* in server.js.
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
  "I'm LYKN, your personal intelligence layer built by you. Let me show you around your digital brain.";

// After the greeting types out we don't dump every prompt at once.
// Instead a Get Started button quietly fades in beneath the greeting,
// and the first real question only appears once the user accepts.
// This keeps the empty-state from feeling like an interrogation form.
const FIRST_QUESTION = "Describe yourself in 1-3 sentences.";

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
  firstQuestion: string,
  messages: ChatMsg[],
) => {
  try {
    const turns: { role: "user" | "ai"; content: string }[] = [];
    turns.push({
      role: "ai",
      content: `${greeting}\n\n${firstQuestion}`,
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

const CHAT_TIMEOUT_MS = 30_000;

type IntroPhase = "welcome" | "problems" | "platform" | "vault" | "chat" | "account";

const FALLBACK_REPLY = AI_TEMPORARY_FAILURE_TEXT;

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
// Tolerates partial prefixes (`<l`, `<le`, `<lea`...) at the end of the
// buffer so half-typed tags don't flash before the closing `>` arrives.
const stripLearnedTag = (text: string): string => {
  const idx = text.indexOf("<learned>");
  if (idx !== -1) return text.slice(0, idx).trimEnd();
  const partial = text.match(/<l(?:e(?:a(?:r(?:n(?:e(?:d)?)?)?)?)?)?$/);
  if (partial && partial.index !== undefined) {
    return text.slice(0, partial.index).trimEnd();
  }
  return text;
};

// Defensive cleanup for the FINAL message after the stream completes.
// When the model does the wrong thing and starts the `<learned>` tag
// mid-sentence (e.g. "...right now. We <learned>..."), our strip leaves
// the user staring at a broken reply ending in a dangling word like
// "We" or "the". Detect that, pop the dangling clause back to the last
// real sentence boundary, and append an ellipsis so the message at
// least reads as a deliberate trail-off rather than a bug.
const FINAL_TERMINALS = /[.!?…]['"”’)]?\s*$/;
const finalizeVisibleReply = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  if (FINAL_TERMINALS.test(trimmed)) return trimmed;
  // Walk back to the last sentence-ending punctuation.
  const lastTerminal = Math.max(
    trimmed.lastIndexOf("."),
    trimmed.lastIndexOf("!"),
    trimmed.lastIndexOf("?"),
    trimmed.lastIndexOf("…"),
  );
  if (lastTerminal > 0 && lastTerminal >= trimmed.length - 80) {
    // The dangling fragment was short — drop it cleanly.
    return trimmed.slice(0, lastTerminal + 1).trimEnd();
  }
  // No safe boundary found — keep the text as-is but make the trail-off
  // visible with an ellipsis instead of a naked word.
  return trimmed + "…";
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

  const consumeLine = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6);
    if (payload === "[DONE]") return;
    try {
      const parsed = JSON.parse(payload);
      if (typeof parsed.t === "string") {
        result += parsed.t;
        // Hide the hidden <learned>/<reason> tag AND any self-emitted
        // "_…response truncated. Ask 'continue' for the rest._" style
        // marker from the live streaming view.
        onChunk(stripModelTruncationNoteFromStream(stripLearnedTag(result)));
      }
      if (parsed.error && !result) throw new Error(AI_TEMPORARY_FAILURE_TEXT);
    } catch {
      // Ignore partial JSON chunks.
    }
  };

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode(undefined, { stream: false });
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const raw of lines) consumeLine(raw);
  }
  // Drain any trailing data left in the buffer when the connection closes
  // without a final newline (Gemini occasionally does this) so the last
  // sentence of the reply doesn't silently get dropped.
  if (buffer.trim()) {
    for (const raw of buffer.split("\n")) consumeLine(raw);
    buffer = "";
  }

  return result;
}

const LandingPrototype = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [introPhase, setIntroPhase] = useState<IntroPhase>(() =>
    searchParams.get("resume") === "account" ? "account" : "welcome",
  );
  const [problemsFadingOut, setProblemsFadingOut] = useState(false);
  const [questionStarted, setQuestionStarted] = useState(false);
  // Pre-mount synthesis / vault / chat previews during the welcome slide so
  // the first forward pass does not mount heavy children on slide change
  // (which made the fixed nav arrows flicker in and out).
  const [warmSlidePreviews, setWarmSlidePreviews] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [factNodes, setFactNodes] = useState<FactNode[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchParams.get("resume") !== "account") return;
    window.history.replaceState({}, "", "/");
  }, [searchParams]);

  // Signed-in users have no business on the "build your intelligence
  // layer" onboarding chat — bounce them straight into the app. Catches both
  // the post-login `from = "/"` case and any signed-in user who lands
  // on `/` (or `/landing-prototype`) by typing the URL or following an
  // old marketing link.
  useEffect(() => {
    if (!authLoading && user) {
      if (searchParams.get("resume") === "account") return;
      navigate("/start-trial", { replace: true });
    }
  }, [authLoading, user, navigate, searchParams]);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setWarmSlidePreviews(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const hasSentFirst = messages.length > 0;

  // Focus the chat input only after the user clicks "Get started".
  useEffect(() => {
    if (!questionStarted) return;
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(raf);
  }, [questionStarted]);

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

  // Mirror created neurons into localStorage for the landing sidebar preview.
  useEffect(() => {
    persistPrototypeNeurons(factNodes);
  }, [factNodes]);

  // Mirror the conversation for the landing sidebar preview.
  useEffect(() => {
    persistPrototypeChat(GREETING, FIRST_QUESTION, messages);
  }, [messages]);

  const sendDisabled = draft.trim().length === 0;

  const handleWelcomeAdvance = () => {
    setIntroPhase("problems");
  };

  const handleIntroBack = () => {
    if (introPhase === "account") {
      setIntroPhase("chat");
      return;
    }
    if (introPhase === "chat") {
      setIntroPhase("vault");
      return;
    }
    if (introPhase === "vault") {
      setIntroPhase("platform");
      return;
    }
    if (introPhase === "platform") {
      setIntroPhase("problems");
      return;
    }
    setIntroPhase("welcome");
  };

  const handleProblemsAdvance = () => {
    setIntroPhase("platform");
  };

  const handlePlatformAdvance = () => {
    setIntroPhase("vault");
  };

  const handleVaultAdvance = () => {
    setIntroPhase("chat");
  };

  const handleChatAdvance = () => {
    setIntroPhase("account");
  };

  const handleIntroForward = () => {
    if (introPhase === "welcome") {
      handleWelcomeAdvance();
      return;
    }
    if (introPhase === "problems") {
      handleProblemsAdvance();
      return;
    }
    if (introPhase === "platform") {
      handlePlatformAdvance();
      return;
    }
    if (introPhase === "vault") {
      handleVaultAdvance();
      return;
    }
    if (introPhase === "chat") {
      handleChatAdvance();
    }
  };

  const introSwipeRef = useRef({ x: 0, y: 0 });

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    const idx = messages.length;
    const msgId = `msg_${Date.now()}_${idx}`;

    // If the user types and sends before clicking "Get started",
    // treat them as if they did — once a real message is in flight
    // the intro button is meaningless and the AI block at the top
    // should settle into its post-intro state (showing the first
    // question) rather than still offering the button. Also flag
    // the old intro as fading so the absolutely-positioned block
    // at the top doesn't pop away abruptly under the message that
    // just got submitted.
    if (!questionStarted) {
      setQuestionStarted(true);
    }

    // Landing onboarding chat is uncapped on the marketing page.

    // Build conversational history so Gemini sees the full thread, not just
    // the latest message in isolation. We use the visible (tag-stripped)
    // version of prior AI replies — the model doesn't need to see its own
    // <learned> tags echoed back.
    const history: GuestHistoryMsg[] = [
      {
        role: "model",
        content: `${GREETING}\n\n${FIRST_QUESTION}`,
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
        // Strip both the hidden <learned> tag AND any self-emitted
        // truncation / "ask continue" marker before the dangling-clause
        // repair runs (otherwise finalizeVisibleReply would treat the
        // truncation note's last word as the model's last sentence).
        const stripped = stripModelTruncationNote(stripLearnedTag(finalRaw));
        const visible = finalizeVisibleReply(stripped) || FALLBACK_REPLY;
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
        // No client-side fallback neuron: if the user's first
        // message was off-topic / not actually a self-description,
        // we'd rather have the AI politely re-ask than mint a
        // garbage neuron from random text. The server-side
        // onboarding prompt handles the re-ask in CASE B.

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

  const showIntroSlideNav =
    !questionStarted && !hasSentFirst && !problemsFadingOut;
  const introBackDisabled = introPhase === "welcome";

  const chatBarBlock = (
    <div className="lykn-wake-chat-shell omnia-neu-chat-shell p-2.5 sm:p-3 w-full flex flex-col gap-1.5">
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
          <span className="truncate">LYKN</span>
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
    <div className="dark lykn-wake-stage relative w-full max-w-[100dvw] min-h-screen overflow-hidden flex flex-col">
      {introPhase === "welcome" && (
        <div aria-hidden className="lykn-wake-screen-trace" />
      )}


      <div
        className={`relative z-10 flex-1 min-h-0 w-full flex flex-col transition-all duration-500 ease-out ${
          sidebarOpen ? "lg:pl-[12rem]" : ""
        } ${
          introPhase === "welcome" && !questionStarted && !hasSentFirst
            ? "pointer-events-none"
            : ""
        }`}
      >
        {!hasSentFirst ? (
          questionStarted ? (
            <div className="relative flex-1 w-full flex items-center justify-center px-4 py-16 overflow-y-auto scrollbar-hide">
              <div className="pointer-events-none absolute inset-x-0 top-0 bottom-1/2 flex items-center justify-center px-4">
                <h1 className="lykn-wake-prompt-in w-full max-w-2xl text-center text-2xl sm:text-3xl md:text-[34px] font-semibold leading-tight text-white">
                  {FIRST_QUESTION}
                </h1>
              </div>
              <div className="lykn-wake-chat-fade-in w-full max-w-2xl pointer-events-auto">
                {chatBarBlock}
              </div>
            </div>
          ) : (
          <div
            className="lykn-wake-slides-viewport relative flex-1 w-full min-h-0 pointer-events-auto"
            onTouchStart={(e) => {
              if (!showIntroSlideNav || e.touches.length !== 1) return;
              const t = e.touches[0];
              introSwipeRef.current = { x: t.clientX, y: t.clientY };
            }}
            onTouchEnd={(e) => {
              if (!showIntroSlideNav || e.changedTouches.length !== 1) return;
              const t = e.changedTouches[0];
              const dx = t.clientX - introSwipeRef.current.x;
              const dy = t.clientY - introSwipeRef.current.y;
              if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
              if (dx < 0) {
                if (introPhase !== "account") handleIntroForward();
              } else if (!introBackDisabled) {
                handleIntroBack();
              }
            }}
          >
            <div
              className={`lykn-wake-slides-track ${
                introPhase === "account"
                  ? "lykn-wake-slides-at-account"
                  : introPhase === "chat"
                  ? "lykn-wake-slides-at-chat"
                  : introPhase === "vault"
                  ? "lykn-wake-slides-at-vault"
                  : introPhase === "platform"
                    ? "lykn-wake-slides-at-platform"
                    : introPhase === "problems"
                      ? "lykn-wake-slides-at-problems"
                      : ""
              }`}
            >
              <div className="lykn-wake-slide">
                <div className="lykn-wake-slide-inner">
                  <div className="lykn-wake-logo-stack flex flex-col items-center text-center">
                    <img
                      src={lyknLogo}
                      alt="LYKN"
                      className="lykn-wake-logo-reveal"
                    />
                    <WakeIntroTagline className="lykn-wake-tagline-reveal" />
                  </div>
                </div>
              </div>

              <WakeProblemsFixesSlide
                active={introPhase === "problems"}
                fadingOut={problemsFadingOut}
              />

              <WakeProductSlide
                active={introPhase === "platform"}
                surface="synthesis"
                fadingOut={problemsFadingOut}
              >
                <WakeSynthesisSubwindow
                  active={introPhase === "platform"}
                  preload={warmSlidePreviews}
                />
              </WakeProductSlide>

              <WakeProductSlide
                active={introPhase === "vault"}
                surface="vault"
                fadingOut={problemsFadingOut}
              >
                <WakeVaultSubwindow
                  active={introPhase === "vault"}
                  preload={warmSlidePreviews}
                />
              </WakeProductSlide>

              <WakeProductSlide
                active={introPhase === "chat"}
                surface="chat"
                fadingOut={problemsFadingOut}
              >
                <WakeChatSubwindow
                  active={introPhase === "chat"}
                  preload={warmSlidePreviews}
                />
              </WakeProductSlide>

              <WakeCreateAccountSlide />
            </div>
          </div>
          )
        ) : (
          // Active conversation — messages stack from the top, chat bar pinned bottom
          <>
            <div
              ref={scrollRef}
              className="flex-1 w-full flex justify-center overflow-y-auto scrollbar-hide"
            >
              <div className="w-full max-w-2xl mx-auto px-4 pt-6 pb-4 space-y-4">
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
            {/* Chat bar fades out the moment the first neuron is created.
                The user is now meant to graduate from typing into LYKN to
                exploring what they've built — clicking the glowing
                "Neuron created" pill (or the Synthesis Layer button in
                the sidebar that mounts on the same trigger) is the only
                forward action. We keep the bar mounted in the DOM through
                the transition so the fade reads as a deliberate handoff
                rather than a snap-cut. `pointer-events-none` once it's
                gone so a stray click can't reactivate it. */}
            <div
              className={`w-full flex justify-center px-4 pb-6 pt-2 transition-opacity duration-700 ease-out ${
                factNodes.length > 0
                  ? "opacity-0 pointer-events-none"
                  : "opacity-100"
              }`}
              aria-hidden={factNodes.length > 0}
            >
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

      {showIntroSlideNav && (
        <>
          <div className="lykn-wake-slide-nav lykn-wake-slide-nav-back">
            <button
              type="button"
              onClick={handleIntroBack}
              disabled={introBackDisabled}
              tabIndex={introBackDisabled ? -1 : 0}
              aria-hidden={introBackDisabled}
              className={`lykn-wake-advance-btn ${
                introBackDisabled ? "lykn-wake-slide-nav-btn-hidden" : ""
              }`}
              aria-label="Previous slide"
              title="Back"
            >
              <ArrowLeft className="lykn-wake-advance-btn-icon pointer-events-none" strokeWidth={2.25} />
            </button>
          </div>

          <div
            className={`lykn-wake-slide-nav lykn-wake-slide-nav-forward ${
              introPhase === "account" ? "lykn-wake-slide-nav-btn-hidden" : ""
            }`}
          >
            <button
              type="button"
              onClick={handleIntroForward}
              disabled={introPhase === "account"}
              tabIndex={introPhase === "account" ? -1 : 0}
              aria-hidden={introPhase === "account"}
              className="lykn-wake-advance-btn"
              aria-label="Next slide"
              title="Next"
            >
              <ArrowRight className="lykn-wake-advance-btn-icon pointer-events-none" strokeWidth={2.25} />
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default LandingPrototype;
