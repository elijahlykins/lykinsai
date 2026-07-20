import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  FolderKanban,
  ListTodo,
  CalendarClock,
  CalendarPlus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Moon,
  Flag,
  ChevronDown,
} from "lucide-react";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import lyknWordmark from "@/assets/FINAL/LYKN-WORDMARK/SVG/LYKN-Wordmark-BLUE.svg";
import glassAdDemo from "@/assets/glass-ad-demo.png";
import { NEWS_POSTS } from "@/lib/newsPosts";
import LandingHeader from "@/components/landing/LandingHeader";
import GlassBackdrop from "@/components/landing/GlassBackdrop";
// Rotation locked to the clouds scene for now — restore these imports (and
// the HERO_BACKGROUNDS entries) to bring the full rotation back.
// import heroMountains from "@/assets/hero-mountains.png";
// import heroOcean from "@/assets/hero-ocean.jpg";
// import heroDunes from "@/assets/hero-dunes.jpg";
// import heroLake from "@/assets/hero-lake.jpg";
// import heroClouds from "@/assets/hero-clouds.jpg";
// AI-generated image pool for the Imagine card's rotating collage.
import imagineSneaker from "@/assets/imagine-sneaker.png";
import imaginePorsche from "@/assets/imagine-porsche-gt3.png";
import imagineMeadow from "@/assets/imagine-meadow.png";
import imagineClouds from "@/assets/imagine-clouds.png";
import imaginePastel from "@/assets/imagine-pastel.png";
import imagineCube from "@/assets/imagine-cube.png";
import imagineHeadphones from "@/assets/imagine-headphones.png";
import imagineHovercraft from "@/assets/imagine-hovercraft.png";
import imagineFigure from "@/assets/imagine-figure.png";
import VoiceTechOrb from "@/components/lyknChat/VoiceTechOrb";
import { streamWakeChatPreview } from "@/lib/wake/wakeChatPreviewStream";
import { AI_GUEST_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import "./GlassLanding.css";

// The production marketing landing page, focused on LYKN Glass (the desktop
// overlay). Served at "/", "/landing", and "/glass". Uses the shared
// LandingHeader locked to its transparent treatment (white logo + links,
// never changes on scroll) routing to Pricing / Download / Login.

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

// Conversation shown in the capabilities Chat card — LYKN acting as the
// project-aware assistant, mirroring the real overlay chat. Played back one
// bubble at a time on a loop (see CapChatDemo).
const CAP_CHAT: { role: "user" | "lykn"; text: string }[] = [
  { role: "user", text: "What's next on the launch?" },
  {
    role: "lykn",
    text: "Finalize the pricing page, it's due today. I drafted a version this morning; want me to open it?",
  },
  { role: "user", text: "Schedule a review for Friday" },
  {
    role: "lykn",
    text: "Done. Friday, 2:00 pm with the design team, added to the Q3 launch calendar.",
  },
  { role: "user", text: "Draft the launch email too" },
  {
    role: "lykn",
    text: "Drafted and saved to the project with the subject line \u201cMeet the new LYKN.\u201d Want me to queue it for Monday?",
  },
  { role: "user", text: "Yes, and remind me before it sends" },
  {
    role: "lykn",
    text: "Queued for Monday 9:00 am, with a reminder 30 minutes before. I'll keep the launch board updated.",
  },
];

/** The Chat card's looping conversation: once the card scrolls into view,
    bubbles land one at a time and push the earlier ones up (clipped and faded
    at the top), then the loop restarts after a beat. Under reduced motion the
    conversation just renders whole. */
export function CapChatDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const [count, setCount] = useState(1);
  // Bumped each loop so bubble keys change and entrance animations replay.
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(CAP_CHAT.length);
      return;
    }
    const atEnd = count >= CAP_CHAT.length;
    // LYKN replies take a beat longer (they're "typed"); the full thread
    // holds on screen before the loop restarts.
    const delay = atEnd
      ? 3600
      : CAP_CHAT[count].role === "lykn"
        ? 1700
        : 1250;
    const t = window.setTimeout(() => {
      if (atEnd) {
        setCycle((c) => c + 1);
        setCount(1);
      } else {
        setCount((c) => c + 1);
      }
    }, delay);
    return () => window.clearTimeout(t);
  }, [seen, count]);

  return (
    <div className="gl-cap-chat" ref={ref} aria-hidden="true">
      {CAP_CHAT.slice(0, count).map((m, i) => (
        <div
          key={`${cycle}-${i}`}
          className={`gl-cap-bubble ${
            m.role === "user" ? "gl-cap-bubble--user" : "gl-cap-bubble--lykn"
          }`}
        >
          {m.role === "lykn" ? (
            <LyknMark className="gl-cap-bubble-mark" />
          ) : null}
          <span>{m.text}</span>
        </div>
      ))}
    </div>
  );
}

// Code shown in the Build card — LYKN writing out an app in build mode,
// typed character by character on a loop (see CapBuildDemo).
const CAP_CODE = [
  'export const Dashboard = () => {',
  '  const { metrics } = useReport("q3");',
  '',
  '  return (',
  '    <Board theme="glass">',
  '      <Stat label="Revenue" value={metrics.mrr} />',
  '      <Stat label="Active users" value={metrics.dau} />',
  '      <Chart series={metrics.trend} />',
  '      <Gantt rows={metrics.projects} />',
  '    </Board>',
  '  );',
  '};',
];
const CAP_CODE_STARTS = CAP_CODE.reduce<number[]>((acc, line, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + Math.max(1, CAP_CODE[i - 1].length));
  return acc;
}, []);
const CAP_CODE_TOTAL =
  CAP_CODE_STARTS[CAP_CODE.length - 1] + CAP_CODE[CAP_CODE.length - 1].length;

// Minimal syntax tint for the Build card: strings green, keywords violet.
const CAP_CODE_KEYWORDS = /^(export|const|return)$/;
function CapCodeLine({ text }: { text: string }) {
  return (
    <>
      {text.split(/("[^"]*"?)/).map((seg, i) =>
        seg.startsWith('"') ? (
          <span key={i} className="gl-cap-code-str">
            {seg}
          </span>
        ) : (
          <span key={i}>
            {seg.split(/(\s+)/).map((word, j) =>
              CAP_CODE_KEYWORDS.test(word) ? (
                <span key={j} className="gl-cap-code-kw">
                  {word}
                </span>
              ) : (
                <span key={j}>{word}</span>
              )
            )}
          </span>
        )
      )}
    </>
  );
}

/** The Build card: LYKN writing code on black. Once in view the snippet types
    out character by character with a caret, holds, and loops. Under reduced
    motion the snippet renders whole. */
export function CapBuildDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const [chars, setChars] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setChars(CAP_CODE_TOTAL);
      return;
    }
    if (chars >= CAP_CODE_TOTAL) {
      const t = window.setTimeout(() => setChars(0), 3200);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(
      () => setChars((c) => Math.min(CAP_CODE_TOTAL, c + 2)),
      36
    );
    return () => window.clearTimeout(t);
  }, [seen, chars]);

  return (
    <div className="gl-cap-code" ref={ref} aria-hidden="true">
      <div className="gl-cap-code-head">
        <span className="gl-cap-code-dot" data-tint="r" />
        <span className="gl-cap-code-dot" data-tint="y" />
        <span className="gl-cap-code-dot" data-tint="g" />
        <span className="gl-cap-code-file">Dashboard.tsx</span>
        <span className="gl-cap-code-mode">LYKN · Build mode</span>
      </div>
      <pre className="gl-cap-code-body">
        {CAP_CODE.map((line, i) => {
          if (chars < CAP_CODE_STARTS[i]) return null;
          const visible = Math.max(
            0,
            Math.min(line.length, chars - CAP_CODE_STARTS[i])
          );
          const isActive =
            chars < CAP_CODE_TOTAL
              ? chars >= CAP_CODE_STARTS[i] &&
                chars < CAP_CODE_STARTS[i] + Math.max(1, line.length)
              : i === CAP_CODE.length - 1;
          return (
            <div className="gl-cap-code-line" key={i}>
              <span className="gl-cap-code-num">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span>
                <CapCodeLine text={line.slice(0, visible)} />
                {isActive ? <span className="gl-cap-code-caret" /> : null}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

// Ordered so no two adjacent images share a palette — since the three slots
// show consecutive pool entries, each swap keeps the collage varied.
const CAP_IMAGES = [
  imagineSneaker,
  imaginePorsche,
  imagineFigure,
  imagineHovercraft,
  imagineMeadow,
  imagineHeadphones,
  imagineClouds,
  imaginePastel,
  imagineCube,
];

/** One collage slot: every pool image stays mounted, stacked, and the active
    one fades in over the rest — a clean crossfade with no unmount flash. */
function CapImgSlot({
  active,
  delayMs = 0,
  className = "",
}: {
  active: number;
  delayMs?: number;
  className?: string;
}) {
  return (
    <div className={`gl-cap-img ${className}`.trim()}>
      {CAP_IMAGES.map((src, i) => (
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          className={i === active ? "is-on" : ""}
          style={{ transitionDelay: `${delayMs}ms` }}
        />
      ))}
    </div>
  );
}

/** The Imagine card: a rotating collage of generated images — one big slot
    and two small stacked ones. Each swap advances past ALL three visible
    images, so the whole collage rotates out to fresh images every cycle
    (nothing migrates from a small slot to the big one), crossfading with a
    slight stagger. */
export function CapImagineDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setTick((t) => t + 3), 3400);
    return () => window.clearInterval(id);
  }, [seen]);

  const n = CAP_IMAGES.length;
  return (
    <div className="gl-cap-imagine" ref={ref} aria-hidden="true">
      <CapImgSlot className="gl-cap-img--big" active={tick % n} />
      <div className="gl-cap-img-col">
        <CapImgSlot active={(tick + 1) % n} delayMs={140} />
        <CapImgSlot active={(tick + 2) % n} delayMs={280} />
      </div>
    </div>
  );
}

/** The Voice card: just the Voice Mode orb bobbing on the dark card — no
    status script (Connecting/Listening/Speaking), no copy. A breathing mic
    level keeps the dot sphere gently pulsing while the card is in view. */
export function CapVoiceDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const [micLevel, setMicLevel] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      setMicLevel(0.35 + Math.abs(Math.sin(t * 1.4)) * 0.4);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen]);

  return (
    <div className="gl-cap-voice dark" ref={ref} aria-hidden="true">
      <VoiceTechOrb
        state="listening"
        micLevel={micLevel}
        size={210}
        appearance="dark"
      />
    </div>
  );
}

/** Bottom row shared by every capability card: the surface name on the left
    and an "Explore" link on the right, sitting over a legibility gradient. */
function CapFoot({ name, onExplore }: { name: string; onExplore: () => void }) {
  return (
    <div className="gl-cap-foot">
      <span className="gl-cap-name">{name}</span>
      <button type="button" className="gl-cap-explore" onClick={onExplore}>
        Explore <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}

/** Capabilities grid directly under the hero: centered headline + CTAs over a
    2×2 grid of dark cards — Chat (LYKN answering), Build (build mode running),
    Imagine (image generation), and Voice (the voice orb). Each card's Explore
    link opens that capability's own product page. */
function CapabilitiesSection() {
  const navigate = useNavigate();
  return (
    <section className="gl-cap" id="capabilities">
      <div className="gl-cap-inner">
        <h2 className="gl-cap-title gl-reveal">
          AI anywhere you <span className="gl-cap-underline">need</span>.
        </h2>

        <div className="gl-cap-grid gl-reveal">
          <article className="gl-cap-card">
            <CapChatDemo />
            <CapFoot name="Chat" onExplore={() => navigate("/product/chat")} />
          </article>

          <article className="gl-cap-card">
            <CapBuildDemo />
            <CapFoot name="Build" onExplore={() => navigate("/product/build")} />
          </article>

          <article className="gl-cap-card">
            <CapImagineDemo />
            <CapFoot
              name="Imagine"
              onExplore={() => navigate("/product/imagine")}
            />
          </article>

          <article className="gl-cap-card">
            <CapVoiceDemo />
            <CapFoot name="Voice" onExplore={() => navigate("/product/voice")} />
          </article>
        </div>
      </div>
    </section>
  );
}

/** LYKN Glass explainer (reference: "One API. Every modality."): split
    layout on a white stage — two-line headline, supporting copy,
    CTA pills, and proof stats on the left; a mac-style window playing the
    real snip demo with little step chips on the right. */
function AnyScreenSection() {
  const navigate = useNavigate();
  const scrollTo = (id: string) =>
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <section className="gl-any" id="about">
      <div className="gl-any-inner">
        <div className="gl-any-copy">
          <h2 className="gl-any-title gl-reveal">
            One shortcut.
            <br />
            <span className="gl-any-title-dim">Every screen.</span>
          </h2>
          <p className="gl-any-sub gl-reveal">
            Press ⌘L and LYKN Glass appears over whatever you're working on.
            It reads the page, snips the part you care about, and acts on it,
            with your projects and context already loaded.
          </p>
          <div className="gl-any-actions gl-reveal">
            <button
              type="button"
              className="gl-any-btn gl-any-btn--primary"
              onClick={() => navigate("/login")}
            >
              Try LYKN
            </button>
            <button
              type="button"
              className="gl-any-btn gl-any-btn--ghost"
              onClick={() => scrollTo("download")}
            >
              Download
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
          <img
            className="gl-any-shot"
            src={glassAdDemo}
            alt="LYKN Glass floating over a moodboard, rebranding a product ad on request"
            draggable={false}
          />
          {/* Product-page shortcuts under the window: each chip jumps to
              that capability's page. */}
          <div className="gl-any-chips">
            {(["chat", "build", "imagine", "voice"] as const).map((id) => (
              <button
                key={id}
                type="button"
                className="gl-any-chip"
                onClick={() => navigate(`/product/${id}`)}
              >
                {id.charAt(0).toUpperCase() + id.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Big showcase card under the Glass explainer: the Remotion snip animation
    (the glass bar over an article, the snip tool dragging a selection, and
    the AI answering about it) framed in one wide card. */
function SnipShowcaseSection() {
  return (
    <section className="gl-snip" aria-label="LYKN Glass snip demo">
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
            aria-label="LYKN Glass snipping a section of an article and answering a question about it"
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
  "What is LYKN Glass?",
  "How does LYKN manage my projects?",
  "What's on this page?",
];

// Follow-up prompts shown in the side panel after the first message — mirrors
// the way the real overlay surfaces follow-ups beside the answer.
const DEMO_FOLLOWUPS = [
  "How do you manage my projects?",
  "How does the calendar work?",
  "Can it see what's on my screen?",
  "What models can I use?",
  "How do I get started?",
];

// Pre-written answers for the suggestion chips — clicking a suggestion types
// out its canned reply instantly instead of hitting the model, so the common
// demo paths stay cheap and fast. (Free-typed prompts still stream live.)
const DEMO_CANNED: Record<string, string> = {
  "What is LYKN Glass?":
    "LYKN Glass is me, on top of every screen you work on. Press ⌘L over any app, doc, or browser and I appear as a floating glass bar. Once you're set up, I show up already knowing who you are and what you're working on. I can read what's on your screen when you ask, answer it, and take action, then get out of your way. It's the same overlay you're using right now.",
  "How does LYKN manage my projects?":
    "I can act as your project manager. Once you're signed in, I hold the full context of everything you're working on, track your projects and their tasks, know what's done and what's due, and push the next step forward, keeping every connected tool and model in sync. You could ask \"what's next on the launch?\" from any screen and I'd just know.",
  "How do you manage my projects?":
    "Think of me as a project manager who never loses context. Once you're set up, I keep your projects and their tasks, know what's done and what's still open, surface what's due, and nudge the next step forward, from whatever screen you're on. You stay in the work; I keep the plan moving.",
  "What's on this page?":
    "You're on the LYKN landing page. Up top is the nav: Product, Pricing, Download. The hero reads \"Welcome to LYKN studio\" with the ⌘ keycap you used to open me. Below that: how I show up on any screen, an \"AI project manager\" section with live project and calendar UI, a Latest news strip, an FAQ, and a \"Put LYKN on your Mac\" download section.",
  "How does the calendar work?":
    "Once you're set up, I manage your calendar right alongside your work. I'll know what's coming up, can schedule and reschedule, flag conflicts, and tie events back to the project they belong to, so your time and your projects stay in sync instead of living in separate apps.",
  "Can it see what's on my screen?":
    "In this demo, no, I'm not reading your real screen; I just know you're on the LYKN landing page. But download LYKN and yes: the installed overlay reads whatever's actually on your screen and works with it, right where you are.",
  "What models can I use?":
    "I run on one fast everyday model by default. On Pro you can switch to the frontier models, GPT, Claude, Gemini, and Grok, straight from the model menu. Whichever you pick, it's grounded in your context, so the answer is still personal to you.",
  "How do I get started?":
    "Download LYKN for Mac from the button on this page, sign in, and press ⌘L anywhere. From there I start learning who you are and how you work, and I'm one shortcut away on every screen you're on.",
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
    <div className="gl-demo" role="dialog" aria-label="LYKN Glass demo">
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
              <span>Sign up to keep talking to LYKN, with your own context and every model.</span>
              <button type="button" className="gl-demo-cta" onClick={onSignup}>
                Get LYKN
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

/** Fixed bottom-right shortcut hint — two neumorphic keycaps (⌘ + ↵) that
    drop in with a bounce and lift on hover. Clicking summons the demo. */
function KeycapCTA({ onTrigger }: { onTrigger?: () => void }) {
  return (
    <div className="gl-cta" aria-label="AI on any screen at the click of a button">
      <div className="gl-keys">
        <span className="gl-cta-text" role="tooltip">
          AI on any screen at the click of a button
        </span>
        <button
          type="button"
          className="gl-key gl-key--cmd"
          aria-label="Command"
          onClick={onTrigger}
        >
          <span>⌘</span>
        </button>
        <button
          type="button"
          className="gl-key gl-key--ret"
          aria-label="Open LYKN demo"
          onClick={onTrigger}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 4v9a5 5 0 0 0 5 5" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** Fires once when the element scrolls into view; drives lazy-mounting +
    `active` quality gating for the heavy product previews. */
function useSeen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.2, rootMargin: "0px 0px -10% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return { ref, seen };
}

/** Counts from 0 → `to` once the element scrolls into view, then stops. Used
    for the project dashboard stat tiles so the numbers tick up on reveal. */
function CountUp({ to, duration = 1100 }: { to: number; duration?: number }) {
  const { ref, seen } = useSeen<HTMLSpanElement>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!seen) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      // easeOutCubic for a snappy settle
      const eased = 1 - Math.pow(1 - t, 3);
      setN(Math.round(eased * to));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, to, duration]);
  return (
    <span ref={ref} className="tabular-nums">
      {n}
    </span>
  );
}

/** A dashboard stat tile, faithful to ProjectDetailPage's StatTile but
    light-theme only + an animated count-up value. */
function PmStat({
  icon: Icon,
  label,
  value,
  tone = "default",
}: {
  icon: typeof ListTodo;
  label: string;
  value: number;
  tone?: "default" | "danger" | "accent";
}) {
  const toneCls =
    tone === "danger"
      ? "text-red-600"
      : tone === "accent"
        ? "text-blue-600"
        : "text-slate-900";
  return (
    <div className="rounded-2xl border border-black/[0.05] bg-white px-4 py-3 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-1.5 text-slate-400">
        <Icon className="w-3.5 h-3.5" />
        <span className="text-[0.625rem] font-semibold uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className={`mt-1 text-2xl font-semibold ${toneCls}`}>
        <CountUp to={value} />
      </div>
    </div>
  );
}

const PM_WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

/** A live month calendar replicating ProjectDetailPage's MonthCalendar: real
    current month, today highlighted, and event/deadline dots that gently
    pulse. Marks are placed relative to today so the demo always looks full. */
function PmCalendar() {
  const { cells, monthLabel, todayDate, daysInMonth } = (() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const dim = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();
    const out: { day: number; muted: boolean; inMonth: boolean }[] = [];
    for (let i = firstWeekday - 1; i >= 0; i--)
      out.push({ day: prevMonthDays - i, muted: true, inMonth: false });
    for (let d = 1; d <= dim; d++)
      out.push({ day: d, muted: false, inMonth: true });
    let trail = 1;
    while (out.length % 7 !== 0 || out.length < 42) {
      out.push({ day: trail, muted: true, inMonth: false });
      trail += 1;
      if (out.length >= 42) break;
    }
    return {
      cells: out,
      monthLabel: now.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      }),
      todayDate: now.getDate(),
      daysInMonth: dim,
    };
  })();

  // Days carrying a marker, relative to today so the grid always reads as busy.
  const events = new Set(
    [todayDate, todayDate + 2, todayDate + 9].filter((d) => d <= daysInMonth),
  );
  const deadlines = new Set(
    [todayDate, todayDate + 5].filter((d) => d <= daysInMonth),
  );
  const selected = todayDate + 2 <= daysInMonth ? todayDate + 2 : null;

  return (
    <div className="rounded-[1.5rem] border border-black/[0.05] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold tracking-tight text-slate-900">
          {monthLabel}
        </h3>
        <div className="flex items-center gap-1 text-slate-400">
          <span className="w-7 h-7 inline-flex items-center justify-center rounded-full hover:bg-black/[0.05]">
            <ChevronLeft className="w-4 h-4" />
          </span>
          <span className="text-[0.6875rem] px-2 py-1 rounded-full text-slate-500">
            Today
          </span>
          <span className="w-7 h-7 inline-flex items-center justify-center rounded-full hover:bg-black/[0.05]">
            <ChevronRight className="w-4 h-4" />
          </span>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-y-1 text-center">
        {PM_WEEKDAYS.map((w, i) => (
          <div
            key={i}
            className="text-[0.625rem] font-medium tracking-wide text-slate-300 pb-1"
          >
            {w}
          </div>
        ))}
        {cells.map((cell, i) => {
          const isToday = cell.inMonth && cell.day === todayDate;
          const isSelected = cell.inMonth && cell.day === selected;
          const hasEvent = cell.inMonth && events.has(cell.day);
          const hasTask = cell.inMonth && deadlines.has(cell.day);
          return (
            <div key={i} className="flex items-center justify-center py-0.5">
              <span
                className={`relative w-8 h-8 inline-flex items-center justify-center rounded-full text-[0.8125rem] ${
                  isToday
                    ? "bg-slate-900 text-white font-semibold gl-pm-today"
                    : isSelected
                      ? "bg-blue-500/15 text-blue-600 font-medium"
                      : cell.muted
                        ? "text-slate-300"
                        : "text-slate-600"
                }`}
              >
                {cell.day}
                {(hasEvent || hasTask) && (
                  <span className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-0.5">
                    {hasEvent && (
                      <span
                        className={`gl-pm-dot w-1 h-1 rounded-full ${
                          isToday ? "bg-white/90" : "bg-blue-500"
                        }`}
                      />
                    )}
                    {hasTask && (
                      <span
                        className={`gl-pm-dot w-1 h-1 rounded-full ${
                          isToday ? "bg-white/90" : "bg-teal-500"
                        }`}
                        style={{ animationDelay: "0.6s" }}
                      />
                    )}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-center justify-center gap-4 text-[0.625rem] text-slate-400">
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-blue-500" /> Events
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-teal-500" /> Deadlines
        </span>
      </div>
    </div>
  );
}

// Tasks for the demo todo list. The first auto-checks on a loop (LYKN working
// through them); the rest carry priority dots + deadline pills.
const PM_TASKS: {
  title: string;
  done?: boolean;
  auto?: boolean;
  priority?: "high" | "normal";
  due?: string;
  overdue?: boolean;
}[] = [
  { title: "Finalize pricing page", auto: true, due: "TODAY", overdue: true },
  { title: "Brief the design team", done: true },
  { title: "Draft the launch email", priority: "high", due: "JUN 30" },
  { title: "Review competitor teardown", due: "JUL 02" },
];

function PmTasks() {
  return (
    <div className="rounded-[1.5rem] border border-black/[0.05] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold tracking-tight text-slate-900">
          Todo list
        </h3>
        <span className="text-[0.6875rem] text-slate-400">3 open</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[0.6875rem] font-medium px-2.5 py-1 rounded-full bg-slate-900 text-white">
          Add new
        </span>
      </div>

      <div className="flex flex-col">
        {PM_TASKS.map((t) => (
          <div
            key={t.title}
            className="group flex items-center gap-2.5 px-2 py-2 rounded-2xl hover:bg-black/[0.03]"
          >
            <span
              className={`gl-pm-cb ${t.auto ? "gl-pm-cb--auto" : ""} ${
                t.done ? "gl-pm-cb--done" : ""
              }`}
            />
            {t.priority === "high" && !t.done ? (
              <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-red-500" />
            ) : null}
            <div className="min-w-0 flex-1">
              <span
                className={`gl-pm-tasklabel text-sm leading-snug ${
                  t.auto ? "gl-pm-tasklabel--auto" : ""
                } ${t.done ? "gl-pm-tasklabel--done" : "text-slate-800"}`}
              >
                {t.title}
              </span>
            </div>
            {t.due && (
              <span
                className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold tracking-wide ${
                  t.overdue
                    ? "bg-red-500/10 text-red-600"
                    : "bg-amber-500/10 text-amber-600"
                }`}
              >
                {t.due}
              </span>
            )}
            <Flag className="w-3.5 h-3.5 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        ))}
      </div>
    </div>
  );
}

// Night Shift kanban — a compact 3-column board. One "Ready" card is freshly
// expanded by LYKN overnight and animates in with a glow.
const PM_KANBAN: {
  col: string;
  cards: { title: string; tag?: string; fresh?: boolean }[];
}[] = [
  {
    col: "Backlog",
    cards: [{ title: "Explore partner integrations" }, { title: "Q4 roadmap notes" }],
  },
  {
    col: "Ready",
    cards: [
      { title: "Spec: launch landing page", tag: "Code", fresh: true },
      { title: "Draft press outreach list", tag: "Research" },
    ],
  },
  {
    col: "Scheduled",
    cards: [{ title: "Build pricing experiment", tag: "Agent" }],
  },
];

function PmKanban() {
  return (
    <div className="rounded-[1.5rem] border border-black/[0.05] bg-white p-4 shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
      <div className="flex items-center gap-2 mb-1">
        <Moon className="w-3.5 h-3.5 text-slate-400" />
        <h3 className="text-sm font-semibold tracking-tight text-slate-900">
          Night Shift queue
        </h3>
      </div>
      <p className="text-xs text-slate-500 mb-3 leading-relaxed">
        Drop ideas in Backlog. Overnight, LYKN expands them to Ready, then
        approve to schedule the next run.
      </p>
      <div className="grid grid-cols-3 gap-2 items-start">
        {PM_KANBAN.map((c) => (
          <div
            key={c.col}
            className="min-w-0 rounded-xl border border-black/[0.06] bg-black/[0.02] p-2"
          >
            <p className="text-[0.58rem] uppercase tracking-[0.14em] font-semibold text-slate-400 mb-2">
              {c.col} ({c.cards.length})
            </p>
            <div className="space-y-2">
              {c.cards.map((card) => (
                <div
                  key={card.title}
                  className={`rounded-xl border border-black/[0.06] bg-white p-2 ${
                    card.fresh ? "gl-pm-card-fresh" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-1">
                    <p className="text-xs font-medium text-slate-800 leading-snug">
                      {card.title}
                    </p>
                    {card.tag && (
                      <span className="shrink-0 text-[0.55rem] uppercase tracking-wide font-semibold rounded px-1 py-0.5 bg-black/[0.05] text-slate-500">
                        {card.tag}
                      </span>
                    )}
                  </div>
                  {card.fresh && (
                    <p className="mt-1 inline-flex items-center gap-1 text-[0.58rem] font-semibold text-blue-600">
                      <span className="gl-pm-dot w-1 h-1 rounded-full bg-blue-500" />
                      Expanded by LYKN
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Phone breakpoint matching the landing page's mobile section treatment. */
const GL_PHONE_QUERY = "(max-width: 860px)";

/** Scale the project-manager dashboard as a uniform miniature on phones:
    lay out at a fixed desktop width, then transform-scale to the stage width
    so columns stay roomy instead of squishing into the narrow viewport. */
function PmPreviewFit({
  designWidth,
  children,
}: {
  designWidth: number;
  children: ReactNode;
}) {
  const [isPhone, setIsPhone] = useState(() =>
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(GL_PHONE_QUERY).matches,
  );
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(GL_PHONE_QUERY);
    const update = () => setIsPhone(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!isPhone) {
      setScale(0);
      setHeight(0);
      return;
    }
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      const nextScale = outer.clientWidth / designWidth;
      if (nextScale <= 0) return;
      setScale(nextScale);
      // Transform doesn't affect layout — reserve the post-scale height.
      setHeight(inner.scrollHeight * nextScale);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [isPhone, designWidth]);

  if (!isPhone) return <>{children}</>;

  return (
    <div
      ref={outerRef}
      className="gl-pm-fit"
      style={height > 0 ? { height } : undefined}
    >
      <div
        ref={innerRef}
        className="gl-pm-fit-inner"
        style={{
          width: designWidth,
          transform: scale > 0 ? `scale(${scale})` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** "LYKN runs your projects" — frames the ACTUAL projects + calendar dashboard
    UI (stat tiles, month calendar, tasks, Night Shift queue) inside the shared
    browser window chrome, with looping micro-animations so it feels alive. */
function ProjectManagerSection() {
  return (
    <section className="gl-pm" id="projects">
      <div className="gl-pm-inner">
        <h2 className="gl-pm-title gl-reveal">Your AI project manager</h2>

        <div className="gl-pm-stage gl-reveal">
          <PmPreviewFit designWidth={900}>
            <div className="gl-window gl-window--pm">
              <div className="gl-window-bar">
                <div className="gl-dots">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="gl-window-search">lykn.ai/projects</div>
                <div className="gl-window-actions">
                  <span className="gl-window-avatar" />
                </div>
              </div>

              <div className="gl-pm-body">
                {/* Project header + live "managing" chip */}
                <div className="flex flex-wrap items-center gap-2">
                  <FolderKanban className="w-5 h-5 text-slate-500" />
                  <h3 className="text-xl font-semibold tracking-tight text-slate-900">
                    Q3 Product Launch
                  </h3>
                  <span className="text-[0.625rem] px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600">
                    Active
                  </span>
                  <span className="inline-flex items-center gap-1 text-[0.625rem] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600">
                    <Crosshair className="w-3 h-3" />
                    AI focus
                  </span>
                </div>

                {/* Stat tiles — always the desktop 4-up; phones scale the whole
                    window down instead of squishing into a 2-col stack. */}
                <div className="mt-4 grid grid-cols-4 gap-2.5">
                  <PmStat icon={ListTodo} label="Open tasks" value={7} />
                  <PmStat icon={CalendarClock} label="Overdue" value={1} tone="danger" />
                  <PmStat icon={CheckCircle2} label="Done · 7d" value={12} />
                  <PmStat icon={CalendarPlus} label="Events · 7d" value={4} tone="accent" />
                </div>

                {/* Calendar + tasks — side-by-side like the real dashboard. */}
                <div className="mt-3 grid grid-cols-2 gap-3 items-start">
                  <PmCalendar />
                  <PmTasks />
                </div>

                {/* Night Shift queue */}
                <div className="mt-3">
                  <PmKanban />
                </div>
              </div>
            </div>
          </PmPreviewFit>
        </div>
      </div>
    </section>
  );
}

/** "Latest news" — a row of article tiles under the project manager section,
    each linking to its full post at /news/<slug>. */
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
    a: "LYKN is a personal intelligence layer for your AI. It remembers who you are, holds the context of your projects, and brings that personalized AI onto any screen you work on.",
  },
  {
    q: "Does it work with the AI tools I already use?",
    a: "Yes. LYKN connects to the apps and assistants you already use and carries your context across them, so every model you talk to is grounded in the same understanding of you.",
  },
  {
    q: "How does LYKN remember me across different apps?",
    a: "Everything LYKN learns lives in your intelligence layer: your beliefs, preferences, projects, and the context it draws on. That layer is portable, so it travels with you instead of being trapped in one app.",
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
    q: "Which platforms is Glass available on?",
    a: "Glass is the desktop overlay that puts LYKN on any screen with a single shortcut. Hit ⌘ + L and it is right there, wherever you are working.",
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
                  <span>{f.q}</span>
                  <ChevronDown className="gl-faq-chevron" aria-hidden="true" />
                </button>
                <div className="gl-faq-a-wrap">
                  <div className="gl-faq-a-inner">
                    <p className="gl-faq-a">{f.a}</p>
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
    title: "Use LYKN in my browser",
    sub: "Your full workspace on the web, nothing to install.",
    points: [
      "Chat, projects, vault, and your synthesis layer",
      "Works in any modern browser",
      "Free to start, no credit card",
      "Same account on every device",
    ],
    cta: "Start in my browser",
    to: "/login",
    solid: true,
  },
  {
    title: "Download the full LYKN experience",
    sub: "The Mac app puts your AI on every screen.",
    points: [
      "Summon LYKN Glass anywhere with ⌘ L",
      "Ask about whatever is on your screen",
      "Snip, build, and generate without switching apps",
      "Hands-free voice mode",
      "Everything from the browser, plus your desktop",
    ],
    cta: "Download for Mac",
    to: "/download",
  },
];

/** "Choose how to get started" — two dark option cards above the footer:
    the browser app and the full Mac experience. */
function GetStartedSection() {
  const navigate = useNavigate();
  return (
    <section className="gl-start" id="download">
      <div className="gl-start-inner">
        <h2 className="gl-start-title gl-reveal">Choose how to get started</h2>
        <div className="gl-start-grid gl-reveal">
          {START_OPTIONS.map((opt) => (
            <article className="gl-start-card" key={opt.title}>
              <h3 className="gl-start-card-title">{opt.title}</h3>
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
      { label: "Glass", scroll: "top" },
      { label: "Projects", scroll: "projects" },
    ],
  },
  {
    title: "Explore",
    links: [
      { label: "Pricing", to: "/pricing" },
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
          <img src={lyknLogo} alt="LYKN" className="gl-footer-logo" />
          <p className="gl-footer-tagline">
            AI on any screen, personalized to you.
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
        <span>© {new Date().getFullYear()} LYKN. All rights reserved.</span>
        <span className="gl-footer-shortcut">
          AI on any screen · <kbd>⌘</kbd> <kbd>L</kbd>
        </span>
      </div>
    </footer>
  );
}

// Text sitting directly on the page backdrop (not on a card/window), which
// the GlassBackdrop blends toward white as the blue glow passes behind it.
// Big titles get the letter-by-letter gradient treatment; the rest blend as
// a whole element.
const GRAD_TEXT_SELECTORS = [
  ".gl-cap-title",
  ".gl-any-title",
  ".gl-any-title-dim",
  ".gl-pm-title",
  ".gl-news-title",
  ".gl-faq-title",
  ".gl-start-title",
  ".gl-hero-headline",
];
const MIX_TEXT_SELECTORS = [
  ".gl-any-sub",
  ".gl-any-stat dt",
  ".gl-any-stat dd",
  ".gl-news-all",
  ".gl-news-date",
  ".gl-news-headline",
  ".gl-hero-lede",
  // The footer is transparent over the backdrop, so its text blends to
  // white wherever the glow sits behind it.
  ".gl-footer-tagline",
  ".gl-footer-col-title",
  ".gl-footer-link",
  ".gl-footer-bottom",
];

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

  const goToSignup = () => navigate("/login");

  // ⌘L (or Ctrl+L) summons the live LYKN overlay demo over the landing page,
  // the same shortcut that pulls up the real Glass overlay on any screen. The
  // corner keycaps open it on click too.
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

      {/* Fixed page-wide backdrop: the drifting blue glow + frosted panels
          (shared with the other marketing pages via GlassBackdrop). */}
      <GlassBackdrop
        gradTextSelectors={GRAD_TEXT_SELECTORS}
        mixTextSelectors={MIX_TEXT_SELECTORS}
      />

      <main>
        {/* Hero — reference layout: copy + CTA on the left, the page-wide
            blue glow parked behind the frosted panels on the right, with the
            chat bar and floating feature labels over it, all on plain white. */}
        <section className="gl-hero">
          {/* The overlay chat bar, centered over the panel art on the right,
              ringed by little angled prompt hints. Interacting with the bar
              opens the live ⌘L demo. */}
          <div className="gl-hero-bar">
            <div className="gl-hero-hints" aria-hidden="true">
              <span className="gl-hero-hint">Build me a dashboard</span>
              <span className="gl-hero-hint">Generate me an ad</span>
              <span className="gl-hero-hint">Help me rephrase this</span>
              <span className="gl-hero-hint">Summarize this page</span>
              <span className="gl-hero-hint">Draft my report</span>
              <span className="gl-hero-hint">Plan my week</span>
            </div>
            <GlassBar
              className="gl-hero-glassbar"
              onActivate={() => setDemoOpen(true)}
            />
          </div>

          {/* Headline pinned to the top-left: "Welcome to LYKN studio", with
              the brand name set in the official wordmark art. */}
          <div className="gl-hero-inner">
            <div className="gl-hero-copy">
              <h1 className="gl-hero-headline">
                Welcome to
                <br />
                <img
                  src={lyknWordmark}
                  alt="LYKN"
                  className="gl-hero-word"
                  draggable={false}
                />{" "}
                studio
              </h1>
              <p className="gl-hero-lede">
                LYKN studio is your personal AI workspace. Your projects,
                notes, and conversations live together in one place, and an
                AI that actually knows you works across all of them.
              </p>
              <p className="gl-hero-lede">
                Summon it on any screen with a shortcut: draft a report, build
                a dashboard, manage your tasks, or just ask, without ever
                switching apps.
              </p>
              <div className="gl-hero-ctas">
                <button type="button" className="gl-hero-cta" onClick={goToSignup}>
                  Try LYKN
                </button>
                <button
                  type="button"
                  className="gl-hero-cta gl-hero-cta--blue"
                  onClick={() => navigate("/download")}
                >
                  Download LYKN
                </button>
              </div>
            </div>
          </div>
        </section>

        <CapabilitiesSection />
        <AnyScreenSection />
        <SnipShowcaseSection />
        <ProjectManagerSection />
        <NewsSection />
        <FaqSection />
        <GetStartedSection />
      </main>

      <SiteFooter />
      <KeycapCTA onTrigger={() => setDemoOpen((o) => !o)} />
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
