import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import lyknLogoMark from "@/assets/FINAL/LYKN-LOGO-B-Open/SVG/LYKN-Logo-Primary-B-Open-BLACK.svg";
import glassAdDemo from "@/assets/glass-ad-demo.png";
import { NEWS_POSTS } from "@/lib/newsPosts";
import LandingHeader from "@/components/landing/LandingHeader";
import LandingHero from "@/components/landing/LandingHero";
import HeroDesktopStage from "@/components/landing/HeroDesktopStage";
import LandingExplain from "@/components/landing/LandingExplain";
import LandingModelsTools from "@/components/landing/LandingModelsTools";
import LandingSlideshow from "@/components/landing/LandingSlideshow";
import LandingCapabilities from "@/components/landing/LandingCapabilities";
import { LyknWordmark, markLykn } from "@/components/landing/LyknWordmark";
import { useLandingLightTheme } from "@/components/landing/useLandingLightTheme";
import { streamWakeChatPreview } from "@/lib/wake/wakeChatPreviewStream";
import { AI_GUEST_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import {
  desktopHotkeyLabel,
  desktopModifierKey,
} from "@/lib/desktopHotkey";
import "./GlassLanding.css";
import "@/components/landing/landingIcy.css";

const HOTKEY = desktopHotkeyLabel();
const HOTKEY_SPACED = desktopHotkeyLabel("spaced");

// The production marketing landing page, focused on LYKN desktop (the Mac
// app). Served at "/", "/landing", and "/glass". Uses the shared
// LandingHeader routing to Features, Pricing, News, and Download.

const ICON_VIEWBOX = "0 0 204.29 204.29";
const ICON_PATH =
  "M167.39,60.26l-.86-.39c-9.83-4.41-17.7-12.28-22.12-22.12l-.39-.86c-1.77-3.94-7.36-3.94-9.13,0l-.39.86c-4.41,9.83-12.28,17.71-22.12,22.12l-.86.39c-3.94,1.77-3.94,7.36,0,9.13l.86.39c9.83,4.41,17.7,12.28,22.12,22.12l.39.86c1.77,3.94,7.36,3.94,9.13,0l.39-.86c4.41-9.83,12.28-17.7,22.12-22.12l.86-.39c3.94-1.77,3.94-7.36,0-9.13ZM134.87,116.05c-14.73,2.8-17.97,18.72-32.73,18.72-8.11,0-12.75-4.81-17.72-9.61-1.8-1.73-3.56-3.5-5.29-5.29-4.8-4.98-9.62-9.61-9.62-17.73,0-14.76,15.93-18,18.72-32.73,2.66-14.03-7.74-27.55-21.99-28.38-13.8-.8-25.24,10.16-25.24,23.79,0,18.8,19.14,21.14,19.14,37.32s-19.14,18.52-19.14,37.32c0,13.16,10.67,23.83,23.83,23.83,18.8,0,21.14-19.14,37.32-19.14s18.52,19.14,37.32,19.14c13.63,0,24.58-11.44,23.78-25.24-.82-14.25-14.35-24.66-28.38-21.99Z";

/** Pixel replica of electron/overlay.html #wrap (bar-only resting state).
    Optionally renders a "Viewed screen" thread block above the composer. */
function GlassBar({
  className = "",
  thread,
  onActivate,
}: {
  className?: string;
  thread?: { label: string; text: string };
  /** Marketing bars are visuals, not a working composer — when provided,
      interacting with the field/send funnels into the live ⌘L demo instead
      of silently doing nothing. */
  onActivate?: () => void;
}) {
  return (
    <div className={`glo-wrap ${className}`.trim()}>
      <div className="glo-titlebar" title="Drag to move">
        <span className="glo-grip" />
      </div>

      {thread ? (
        <div className="glo-thread">
          <div className="glo-thread-label">{thread.label}</div>
          <div className="glo-thread-text">{thread.text}</div>
        </div>
      ) : null}

      <div className="glo-composer">
        <div className="glo-field-row">
          <svg
            className="glo-dot"
            viewBox={ICON_VIEWBOX}
            fill="none"
            aria-hidden="true"
          >
            <path
              d={ICON_PATH}
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <textarea
            id="landing-glass-ask"
            name="landing-glass-ask"
            className="glo-ask"
            rows={1}
            placeholder="Ask LYKN about your screen…"
            autoComplete="off"
            aria-label="Ask LYKN"
            readOnly
            onFocus={onActivate}
            onKeyDown={
              onActivate
                ? (e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      onActivate();
                    }
                  }
                : undefined
            }
          />
        </div>

        <GlassToolbar onSend={onActivate} />
      </div>
    </div>
  );
}

/** The overlay bar's bottom toolbar (context picker + actions + send), shared
    by the static hero bar and the interactive ⌘L demo. */
function GlassToolbar({
  onSend,
  disabled = false,
  collapseAll,
}: {
  onSend?: () => void;
  disabled?: boolean;
  /** "Hide previous chats" toggle (demo only), mirroring the real overlay's
      collapse-all button: shown once there's history worth hiding, tinted
      while clean mode is on. */
  collapseAll?: { show: boolean; active: boolean; onToggle: () => void };
}) {
  const collapseLabel = collapseAll?.active
    ? "Show previous chats"
    : "Hide previous chats";
  return (
    <div className="glo-toolbar">
      <button type="button" className="glo-side-picker">
        <span>None</span>
      </button>
      <span className="glo-toolbar-spacer" aria-hidden="true" />

      {collapseAll?.show ? (
        <button
          type="button"
          className={`glo-btn ${collapseAll.active ? "is-active" : ""}`.trim()}
          title={collapseLabel}
          aria-label={collapseLabel}
          aria-pressed={collapseAll.active}
          onClick={collapseAll.onToggle}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m3 10 2.5-2.5L3 5" />
            <path d="m3 19 2.5-2.5L3 14" />
            <path d="M10 6h11" />
            <path d="M10 12h11" />
            <path d="M10 18h11" />
          </svg>
        </button>
      ) : null}

      <button type="button" className="glo-btn" title="More" aria-label="More">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx={5} cy={12} r={1.6} />
          <circle cx={12} cy={12} r={1.6} />
          <circle cx={19} cy={12} r={1.6} />
        </svg>
      </button>

      <button
        type="button"
        className="glo-btn"
        title="Snip from screen"
        aria-label="Snip from screen"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 2v14a2 2 0 0 0 2 2h14" />
          <path d="M18 22V8a2 2 0 0 0-2-2H2" />
        </svg>
      </button>

      <button
        type="button"
        className="glo-btn"
        title="Add photos & files"
        aria-label="Add photos and files"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      <button type="button" className="glo-btn" title="Dictate" aria-label="Dictate">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1={12} x2={12} y1={19} y2={22} />
        </svg>
      </button>

      <button
        type="button"
        className="glo-btn glo-send"
        title="Send"
        aria-label="Send"
        onClick={onSend}
        disabled={disabled}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.25}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m5 12 7-7 7 7" />
          <path d="M12 19V5" />
        </svg>
      </button>
    </div>
  );
}

/** The UI views the chips under the screenshot switch between. */
const ANY_VIEWS = [
  {
    id: "browser",
    label: "Browser",
    src: null,
    alt: "The LYKN browser pulled up on the desktop with AI search on a new tab",
    title: "One browser.",
    titleDim: "Zero busywork.",
    desc: "The LYKN browser lives on your desktop. Search with AI from a new tab, or hand it research, forms, and errands and watch it work the web on its own.",
    stage: { appWindow: "browser" },
  },
  {
    id: "context",
    label: "Context",
    src: null,
    alt: "The LYKN desktop switching between Chat, Build, and Imagine while the same ask stays in the bar",
    title: "One context.",
    titleDim: "Every mode.",
    desc: "LYKN already knows your files, projects, and what's on your screen. Switch between Chat, Build, Imagine, and Research - your context rides along, no re-explaining.",
    stage: {
      cycleModes: ["chat", "build", "imagine", "research"],
      prompt: "Use my codebase for this",
    },
  },
  {
    id: "glass",
    label: "Glass",
    src: glassAdDemo,
    alt: "LYKN Glass floating over a moodboard, rebranding a product ad on request",
    title: "One shortcut.",
    titleDim: "Every screen.",
    desc: `Press ${HOTKEY} and LYKN Glass appears over whatever you're working on. It reads the page, snips the part you care about, and acts on it, with your projects and context already loaded.`,
    stage: null,
  },
  {
    id: "apps",
    label: "Apps",
    src: null,
    alt: "The LYKN desktop in Build mode, asked to build a custom note taking app",
    title: "One sentence.",
    titleDim: "Real apps.",
    desc: "Describe the tool you wish existed and LYKN builds it - a real app that runs on your desktop, iterated with you until it feels right.",
    stage: {
      mode: "build",
      prompt: "Build me a custom note taking app",
      typePrompt: true,
    },
  },
] as const;

const ANY_ROTATE_MS = 6000;

/** LYKN Glass explainer: split layout — headline, shortcut copy,
    CTA pills, and proof stats on the left; a UI screenshot on the right
    that the chips underneath switch between. */
function AnyScreenSection() {
  const navigate = useNavigate();
  const [view, setView] = useState<(typeof ANY_VIEWS)[number]["id"]>(
    ANY_VIEWS[0].id,
  );
  const active = ANY_VIEWS.find((v) => v.id === view) ?? ANY_VIEWS[0];

  useEffect(() => {
    const id = window.setInterval(() => {
      setView((cur) => {
        const i = ANY_VIEWS.findIndex((v) => v.id === cur);
        return ANY_VIEWS[(Math.max(0, i) + 1) % ANY_VIEWS.length].id;
      });
    }, ANY_ROTATE_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="gl-any" id="about">
      <div className="gl-any-inner">
        <div className="gl-any-copy">
          <h2 className="gl-any-title gl-reveal">
            <span key={active.id} className="gl-any-sub-swap">
              {active.title}
              <br />
              <span className="gl-any-title-dim">{active.titleDim}</span>
            </span>
          </h2>
          <p className="gl-any-sub gl-reveal">
            <span key={active.id} className="gl-any-sub-swap">
              {markLykn(active.desc)}
            </span>
          </p>
          <div className="gl-any-actions gl-reveal">
            <button
              type="button"
              className="gl-any-btn gl-any-btn--primary"
              onClick={() => navigate("/download")}
              aria-label="Download LYKN"
            >
              Download&nbsp;<LyknWordmark decorative />
            </button>
          </div>
          <dl className="gl-any-stats gl-reveal">
            <div className="gl-any-stat">
              <dt>1</dt>
              <dd>Shortcut to summon it</dd>
            </div>
            <div className="gl-any-stat">
              <dt>Any</dt>
              <dd>App, doc, or browser</dd>
            </div>
            <div className="gl-any-stat">
              <dt>0</dt>
              <dd>Context re-explaining</dd>
            </div>
          </dl>
        </div>

        <div className="gl-any-stage gl-reveal">
          {active.src ? (
            <img
              key={active.id}
              className="gl-any-shot gl-any-shot--switch"
              data-header-tone="dark"
              src={active.src}
              alt={active.alt}
              draggable={false}
            />
          ) : (
            <div
              key={active.id}
              className="gl-any-live"
              data-header-tone="dark"
              role="img"
              aria-label={active.alt}
            >
              <HeroDesktopStage {...active.stage} />
            </div>
          )}
          <div className="gl-any-chips" role="tablist" aria-label="LYKN views">
            {ANY_VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                className={`gl-any-chip${view === v.id ? " is-active" : ""}`}
                onClick={() => setView(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Big showcase card: the snip animation framed in one wide card. */
function SnipShowcaseSection() {
  return (
    <section className="gl-snip" aria-label="LYKN desktop snip demo">
      <div className="gl-snip-inner">
        <div className="gl-snip-card gl-reveal">
          <video
            className="gl-snip-video"
            src="/videos/lykn-snip-article.mp4"
            autoPlay
            muted
            loop
            playsInline
            preload="metadata"
            aria-label="LYKN desktop snipping a section of an article and answering a question about it"
          />
        </div>
      </div>
    </section>
  );
}

/** The "Thinking…" indicator shown while the model processes, a pixel match of
    the real overlay's loading row (drawing LYKN outline spinner + shimmer text). */
function DemoThinking() {
  return (
    <div className="gl-demo-thinking">
      <svg
        className="gl-demo-spinner"
        viewBox={ICON_VIEWBOX}
        fill="none"
        role="img"
        aria-label="Thinking"
      >
        <path
          d={ICON_PATH}
          pathLength={1}
          fill="currentColor"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="gl-demo-thinking-text">Thinking…</span>
    </div>
  );
}

/** The LYKN mark, reused as the composer dot and the assistant avatar. */
function LyknMark({ className = "glo-dot" }: { className?: string }) {
  return (
    <svg className={className} viewBox={ICON_VIEWBOX} fill="none" aria-hidden="true">
      <path
        d={ICON_PATH}
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** The ⌘L demo overlay — a working glass panel that floats over the landing
    page (without dimming it), mirroring how the real LYKN Glass overlay appears
    on any screen. Streams real guest answers from the same backend the live app
    uses, then nudges toward sign-up once the message limit is reached.

    The budget is per-conversation and in-memory only (canned suggestion
    answers are free) — a reload starts fresh. Deliberate: a persistent
    tab-lifetime counter kept locking people out from stale counts, and the
    server's per-IP guest rate limits are the real abuse backstop. */
const DEMO_PROMPT_LIMIT = 10;

// Starter prompts shown in the demo's empty state (⌘L load-in) — click to send.
const DEMO_SUGGESTIONS = [
  "What is LYKN desktop?",
  "How does Mac sync work?",
  "What's on this page?",
];

// Follow-up prompts shown in the side panel after the first message — mirrors
// the way the real overlay surfaces follow-ups beside the answer.
const DEMO_FOLLOWUPS = [
  "How do you manage my projects?",
  "How does the calendar work?",
  "Does it sync with Finder?",
  "What models can I use?",
  "How do I get started?",
];

// Pre-written answers for the suggestion chips — clicking a suggestion types
// out its canned reply instantly instead of hitting the model, so the common
// demo paths stay cheap and fast. (Free-typed prompts still stream live.)
const DEMO_CANNED: Record<string, string> = {
  "What is LYKN desktop?":
    "LYKN desktop is Home on your Mac. The chat bar sits on your wallpaper, your apps live in a dock, and your real Desktop folder is already there. Chat, Build, Imagine, Research, Browser, and Drive all open from that same Home. Glass is still one shortcut away when you need me over another app.",
  "How does Mac sync work?":
    "Sync with Mac mirrors your real Desktop, folders, and wallpaper inside LYKN. Files you drop on Home land on disk. Finder files open in place, so you ask about a deck or a note without leaving the desktop. It's your Mac, already loaded.",
  "Does it sync with Finder?":
    "Yes. LYKN desktop can see your Desktop folder and the folders you grant. Drop a file on Home and it writes to disk. Open Files from the dock and you're browsing the same tree Finder uses.",
  "How does LYKN manage my projects?":
    "I can act as your project manager. Once you're signed in, I hold the full context of everything you're working on, track your projects and their tasks, know what's done and what's due, and push the next step forward, keeping every connected tool and model in sync. You could ask \"what's next on the launch?\" from Home and I'd just know.",
  "How do you manage my projects?":
    "Think of me as a project manager who never loses context. Once you're set up, I keep your projects and their tasks, know what's done and what's still open, surface what's due, and nudge the next step forward, from Home on your Mac. You stay in the work; I keep the plan moving.",
  "What's on this page?":
    `You're on the LYKN landing page. Up top is the floating nav: Features, Pricing, Security, News, and a Download pill. The hero reads "LYKN your AI desktop" and rotates three lines: The only AI workspace you need. Fully customizable. Ready to use by anyone for anything. Below that: a short explainer, a flip-through of Chat, Build, Imagine, and Research, five feature cards, Mac sync / customize / agents, and a download card for Mac.`,
  "How does the calendar work?":
    "Once you're set up, I manage your calendar right alongside your work. The calendar widget sits on Home, and I can schedule, reschedule, and flag conflicts so your time and your projects stay in sync.",
  "Can it see what's on my screen?":
    "In this demo, no, I'm not reading your real screen; I just know you're on the LYKN landing page. Download LYKN for Mac and Home shows your wallpaper, Desktop files, and widgets. Press " +
    HOTKEY +
    " and Glass can work with whatever app is in front of you.",
  "What models can I use?":
    "I run on one fast everyday model by default. On Pro you can switch to the frontier models, GPT, Claude, Gemini, and Grok, straight from the model menu. Whichever you pick, it's grounded in your context, so the answer is still personal to you.",
  "How do I get started?":
    "Download LYKN for Mac from this page, sign in, and open Home. Your Desktop syncs, the chat bar is in the middle, and I'm ready from the first ask.",
};

// Common words ignored when comparing two suggestions for similarity, so
// "How do you manage my projects?" and "How does LYKN manage my projects?"
// are treated as the same topic.
const SUGGESTION_STOPWORDS = new Set([
  "how", "do", "does", "did", "you", "your", "my", "me", "the", "a", "an", "is",
  "are", "can", "could", "would", "it", "to", "i", "on", "of", "what", "whats",
  "with", "lykn", "this", "that", "in", "for", "and", "about", "use", "using",
]);

function suggestionKeywords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !SUGGESTION_STOPWORDS.has(w));
}

/** True when two suggestions cover essentially the same topic, so a clicked
    one filters out closely matching ones (not just exact duplicates). */
function suggestionsSimilar(a: string, b: string): boolean {
  if (a === b) return true;
  const ka = new Set(suggestionKeywords(a));
  const kb = suggestionKeywords(b);
  if (ka.size === 0 || kb.length === 0) return false;
  const overlap = kb.filter((w) => ka.has(w)).length;
  return overlap / Math.min(ka.size, kb.length) >= 0.6;
}

function GlassDemoOverlay({
  open,
  onClose,
  onSignup,
  pageContext,
}: {
  open: boolean;
  onClose: () => void;
  onSignup: () => void;
  pageContext?: string;
}) {
  // `live` marks user prompts that hit the model (typed or non-canned
  // suggestions) — those are the ones that consume the demo budget.
  const [messages, setMessages] = useState<
    { role: "user" | "assistant"; text: string; live?: boolean }[]
  >([]);
  // Which turn (question + answer pair) is expanded. Mirrors the real
  // overlay's accordion: a new prompt collapses every prior turn to its
  // question header; clicking a header opens it and folds the others.
  const [openTurn, setOpenTurn] = useState<number | null>(null);
  // Clean-bar mode, like the real overlay's collapse-all: previous turns are
  // hidden entirely so only the newest prompt + answer shows.
  const [cleanMode, setCleanMode] = useState(false);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(true);
  const [sideOpen, setSideOpen] = useState(true);
  const [usedSuggestions, setUsedSuggestions] = useState<string[]>([]);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Derived straight from the visible conversation so it can never drift out
  // of sync with what the visitor sees: 10 live prompts in the thread = done.
  const liveCount = messages.filter((m) => m.role === "user" && m.live).length;
  const limitReached = liveCount >= DEMO_PROMPT_LIMIT;

  useEffect(() => {
    if (!open) return;
    // Reset any dragged offset so the panel always reopens on-screen.
    setPos({ x: 0, y: 0 });
    const t = window.setTimeout(() => inputRef.current?.focus(), 80);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  // Cancel any in-flight stream when the overlay closes.
  useEffect(() => {
    if (!open) {
      abortRef.current?.abort();
      abortRef.current = null;
      setTyping(false);
    }
  }, [open]);

  // Also cancel on unmount (e.g. navigating away with the overlay still
  // open) — the `open` effect above never fires in that case, so the stream
  // would keep running and call setState on an unmounted component.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Drag the panel by its titlebar, exactly like the real overlay. Movement is
  // clamped so the titlebar can never leave the viewport — an unbounded drag
  // let the panel disappear off-screen with no way to recover it.
  const startDrag = (e: ReactMouseEvent) => {
    e.preventDefault();
    const stageEl = (e.currentTarget as HTMLElement).closest<HTMLElement>(".gl-demo-stage");
    const rect0 = stageEl?.getBoundingClientRect() ?? null;
    const start = { x: e.clientX, y: e.clientY, baseX: pos.x, baseY: pos.y };
    const onMove = (ev: MouseEvent) => {
      let nx = start.baseX + (ev.clientX - start.x);
      let ny = start.baseY + (ev.clientY - start.y);
      if (rect0) {
        // Deltas from the drag-start rect that keep ≥80px of the panel's
        // width and the titlebar row inside the viewport.
        const dxMin = 80 - rect0.right;
        const dxMax = window.innerWidth - 80 - rect0.left;
        const dyMin = 8 - rect0.top;
        const dyMax = window.innerHeight - 48 - rect0.top;
        nx = Math.min(start.baseX + dxMax, Math.max(start.baseX + dxMin, nx));
        ny = Math.min(start.baseY + dyMax, Math.max(start.baseY + dyMin, ny));
      }
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, typing]);

  const send = async (preset?: string) => {
    const q = (typeof preset === "string" ? preset : input).trim();
    // Pre-loaded suggestion answers are typed out locally — they cost nothing,
    // so they don't count against the demo budget and still work at the limit.
    // Only live model prompts are gated.
    const canned = typeof preset === "string" ? DEMO_CANNED[preset] : undefined;
    if (!q || typing || (limitReached && !canned)) return;

    // Remember clicked suggestions so the same (or a closely matching) one is
    // dropped from later suggestion lists.
    if (typeof preset === "string") {
      setUsedSuggestions((u) => (u.includes(preset) ? u : [...u, preset]));
    }

    const history = messages.map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "model" | "user",
      content: m.text,
    }));

    setMessages((m) => [
      ...m,
      { role: "user", text: q, live: !canned },
      { role: "assistant", text: "" },
    ]);
    // Like the real overlay: a new prompt collapses every prior turn so only
    // the newest question + answer is expanded.
    setOpenTurn(messages.length / 2);
    setInput("");
    setTyping(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Cheap path: a clicked suggestion with a pre-written answer types out
    // locally instead of calling the model.
    if (canned) {
      // Brief "thinking" beat so the canned answer doesn't snap in instantly.
      await new Promise((r) => window.setTimeout(r, 500));
      if (controller.signal.aborted) {
        if (abortRef.current === controller) abortRef.current = null;
        setTyping(false);
        return;
      }
      await new Promise<void>((resolve) => {
        let i = 0;
        const id = window.setInterval(() => {
          if (controller.signal.aborted) {
            window.clearInterval(id);
            resolve();
            return;
          }
          i += 3;
          setMessages((m) => {
            const copy = m.slice();
            copy[copy.length - 1] = { role: "assistant", text: canned.slice(0, i) };
            return copy;
          });
          if (i >= canned.length) {
            window.clearInterval(id);
            resolve();
          }
        }, 16);
      });
      if (abortRef.current === controller) abortRef.current = null;
      setTyping(false);
      return;
    }

    try {
      await streamWakeChatPreview(
        q,
        history,
        (visible) => {
          setMessages((m) => {
            const copy = m.slice();
            copy[copy.length - 1] = { role: "assistant", text: visible };
            return copy;
          });
        },
        controller.signal,
        "glass-demo",
        pageContext,
      );
    } catch {
      if (!controller.signal.aborted) {
        setMessages((m) => {
          const copy = m.slice();
          copy[copy.length - 1] = { role: "assistant", text: AI_GUEST_TEMPORARY_FAILURE_TEXT };
          return copy;
        });
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setTyping(false);
    }
  };

  if (!open) return null;
  const isUnused = (q: string) =>
    !usedSuggestions.some((u) => suggestionsSimilar(u, q));
  const availableStarters = DEMO_SUGGESTIONS.filter(isUnused);
  // The side panel surfaces the starters the user DIDN'T pick first, then the
  // follow-ups — skipping anything already used or duplicated by topic.
  const sideSuggestions: string[] = [];
  for (const q of [...availableStarters, ...DEMO_FOLLOWUPS.filter(isUnused)]) {
    if (!sideSuggestions.some((o) => suggestionsSimilar(o, q))) {
      sideSuggestions.push(q);
    }
  }
  // The panel stays up (even at the message limit — canned suggestions still
  // work there) until the user closes it or every suggestion has been used.
  const showSide = messages.length > 0 && sideOpen && sideSuggestions.length > 0;
  return (
    <div className="gl-demo" role="dialog" aria-label="LYKN desktop demo">
      <div
        className="gl-demo-stage"
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      >
        <div className="glo-wrap gl-demo-panel">
          <div
            className="glo-titlebar gl-demo-titlebar"
            title="Drag to move"
            onMouseDown={startDrag}
          >
            <span className="glo-grip" />
            {/* Visible close — Escape was the only way out before, which
                left touch/mouse-only users stuck with the panel open. */}
            <button
              type="button"
              className="gl-demo-close"
              onClick={onClose}
              onMouseDown={(e) => e.stopPropagation()}
              aria-label="Close demo"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

        {messages.length > 0 ? (
          <div className="gl-demo-thread" ref={threadRef}>
            {/* Accordion of turns, like the real overlay: each question is a
                clickable header; only one answer is expanded at a time. In
                clean mode only the newest turn renders at all. */}
            {Array.from({ length: Math.ceil(messages.length / 2) }, (_, t) => {
              const turnCount = Math.ceil(messages.length / 2);
              if (cleanMode && t !== turnCount - 1) return null;
              const question = messages[t * 2];
              const answer = messages[t * 2 + 1];
              const isOpen = openTurn === t;
              return (
                <div
                  key={t}
                  className={`gl-demo-turn ${isOpen ? "" : "is-collapsed"}`}
                >
                  <button
                    type="button"
                    className="gl-demo-turn-q"
                    aria-expanded={isOpen}
                    onClick={() => setOpenTurn(isOpen ? null : t)}
                  >
                    <ChevronDown className="gl-demo-turn-chev" aria-hidden="true" />
                    <span className="gl-demo-turn-qtext">{question.text}</span>
                  </button>
                  {isOpen && answer ? (
                    <div className="gl-demo-turn-a">
                      {answer.text ? answer.text : <DemoThinking />}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : suggestOpen && availableStarters.length > 0 ? (
          <div className="gl-demo-suggest">
            <div className="gl-demo-suggest-head">
              <span className="gl-demo-suggest-label">Suggested</span>
              <button
                type="button"
                className="gl-demo-suggest-close"
                onClick={() => setSuggestOpen(false)}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label="Hide suggestions"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="gl-demo-suggest-col">
              {availableStarters.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="gl-demo-chip"
                  onClick={() => send(q)}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <span>{q}</span>
                  <span className="gl-demo-chip-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 17 17 7" />
                      <path d="M8 7h9v9" />
                    </svg>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="glo-composer">
          <div className="glo-field-row">
            <LyknMark />
            <textarea
              ref={inputRef}
              id="landing-demo-ask"
              name="landing-demo-ask"
              className="glo-ask"
              rows={1}
              placeholder={limitReached ? "Sign up to keep talking to LYKN" : "Ask LYKN anything…"}
              autoComplete="off"
              aria-label="Ask LYKN"
              value={input}
              disabled={limitReached}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
          </div>
          <GlassToolbar
            onSend={send}
            disabled={limitReached}
            collapseAll={{
              // Visible whenever there's history worth hiding (2+ turns) —
              // and always while clean mode is on, so it can be toggled off.
              show: cleanMode || messages.length >= 4,
              active: cleanMode,
              onToggle: () => {
                const on = !cleanMode;
                setCleanMode(on);
                // Entering clean mode opens just the newest turn, exactly
                // like the real overlay's clean bar.
                if (on) setOpenTurn(Math.ceil(messages.length / 2) - 1);
              },
            }}
          />
        </div>

          {limitReached ? (
            <div className="gl-demo-limit">
              <span>
                Sign up to keep talking to <LyknWordmark />, with your own
                context and every model.
              </span>
              <button
                type="button"
                className="gl-demo-cta"
                onClick={onSignup}
                aria-label="Get LYKN"
              >
                Get <LyknWordmark decorative />
              </button>
            </div>
          ) : null}
        </div>

        {showSide ? (
          <aside className="gl-demo-side">
            <div className="gl-demo-suggest-head">
              <span className="gl-demo-suggest-label">Suggested</span>
              <button
                type="button"
                className="gl-demo-suggest-close"
                onClick={() => setSideOpen(false)}
                onMouseDown={(e) => e.stopPropagation()}
                aria-label="Hide suggestions"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="gl-demo-suggest-col">
              {sideSuggestions.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="gl-demo-chip"
                  onClick={() => send(q)}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <span>{q}</span>
                  <span className="gl-demo-chip-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 17 17 7" />
                      <path d="M8 7h9v9" />
                    </svg>
                  </span>
                </button>
              ))}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** "Latest news" — a row of article tiles, each linking to its full post. */
function NewsSection() {
  const navigate = useNavigate();
  return (
    <section className="gl-news" id="news" aria-label="Latest news">
      <div className="gl-news-inner">
        <div className="gl-news-head gl-reveal">
          <h2 className="gl-news-title">Latest news</h2>
          <button
            type="button"
            className="gl-news-all"
            onClick={() => navigate("/news")}
          >
            All posts
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div className="gl-news-grid gl-reveal">
          {NEWS_POSTS.map((post) => (
            <Link
              to={`/news/${post.slug}`}
              className="gl-news-card"
              key={post.slug}
            >
              <div
                className="gl-news-tile"
                style={{ backgroundImage: `url(${post.art})` }}
              >
                <span
                  className={`gl-news-tag${post.lightArt ? " gl-news-tag--dark" : ""}`}
                >
                  {post.tag}
                </span>
              </div>
              <p className="gl-news-date">{post.date}</p>
              <h3 className="gl-news-headline">{post.title}</h3>
            </Link>
          ))}
        </div>
        <hr className="gl-news-divider" />
      </div>
    </section>
  );
}

// Frequently asked questions shown in the accordion.
const FAQS: { q: string; a: string }[] = [
  {
    q: "What is LYKN?",
    a: "LYKN desktop is an AI workspace for your Mac. It remembers who you are, holds the context of your projects, and keeps your Desktop, files, and chat in one Home.",
  },
  {
    q: "Does it work with the apps and models I already use?",
    a: "Yes. Sync with Mac brings Finder files and your wallpaper onto Home, and you can switch between GPT, Claude, Gemini and Grok from the model menu. Whichever model you pick is grounded in the same understanding of you.",
  },
  {
    q: "How does LYKN sync with my Mac?",
    a: "LYKN can mirror your real Desktop folder, the folders you grant, and your wallpaper. Files you drop on Home land on disk. The dock can also launch Mac apps you already use.",
  },
  {
    q: "Can LYKN actually run my projects?",
    a: "It tracks your tasks, owns the calendar, and works a queue overnight, acting like a project manager that keeps every connected AI in sync and pushes your work forward.",
  },
  {
    q: "Is my data private?",
    a: "Your context is yours. You can see exactly what LYKN knows about you, edit it, and steer it at any time from your intelligence layer.",
  },
  {
    q: "Which platforms is LYKN desktop available on?",
    a: `LYKN desktop is the Mac app. Home is where you chat, open files, and keep widgets. Glass is still one shortcut away (${desktopHotkeyLabel("spaced")}) when you need LYKN over another app.`,
  },
];

/** FAQ accordion — one panel open at a time, with a smooth grid-rows expand
    and a rotating chevron. */
function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className="gl-faq" id="faq">
      <div className="gl-faq-inner">
        <h2 className="gl-faq-title gl-reveal">Questions, answered</h2>
        <div className="gl-faq-list">
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <div
                key={f.q}
                className={`gl-faq-item ${isOpen ? "is-open" : ""}`}
              >
                <button
                  type="button"
                  className="gl-faq-q"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : i)}
                >
                  <span>{markLykn(f.q)}</span>
                  <ChevronDown className="gl-faq-chevron" aria-hidden="true" />
                </button>
                <div className="gl-faq-a-wrap">
                  <div className="gl-faq-a-inner">
                    <p className="gl-faq-a">{markLykn(f.a)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** The Apple logo glyph for the download button. */
// The two ways in, shown as dark side-by-side cards under the FAQ.
const START_OPTIONS: {
  title: string;
  sub: string;
  points: string[];
  cta: string;
  to: string;
  solid?: boolean;
}[] = [
  {
    title: "Download LYKN desktop",
    sub: "The Mac app - Home, the chat bar, and your files already in sync.",
    points: [
      "Home - wallpaper, widgets, and the chat bar in the middle",
      "Sync with Mac - Desktop folder, Finder files, and wallpaper",
      "Chat - ask anything with your context already loaded",
      "Build - turn a sentence into working software",
      "Imagine - on-brand images, ads, and art from a prompt",
      "Voice - real-time conversation, hands-free",
      "Research - deep digs into sources, structured as a report",
      "Browser - an agent that browses and acts on the web for you",
      `Glass - still one shortcut away with ${HOTKEY_SPACED}`,
    ],
    cta: "Download for Mac",
    to: "/download",
    solid: true,
  },
];

/** Download CTA above the footer — desktop app is the product entry. */
function GetStartedSection() {
  const navigate = useNavigate();
  return (
    <section className="gl-start" id="download">
      <div className="gl-start-inner">
        <h2 className="gl-start-title gl-reveal">
          Get{"\u00A0"}
          <LyknWordmark /> desktop for Mac
        </h2>
        <div className="gl-start-grid gl-start-grid--single gl-reveal">
          {START_OPTIONS.map((opt) => (
            <article className="gl-start-card" key={opt.title}>
              <h3 className="gl-start-card-title">{markLykn(opt.title)}</h3>
              <p className="gl-start-card-sub">{opt.sub}</p>
              <ul className="gl-start-list">
                {opt.points.map((point) => (
                  <li key={point}>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {point}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={`gl-start-btn ${
                  opt.solid ? "gl-start-btn--solid" : "gl-start-btn--ghost"
                }`}
                onClick={() => navigate(opt.to)}
              >
                {opt.cta}
              </button>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

// Footer nav. Each link either routes to a page (`to`) or smooth-scrolls to an
// in-page section (`scroll`; "top" jumps to the hero).
type FooterLink = { label: string; to?: string; scroll?: string };
const FOOTER_COLS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Desktop", scroll: "top" },
      { label: "Capabilities", scroll: "capabilities" },
    ],
  },
  {
    title: "Explore",
    links: [
      { label: "Templates", to: "/templates" },
      { label: "Pricing", to: "/pricing" },
      { label: "Security", to: "/security" },
      { label: "Download", scroll: "download" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy", to: "/privacy" },
      { label: "Terms", to: "/terms" },
      { label: "Cookies", to: "/cookies" },
    ],
  },
];

/** Site footer — brand, routed nav columns, and a bottom copyright row.
    Exported so sibling landing pages can share the exact same footer. */
export function SiteFooter() {
  const navigate = useNavigate();
  const go = (link: FooterLink) => {
    if (link.to) {
      navigate(link.to);
      return;
    }
    if (link.scroll === "top") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (link.scroll) {
      const el = document.getElementById(link.scroll);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        // On pages without the section, head home instead.
        navigate("/");
      }
    }
  };
  return (
    <footer className="gl-footer">
      <div className="gl-footer-inner">
        <div className="gl-footer-brand">
          <span
            className="gl-footer-logo"
            role="img"
            aria-label="LYKN"
            style={{ ["--gl-footer-mark" as string]: `url("${lyknLogoMark}")` }}
          />
          <p className="gl-footer-tagline">
            Your Mac, already in sync.
          </p>
        </div>
        <nav className="gl-footer-cols" aria-label="Footer">
          {FOOTER_COLS.map((col) => (
            <div className="gl-footer-col" key={col.title}>
              <h4 className="gl-footer-col-title">{col.title}</h4>
              {col.links.map((link) => (
                <button
                  type="button"
                  key={link.label}
                  className="gl-footer-link"
                  onClick={() => go(link)}
                >
                  {link.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </div>
      <div className="gl-footer-bottom">
        <span>
          © {new Date().getFullYear()} <LyknWordmark />. All rights reserved.
        </span>
        <span className="gl-footer-shortcut">
          <LyknWordmark decorative /> desktop for Mac ·{" "}
          <kbd>{desktopModifierKey()}</kbd> <kbd>L</kbd>
        </span>
      </div>
    </footer>
  );
}

const GlassLanding = () => {
  const navigate = useNavigate();

  // The header keeps its solid (dark links + blue logo) treatment at all
  // times — no scroll-driven swap. It reads cleanly over the white hero.

  // Reveal-on-scroll: fade + lift elements tagged .gl-reveal as they enter.
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".gl-reveal");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -10% 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const goToSignup = () => navigate("/download");

  useLandingLightTheme();

  // Progressive top blur: once the page starts scrolling, a fixed frosted
  // band under the header blurs whatever slides beneath the viewport top.
  const [topBlur, setTopBlur] = useState(false);
  useEffect(() => {
    const onScroll = () => setTopBlur(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ⌘L (or Ctrl+L) summons the live LYKN overlay demo over the landing page,
  // the same shortcut that pulls up the real Glass overlay on any screen.
  const [demoOpen, setDemoOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "l" || e.key === "L")) {
        e.preventDefault();
        setDemoOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Snapshot the full landing-page text so the ⌘L demo overlay can answer
  // questions about the page from the real, current content. Captured after the
  // first paint (overlay is closed, so its own text isn't included), then
  // refreshed whenever the overlay is opened in case the page has changed.
  const [pageContext, setPageContext] = useState("");
  const capturePageContext = () => {
    try {
      // Capture the header, main, and footer specifically so the floating
      // overlay (a sibling .gl-demo node) and its chat thread never leak into
      // the page snapshot.
      const sel = ".glass-land > header, .glass-land > main, .glass-land > footer";
      const parts = Array.from(document.querySelectorAll<HTMLElement>(sel)).map(
        (el) => el.innerText || "",
      );
      const text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
      if (text) setPageContext(text);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    capturePageContext();
  }, []);
  useEffect(() => {
    if (demoOpen) capturePageContext();
  }, [demoOpen]);

  return (
    <div className="glass-land">
      <LandingHeader
        onBrandClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      />

      <div
        className={`gl-top-blur${topBlur ? " is-on" : ""}`}
        aria-hidden="true"
      />

      <main>
        <LandingHero />
        <LandingExplain />
        <LandingCapabilities />
        <LandingSlideshow />
        <LandingModelsTools />
        <AnyScreenSection />
        <GetStartedSection />
      </main>

      <SiteFooter />
      <GlassDemoOverlay
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        onSignup={goToSignup}
        pageContext={pageContext}
      />
    </div>
  );
};

export default GlassLanding;
