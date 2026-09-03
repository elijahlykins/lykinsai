import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Paperclip, X } from "lucide-react";
import ThinkingIndicator from "@/components/lyknChat/ThinkingIndicator";
import { StudioResearchSidebar } from "@/components/lyknChat/StudioChatChrome";
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
import waveWall from "@/assets/hero-wave-blue.jpg";

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
      { threshold: 0.2, rootMargin: "0px 0px -10% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return { ref, seen };
}

const CAP_CHAT: { role: "user" | "lykn"; text: string }[] = [
  {
    role: "lykn",
    text: "Two particles become linked — measuring one instantly determines the other, regardless of distance.",
  },
  { role: "user", text: "Why is the sky blue?" },
  {
    role: "lykn",
    text: "Shorter blue wavelengths scatter more off air molecules than longer red ones.",
  },
  { role: "user", text: "How do black holes form?" },
  {
    role: "lykn",
    text: "A massive star exhausts its fuel and gravity collapses the core into a singularity.",
  },
];

export function CapChatDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const [count, setCount] = useState(1);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setCount(CAP_CHAT.length);
      return;
    }
    const atEnd = count >= CAP_CHAT.length;
    const delay = atEnd ? 3600 : CAP_CHAT[count].role === "lykn" ? 1700 : 1250;
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
          {m.text}
        </div>
      ))}
    </div>
  );
}

const BUILD_LINES = [
  { num: "15", code: "await rateLimit(req, { max: 100 });" },
  { num: "33", code: "if (!data.name) throw Error;" },
  { num: "33", code: "return schema.parse(data);" },
] as const;

const BUILD_OPS = [
  { kind: "file", name: "read_file", detail: "src/auth/session.ts" },
  { kind: "file", name: "grep", detail: "JWT|session" },
  { kind: "task", name: "replace session store", status: "running" },
  { kind: "task", name: "add token mint", status: "done" },
] as const;

export function CapBuildDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(BUILD_OPS.length);
      return;
    }
    if (step >= BUILD_OPS.length) {
      const t = window.setTimeout(() => setStep(0), 2800);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setStep((s) => s + 1), 900);
    return () => window.clearTimeout(t);
  }, [seen, step]);

  return (
    <div className="gl-cap-code" ref={ref} aria-hidden="true">
      <div className="gl-cap-code-head">
        <span className="gl-cap-code-file">projects/main</span>
        <span className="gl-cap-code-mode">18.15%</span>
      </div>
      <div className="gl-cap-code-snippet">
        {BUILD_LINES.map((line) => (
          <div className="gl-cap-code-line" key={`${line.num}-${line.code}`}>
            <span className="gl-cap-code-num">{line.num}</span>
            <span>{line.code}</span>
          </div>
        ))}
      </div>
      <p className="gl-cap-code-prompt">
        <span>{">"}</span> Migrate auth from sessions to JWT.
      </p>
      <div className="gl-cap-code-log">
        <p className="gl-cap-code-thinking">Thinking...</p>
        {BUILD_OPS.slice(0, step).map((op) =>
          op.kind === "file" ? (
            <p className="gl-cap-code-op" key={op.name}>
              <span>{op.name}</span>
              <span>{op.detail}</span>
            </p>
          ) : (
            <p className="gl-cap-code-task" key={op.name} data-status={op.status}>
              <span>[{op.status}]</span>
              {op.name}
            </p>
          ),
        )}
      </div>
    </div>
  );
}

const RESEARCH_QUERY =
  "Research Tesla stock: recent performance, valuation, and analyst outlook";
const RESEARCH_SOURCES = [
  {
    title: "Tesla, Inc. (TSLA) — Yahoo Finance",
    url: "https://finance.yahoo.com/quote/TSLA",
  },
  {
    title: "Tesla Q2 2026 vehicle production & deliveries",
    url: "https://ir.tesla.com",
  },
  {
    title: "TSLA analyst ratings and price targets",
    url: "https://www.bloomberg.com/quote/TSLA:US",
  },
  {
    title: "SEC Form 10-Q — Tesla Inc.",
    url: "https://www.sec.gov",
  },
  {
    title: "EV market share — Tesla vs rivals",
    url: "https://www.reuters.com",
  },
  {
    title: "Tesla valuation multiples vs peers",
    url: "https://www.wsj.com",
  },
] as const;

/** The Studio Research flow as a simple three-beat loop — ask, think,
    report — in one stable layout. Beats crossfade in place and the sources
    rail slides in alongside the report. */
export function CapResearchCard() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  // 0 ask · 1 thinking · 2 report · 3 fade out, then loop.
  const [step, setStep] = useState(0);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(2);
      return;
    }
    const waits = [1400, 2000, 4800, 650];
    const t = window.setTimeout(() => {
      if (step >= 3) {
        setCycle((c) => c + 1);
        setStep(0);
      } else {
        setStep(step + 1);
      }
    }, waits[step] ?? 1400);
    return () => window.clearTimeout(t);
  }, [seen, step]);

  return (
    <div className="gl-cap-rs" ref={ref} aria-hidden="true">
      <div key={cycle} className={`gl-cap-rs-run${step >= 3 ? " is-out" : ""}`}>
        <div className="gl-cap-rs-thread">
          <p className="gl-cap-rs-user">{RESEARCH_QUERY}</p>
          {/* Thinking and the report share one grid cell, so swapping them
              is a crossfade with no reflow. */}
          <div className="gl-cap-rs-swap">
            <div className={`gl-cap-rs-wait${step === 1 ? " is-on" : ""}`}>
              <ThinkingIndicator
                compact
                status="Researching markets & finance sources…"
              />
            </div>
            <div className={`gl-cap-rs-doc${step >= 2 ? " is-on" : ""}`}>
              <p>
                Tesla (TSLA) has reclaimed momentum into H2 2026: deliveries
                are trending higher, energy storage is becoming a meaningful
                second engine, and the Street remains split between a growth
                premium and execution risk on autonomy.
              </p>
              <h3>Recent performance</h3>
              <ul>
                <li>YTD total return ≈ +18%, outpacing the S&P autos basket.</li>
                <li>Last two quarters showed sequential delivery growth.</li>
              </ul>
            </div>
          </div>
        </div>
        <div className={`gl-cap-rs-rail${step >= 2 ? " is-on" : ""}`}>
          <StudioResearchSidebar
            sources={RESEARCH_SOURCES.map((s) => ({
              title: s.title,
              url: s.url,
            }))}
            canSave={step >= 2}
            saving={false}
            onSave={() => {}}
          />
        </div>
      </div>
    </div>
  );
}

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
    <div className="gl-cap-voice" ref={ref} aria-hidden="true">
      {/* Replica of the desktop Voice Mode popup (VoiceModePopup +
          LyknChatVoiceModeEleven): glass card over the desktop wallpaper
          with chrome, orb, status, and paste bar. */}
      <img
        className="gl-cap-voice-wall"
        src={waveWall}
        alt=""
        draggable={false}
      />
      <div className="gl-cap-voice-card">
        <div className="gl-cap-voice-chrome">
          <span>Voice</span>
          <X />
        </div>
        <VoiceTechOrb
          state="listening"
          micLevel={micLevel}
          size={148}
          appearance="dark"
        />
        <span className="gl-cap-voice-status">Listening…</span>
        <div className="gl-cap-voice-paste">
          <Paperclip />
          <em>Paste a link or file</em>
        </div>
      </div>
    </div>
  );
}

function CapFoot({
  name,
  onExplore,
  tone = "light",
}: {
  name: string;
  onExplore: () => void;
  tone?: "light" | "dark";
}) {
  return (
    <div className={`gl-cap-foot gl-cap-foot--${tone}`}>
      <span className="gl-cap-name">{name}</span>
      <button type="button" className="gl-cap-explore" onClick={onExplore}>
        Explore <span aria-hidden="true">→</span>
      </button>
    </div>
  );
}

/** Capability cards under the landing headline: Chat, Build, Research, Imagine, Voice. */
export default function LandingCapabilities() {
  const navigate = useNavigate();
  return (
    <section className="gl-cap" id="capabilities">
      <div className="gl-cap-inner">
        <h2 className="gl-cap-title gl-reveal">
          AI for <span className="gl-cap-underline">anything</span> you need.
        </h2>

        <div className="gl-cap-grid gl-reveal">
          <article className="gl-cap-card gl-cap-card--light">
            <CapChatDemo />
            <CapFoot name="Chat" onExplore={() => navigate("/product/chat")} />
          </article>

          <article className="gl-cap-card gl-cap-card--dark" data-header-tone="dark">
            <CapBuildDemo />
            <CapFoot
              name="Build"
              tone="dark"
              onExplore={() => navigate("/product/build")}
            />
          </article>

          <article className="gl-cap-card gl-cap-card--light">
            <CapResearchCard />
            <CapFoot
              name="Research"
              onExplore={() => navigate("/product/research")}
            />
          </article>

          <article
            className="gl-cap-card gl-cap-card--media gl-cap-card--wide"
            data-header-tone="dark"
          >
            <CapImagineDemo />
            <CapFoot
              name="Imagine"
              tone="dark"
              onExplore={() => navigate("/product/imagine")}
            />
          </article>

          <article className="gl-cap-card gl-cap-card--light gl-cap-card--wide">
            <CapVoiceDemo />
            <CapFoot
              name="Voice"
              tone="dark"
              onExplore={() => navigate("/product/voice")}
            />
          </article>
        </div>
      </div>
    </section>
  );
}
