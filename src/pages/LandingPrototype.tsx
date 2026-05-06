import { Fragment, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUp, ChevronDown, Mic, Plus } from "lucide-react";
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
//   1. Boot intro: muted screen + "Welcome to Synthetic Intelligence /
//      The Future of Thinking" title card, then mute lifts and the
//      blue perimeter conic-gradient sweeps the screen edge.
//   2. Chat bar fades in vertically centered. AI greeting types out
//      at the top of the conversation column, followed by:
//        a. A "Get started" button fades in beneath the greeting.
//        b. User clicks the button → the greeting + button block
//           opacity-fades out, and the first question
//           ("What are you passionate about?") fades in as a large
//           centered headline directly above the chat box. The chat
//           box itself stays anchored at viewport center the whole
//           time and the input gets focus.
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

const TYPING_GREETING_MS = 32;
const CHAT_REVEAL_DELAY_MS = 460;
const THINKING_DURATION_MS = 1100;
// How long to wait after the greeting finishes typing before
// fading in the Get Started button.
const START_BUTTON_DELAY_MS = 500;
const CHAT_TIMEOUT_MS = 30_000;

// Boot intro on first paint. The screen sits muted (translucent
// blurred wash) while the "Welcome to Synthetic Intelligence" /
// "The Future of Thinking" title card fades in, holds, then
// fades out. Once the mute lifts the regular wake sequence
// (perimeter trace, "Waking up..." bubble, typed greeting) takes
// over. The overlay itself animates for 4800ms; the title and
// tagline finish their staggered fade-out around 5400ms — we
// hold the wrapper a touch past that before unmounting.
const WAKE_BOOT_DURATION_MS = 5500;

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
  const { user, loading: authLoading, signInWithOAuth, signOut } = useAuth();
  const navigate = useNavigate();
  const [bootActive, setBootActive] = useState(true);
  const [chatVisible, setChatVisible] = useState(false);
  const [thinkingDone, setThinkingDone] = useState(false);
  const [typedGreeting, setTypedGreeting] = useState("");
  const [greetingDone, setGreetingDone] = useState(false);
  // Intro flow after the greeting types out:
  //   1. startButtonVisible flips true on a short delay → the Get
  //      Started button fades in beneath the greeting.
  //   2. On click (or early send), oldIntroFadingOut flips true →
  //      the greeting + button block opacity-transitions to 0.
  //   3. ~320ms later questionStarted flips true → the FIRST_QUESTION
  //      fades in above the chat box and the input gets focus.
  const [startButtonVisible, setStartButtonVisible] = useState(false);
  const [oldIntroFadingOut, setOldIntroFadingOut] = useState(false);
  const [questionStarted, setQuestionStarted] = useState(false);
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

  // Boot mute timer runs on first paint and lifts the overlay
  // after WAKE_BOOT_DURATION_MS. The greeting sequence below is
  // deliberately gated on bootActive so the "Waking up..." bubble
  // and the typed greeting don't run hidden underneath the mute.
  useEffect(() => {
    const boot = window.setTimeout(
      () => setBootActive(false),
      WAKE_BOOT_DURATION_MS,
    );
    return () => window.clearTimeout(boot);
  }, []);

  // Greeting sequence — only kicks off once the boot mute has
  // lifted. We give a small CHAT_REVEAL_DELAY_MS breath after
  // the overlay clears before the "Waking up..." bubble appears,
  // then the regular thinking → typed-greeting cadence plays.
  useEffect(() => {
    if (bootActive) return;
    const reveal = window.setTimeout(
      () => setChatVisible(true),
      CHAT_REVEAL_DELAY_MS,
    );
    const swap = window.setTimeout(
      () => setThinkingDone(true),
      CHAT_REVEAL_DELAY_MS + THINKING_DURATION_MS,
    );
    return () => {
      window.clearTimeout(reveal);
      window.clearTimeout(swap);
    };
  }, [bootActive]);

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
    const id = window.setTimeout(
      () => setStartButtonVisible(true),
      START_BUTTON_DELAY_MS,
    );
    return () => window.clearTimeout(id);
  }, [greetingDone]);

  // Focus the chat input only after the user clicks "Get started".
  // We deliberately don't autofocus on chatVisible — during the
  // greeting/intro phase the user is reading, not typing yet, and
  // a blinking caret would compete with the typed greeting + the
  // appearing button for attention.
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
    persistPrototypeChat(GREETING, FIRST_QUESTION, messages);
  }, [messages]);

  const sendDisabled = draft.trim().length === 0;
  // Caret only blinks while the greeting is mid-typing; it
  // disappears as soon as the greeting completes so the
  // intro prompt + button can take focus visually.
  const showCursor = thinkingDone && !greetingDone;

  // Click handler for the Get Started button. Stages the
  // greeting/intro/button block fading out via opacity (a slow,
  // deliberate 600ms ease), then flips questionStarted ~620ms
  // later to mount the big centered question above the chat
  // box. The chat box itself never moves — it stays at viewport
  // center the whole time and the question is absolutely
  // positioned above it.
  const handleStartClick = () => {
    setOldIntroFadingOut(true);
    window.setTimeout(() => setQuestionStarted(true), 620);
  };

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
      setOldIntroFadingOut(true);
      setQuestionStarted(true);
    }

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

            {/* After the greeting types out: a short pause, then a
                Get Started button fades in. Once the user clicks
                it (or sends a message early), questionStarted flips
                true and we replace the button with the first
                question. */}
            {greetingDone && startButtonVisible && (
              <div className="mt-4">
                {!questionStarted ? (
                  <button
                    type="button"
                    onClick={handleStartClick}
                    className="lykn-wake-question-fade lykn-wake-start-btn inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold tracking-wide text-blue-100 border border-blue-400/45 bg-blue-500/[0.10] hover:bg-blue-500/[0.20] hover:text-white hover:border-blue-300/70 transition-colors cursor-pointer"
                  >
                    Get started
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <p className="lykn-wake-question-fade text-white/90 font-medium">
                    {FIRST_QUESTION}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

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
    <div
      className={`dark lykn-wake-stage relative w-screen min-h-screen overflow-hidden flex flex-col ${
        bootActive ? "lykn-wake-boot-active" : ""
      }`}
    >
      {/* Perimeter conic "lightning" trace. Mounted only after the
          boot intro finishes so its 2.8s sweep starts cleanly as
          the title card fades out and the mute lifts — that way
          the bright edge sweep is the visual reveal of the page,
          not something half-played behind the mute. */}
      {!bootActive && <div aria-hidden className="lykn-wake-screen-trace" />}

      {/* Standard app sign-in pill (same component used in
          AppSidebar's top-left). Mounted only before the AppSidebar
          itself appears (which happens after the first neuron is
          created — see AppSidebar mount further down) so the two
          don't double up. Hidden during the boot mute so it doesn't
          peek through. Matches the exact styling/behaviour of the
          AppSidebar pill: avatar circle + "Sign in" / "Signed in"
          label, Google OAuth on click, confirm-then-signOut for an
          authed user. */}
      {!bootActive && factNodes.length === 0 && (
        <div className="lykn-wake-signin-fade fixed left-4 top-4 z-[80] flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              if (user) {
                const ok = window.confirm("Sign out of your account?");
                if (ok) signOut();
              } else {
                signInWithOAuth("google");
              }
            }}
            className="flex items-center gap-1.5 rounded-full bg-white/45 dark:bg-[rgba(60,60,60,0.14)] backdrop-blur-sm border border-black/6 dark:border-white/10 pl-1 pr-3 py-1 text-[0.6875rem] text-black/70 dark:text-white/70 hover:bg-white/60 dark:hover:bg-white/15 shadow-sm transition-colors"
            title={user ? "Sign out" : "Sign in"}
          >
            <div className="h-6 w-6 rounded-full bg-blue-500/15 dark:bg-blue-400/20 text-[0.6875rem] font-semibold text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">
              {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
            </div>
            <span>{user ? "Signed in" : "Sign in"}</span>
          </button>
        </div>
      )}

      {/* Boot intro — the stage is muted to full black while the
          "Synthetic Intelligence" wordmark fades in/holds/fades
          out at center. Once both finish the wrapper unmounts and
          the regular wake sequence (perimeter trace, "Waking up"
          bubble, typed greeting) is revealed. */}
      {bootActive && (
        <>
          <div aria-hidden className="lykn-wake-boot-overlay" />
          <div aria-hidden className="lykn-wake-boot-title-group">
            <div className="lykn-wake-boot-title">
              Welcome to Synthetic Intelligence
            </div>
            <div className="lykn-wake-boot-tagline">
              The Future of Thinking
            </div>
          </div>
        </>
      )}

      {/* Main column shifts right when the left sidebar opens, so the
          chat conversation isn't covered by the sidebar. */}
      <div
        className={`relative z-10 flex-1 w-full flex flex-col transition-all duration-500 ease-out ${
          sidebarOpen ? "lg:pl-[12rem]" : ""
        }`}
      >
        {!hasSentFirst ? (
          // Empty state — two distinct phases. The chat bar
          // does NOT exist yet during phase (a); it only mounts
          // in phase (b) so the greeting feels like the entire
          // surface, then the workspace materializes around it.
          //   (a) Pre-click (!questionStarted): greeting +
          //       Get Started button sit in the dead center of
          //       the stage with no chat bar present. On click,
          //       this whole block opacity-fades out
          //       (oldIntroFadingOut) and then unmounts ~620ms
          //       later when questionStarted flips.
          //   (b) Post-click (questionStarted): the FIRST_QUESTION
          //       mounts as a large centered headline in the upper
          //       half of the stage and the chat bar mounts at
          //       viewport center. Both fade in together — the
          //       headline via lykn-wake-prompt-in, the chat bar
          //       via lykn-wake-chat-fade-in — so the layout
          //       arrives as one coordinated reveal.
          <div className="relative flex-1 w-full flex items-center justify-center px-4">
            {!questionStarted && (
              <div
                className={`w-full max-w-2xl transition-opacity duration-700 ease-out ${
                  oldIntroFadingOut
                    ? "opacity-0 pointer-events-none"
                    : "opacity-100 pointer-events-auto"
                }`}
              >
                {aiMessageBlock}
              </div>
            )}

            {questionStarted && (
              <>
                {/* Container spans the upper half of the stage
                    (top-0 → bottom-1/2) and centers the question
                    within that band, which lands the headline at
                    ~25% from the top — visually halfway between
                    the top edge and the centered chat bar. The
                    headline class chains a slow fade-up + a
                    delayed electric-blue text-shadow that settles
                    into a persistent slight glow. */}
                <div className="pointer-events-none absolute inset-x-0 top-0 bottom-1/2 flex items-center justify-center px-4">
                  <h1 className="lykn-wake-prompt-in w-full max-w-2xl text-center text-2xl sm:text-3xl md:text-[34px] font-semibold leading-tight text-white">
                    {FIRST_QUESTION}
                  </h1>
                </div>

                {/* Chat bar appears for the first time here, paired
                    with the headline. The wrapper handles the
                    opacity + slide-up reveal; the chat shell's own
                    persistent ring + halo come along for the ride. */}
                <div className="lykn-wake-chat-fade-in w-full max-w-2xl">
                  {chatBarBlock}
                </div>
              </>
            )}
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
    </div>
  );
};

export default LandingPrototype;
