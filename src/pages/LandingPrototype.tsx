import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";
import lyknIcon from "@/assets/FINAL/LYKN-ICON-B-Open/PNGs/LYKN-Icon-B-Open-NEUTRAL-web.png";
import demoVideo from "@/assets/lykn-demo-hero.mp4";
import WakePreviewFit from "@/components/wake/WakePreviewFit";
import WakeAppShellPreview from "@/components/wake/WakeAppShellPreview";
import WakeSynthesisTourPreview from "@/components/wake/WakeSynthesisTourPreview";
import WakeChatSubwindow from "@/components/wake/WakeChatSubwindow";
import WakeVaultSubwindow from "@/components/wake/WakeVaultSubwindow";
import WakeVoiceSubwindow from "@/components/wake/WakeVoiceSubwindow";
import WakeAgentsSubwindow from "@/components/wake/WakeAgentsSubwindow";
import type { ComponentType } from "react";

// Traditional, scroll-driven marketing landing page.
//
// The previous "wake" experience was an arrow-driven carousel that landed
// poorly with reviewers. This replaces it with a conventional landing page:
//   1. Sticky header — icon + wordmark on the left, Product / Pricing / Docs
//      (plus Sign in) on the right.
//   2. Hero — black canvas, the LYKN logo, a bold one-line promise, and a
//      single blue "Get started" button.
//   3. A large, non-interactive "load-in" preview of the real app.
//   4. One feature section per surface (Synthesis, Vault, Chat, Voice,
//      Agents). Each pairs a live preview built from the ACTUAL product UI
//      with an explainer describing what it is and the problem it solves.
//   5. A closing call to action and a minimal footer.
//
// Every preview reuses the same components the real product renders, so what
// a visitor sees on the landing page is exactly what they get after signup.

const PROBLEM_WHY =
  "AI was built for everyone, so it remembers no one. LYKN is the intelligence layer that stays personal, portable, and yours across every model you connect.";

// The problems LYKN solves, paired with how it fixes each one.
const PROBLEM_SOLUTIONS = [
  {
    problem: {
      title: "Every chat starts from zero",
      body: "New session, blank slate. The model doesn't remember who you are, what you prefer, or what you already decided.",
    },
    solution: {
      title: "Active memory",
      body: "Every chat has context. Who you are, what you prefer, and what you've decided carry forward.",
    },
  },
  {
    problem: {
      title: "General by default",
      body: "You get the same answers everyone else gets. Generic, one-size-fits-all responses because it treats you like every other user.",
    },
    solution: {
      title: "Personal, not generic",
      body: "AI built by you, with answers shaped to you. Build out an intelligence layer so the AI knows who you are. No response is a generic default.",
    },
  },
  {
    problem: {
      title: "A yes man, not a real partner",
      body: "Overly friendly, always agreeing. It sounds helpful, but rarely tells you what you need to hear.",
    },
    solution: {
      title: "Real AI built by you",
      body: "It's your AI. You decide the tone of its answers. Blunt, warm, skeptical. However you want it to talk.",
    },
  },
  {
    problem: {
      title: "Multiple subscriptions",
      body: "ChatGPT Plus, Claude Pro, Gemini Advanced. Pay again for every AI, with nothing portable between them.",
    },
    solution: {
      title: "One payment, best models",
      body: "One subscription. Access the best models without stacking a separate bill for every LLM.",
    },
  },
  {
    problem: {
      title: "Makes you weaker, not sharper",
      body: "Outsource enough thinking and your edge dulls. Most AI answers for you instead of making you smarter.",
    },
    solution: {
      title: "Intelligence that compounds",
      body: "Built to strengthen how you think. AI built to help you think through hard problems, not to think for you.",
    },
  },
  {
    problem: {
      title: "Context trapped in silos",
      body: "What ChatGPT learns stays in ChatGPT, and what Claude learns stays in Claude. Your subscriptions don't connect.",
    },
    solution: {
      title: "Portable across every AI",
      body: "Connect once. ChatGPT, Claude, Gemini, Grok, and the rest read the same governed context through MCP.",
    },
  },
  {
    problem: {
      title: "Type to a chatbot, get nothing done",
      body: "You type into a text box and copy answers back out. There's no assistant that actually hears you or acts on your behalf.",
    },
    solution: {
      title: "Chat and voice agents that know you",
      body: "Chat or talk to agents that already know your context and act on it. Your own Jarvis that listens, remembers who you are, and gets things done.",
    },
  },
] as const;

/**
 * Reveals once when scrolled into view and stays revealed. We also use the
 * "has been seen" signal to lazily mount heavy previews (the 3D synthesis
 * scene, the embedded vault, the model builder) only when they approach the
 * viewport, so the page stays light on first paint.
 */
function useReveal<T extends HTMLElement>(rootMargin = "0px 0px -12% 0px") {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (
      typeof window === "undefined" ||
      typeof window.IntersectionObserver !== "function"
    ) {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setSeen(true);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.18, rootMargin },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [rootMargin]);

  return { ref, seen };
}

// Custom neurons the user authors — beliefs, concepts, and projects that the
// AI reads before it answers. Shown as a small stack of glass cards in the
// app's neuron-type colors (white = belief, orange = concept, teal = project).
const SHOWCASE_NEURONS = [
  {
    type: "Belief",
    color: "#ffffff",
    text: "I value blunt, honest feedback over reassurance.",
    meta: "Shapes the tone of every reply",
  },
  {
    type: "Concept",
    color: "#f97316",
    text: "First-principles thinking",
    meta: "Break problems down to fundamentals",
  },
  {
    type: "Project",
    color: "#14b8a6",
    text: "Launch LYKN v1",
    meta: "In progress · 3 open threads",
  },
] as const;

function NeuronShowcase() {
  return (
    <div className="lkn-neuro">
      {SHOWCASE_NEURONS.map((n) => (
        <div
          key={n.type}
          className="lkn-neuro-card"
          style={{ "--neuro-color": n.color } as CSSProperties}
        >
          <div className="lkn-neuro-head">
            <span className="lkn-neuro-dot" aria-hidden />
            <span className="lkn-neuro-type">{n.type}</span>
          </div>
          <p className="lkn-neuro-text">{n.text}</p>
          <p className="lkn-neuro-meta">{n.meta}</p>
        </div>
      ))}
    </div>
  );
}

// Custom models — if-then governance the user defines without retraining.
// Shown as a small stack of "If → Then" rule cards in the app's model-blue.
const SHOWCASE_RULES = [
  {
    ifText: "User asks about pricing",
    thenText: "Check the pricing matrix in the vault before answering.",
  },
  {
    ifText: "I'm drafting an email",
    thenText: "Match my voice: direct, warm, no filler.",
  },
  {
    ifText: "A claim isn't sourced",
    thenText: "Flag it and ask before stating it as fact.",
  },
] as const;

function ModelShowcase() {
  return (
    <div className="lkn-model">
      {SHOWCASE_RULES.map((r) => (
        <div key={r.ifText} className="lkn-model-card">
          <div className="lkn-model-line">
            <span className="lkn-model-tag lkn-model-tag--if">If</span>
            <span className="lkn-model-text">{r.ifText}</span>
          </div>
          <div className="lkn-model-line">
            <span className="lkn-model-tag lkn-model-tag--then">Then</span>
            <span className="lkn-model-text">{r.thenText}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// Three product surfaces side by side: the Synthesis Layer nodes, your custom
// beliefs/concepts/projects, and the if-then model you build. No window chrome
// or borders, separated by thin dividers. Mounts lazily when in view.
function FeatureTrio() {
  const { ref, seen } = useReveal<HTMLDivElement>("0px 0px -8% 0px");

  return (
    <section className="lkn-trio" aria-label="Product previews">
      <div ref={ref} className={`lkn-trio-row lkn-reveal ${seen ? "is-in" : ""}`}>
        <div className="lkn-trio-cell">
          <span className="lkn-trio-label">Synthesis Layer</span>
          <div className="lkn-trio-preview">
            {/* Lite render (no bloom EffectComposer) so the canvas stays
                transparent and the background reads as pure black. */}
            {seen ? <WakeSynthesisTourPreview active={false} /> : null}
          </div>
        </div>

        <div className="lkn-trio-divider" aria-hidden />

        <div className="lkn-trio-cell">
          <span className="lkn-trio-label">Beliefs · Concepts · Projects</span>
          <div className="lkn-trio-preview">
            {seen ? <NeuronShowcase /> : null}
          </div>
        </div>

        <div className="lkn-trio-divider" aria-hidden />

        <div className="lkn-trio-cell">
          <span className="lkn-trio-label">Build your model</span>
          <div className="lkn-trio-preview">{seen ? <ModelShowcase /> : null}</div>
        </div>
      </div>
    </section>
  );
}

// Full-page previews of each surface paired with a plain-English explanation
// of what you actually do there. Real product windows on the left/right,
// copy on the other side, alternating layout down the page.
interface PageFeatureDef {
  id: string;
  kicker: string;
  title: string;
  body: string;
  bullets: string[];
  Preview: ComponentType<{ active: boolean; preload?: boolean }>;
}

const PAGE_FEATURES: PageFeatureDef[] = [
  {
    id: "chat",
    kicker: "Chat",
    title: "Talk to your intelligence layer",
    body:
      "Every reply starts from you, your beliefs, facts, and files, instead of a default persona the model invents on the fly.",
    bullets: [
      "Ask anything and get answers grounded in your synthesis layer",
      "Switch between any connected model without losing context",
      "Attach vault files and dictate hands-free",
      "Durable learnings become new neurons automatically",
    ],
    Preview: WakeChatSubwindow,
  },
  {
    id: "vault",
    kicker: "The Vault",
    title: "Your AI Drive",
    body:
      "Drop in anything and LYKN turns it into structured memory you can reason over forever, not just files in a folder.",
    bullets: [
      "Upload PDFs, images, video, audio, links, and quick notes",
      "LYKN extracts the meaning and links it to your neurons",
      "Search by keyword or by idea across everything",
      "Preview files in place without downloading",
    ],
    Preview: WakeVaultSubwindow,
  },
  {
    id: "voice",
    kicker: "Voice & Cloud Agents",
    title: "Talk to LYKN like a chief of staff",
    body:
      "Speak naturally, get answers out loud, and hand long jobs to cloud agents that keep working after you close the app.",
    bullets: [
      "Real-time, interruptible voice conversation",
      "Search the web, set reminders, and hear your daily briefing",
      "Hand off long jobs to agents that run in the background",
      "Results land back in chat when they finish",
    ],
    Preview: WakeVoiceSubwindow,
  },
  {
    id: "agents",
    kicker: "Model Builder",
    title: "Build an army of AI agents",
    body:
      "Give each agent a role, a model, a voice, and the tools it can touch, then let your main agent delegate like a manager.",
    bullets: [
      "Design specialists with custom instructions in minutes",
      "Pick the LLM and voice for each agent",
      "Promote a main agent that delegates to subagents",
      "Every agent inherits your synthesis layer",
    ],
    Preview: WakeAgentsSubwindow,
  },
];

function PageFeature({ feature, index }: { feature: PageFeatureDef; index: number }) {
  const { ref, seen } = useReveal<HTMLElement>("0px 0px -10% 0px");
  const reversed = index % 2 === 1;
  const { Preview } = feature;
  // Only the voice surface stays interactive; every other feature preview is
  // a static, look-but-don't-touch window (the interactive demo lives in the
  // hero showcase up top).
  const interactive = feature.id === "voice";

  return (
    <section ref={ref} className="lkn-feature" aria-label={feature.title}>
      <div
        className={`lkn-feature-grid ${reversed ? "lkn-feature-grid--reversed" : ""} lkn-reveal ${
          seen ? "is-in" : ""
        }`}
      >
        <div className="lkn-feature-copy">
          <h3 className="lkn-feature-title">{feature.title}</h3>
          <p className="lkn-feature-body">{feature.body}</p>
          <ul className="lkn-feature-list">
            {feature.bullets.map((b) => (
              <li key={b}>
                <span className="lkn-feature-dot" aria-hidden />
                {b}
              </li>
            ))}
          </ul>
        </div>
        <div
          className={`lkn-feature-demo ${interactive ? "" : "lkn-feature-demo--static"}`}
          {...(interactive ? {} : { "aria-hidden": true })}
        >
          {seen ? <Preview active={seen} /> : null}
        </div>
      </div>
    </section>
  );
}

function PageFeatures() {
  return (
    <>
      {PAGE_FEATURES.map((feature, i) => (
        <PageFeature key={feature.id} feature={feature} index={i} />
      ))}
    </>
  );
}

function ProblemColumn({ variant }: { variant: "old" | "new" }) {
  const isOld = variant === "old";
  const items = PROBLEM_SOLUTIONS.map((pair) =>
    isOld ? pair.problem.title : pair.solution.title,
  );
  const { ref, seen } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`lkn-col lkn-col--${variant} ${seen ? "is-in" : ""}`}>
      <div className={`lkn-col-pill lkn-col-pill--${variant}`}>
        {isOld ? "The old way" : "The new way"}
      </div>
      <div className="lkn-col-stream">
        {items.map((text) => (
          <div key={text} className="lkn-chip">
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProblemSolutions() {
  const { ref, seen } = useReveal<HTMLDivElement>();
  return (
    <section className="lkn-problems" id="problem" aria-label="The problem LYKN solves">
      <div ref={ref} className={`lkn-problems-head lkn-reveal ${seen ? "is-in" : ""}`}>
        <h2 className="lkn-section-headline">Modern AI wasn&apos;t built for you.</h2>
        <p className="lkn-section-sub">{PROBLEM_WHY}</p>
      </div>
      <div className="lkn-problems-columns">
        <ProblemColumn variant="old" />
        <ProblemColumn variant="new" />
      </div>
    </section>
  );
}

// The "entire load-in" showcase: a large browser window rendering the real
// app surface, intentionally non-interactive (pointer-events disabled) so it
// reads as a screenshot of the product booting up rather than something to
// click. Mounted lazily once it nears the viewport.
function AppLoadInShowcase() {
  // This card peeks above the fold directly under the hero, so only a thin
  // slice is visible on first paint. A scroll-reveal threshold would never
  // trip on that sliver, so we mount immediately and just fade it up on load.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div id="product" className="lkn-showcase lkn-showcase--peek">
      <div className={`lkn-showcase-window lkn-reveal ${shown ? "is-in" : ""}`}>
        <div className="lykn-wake-subwindow">
          <div className="lykn-wake-subwindow-chrome">
            <div className="lykn-wake-subwindow-dots" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <span className="lykn-wake-subwindow-title">LYKN</span>
          </div>
          <div className="lykn-wake-subwindow-body">
            <div className="lkn-showcase-noninteractive" aria-hidden>
              <WakePreviewFit designWidth={1180}>
                <WakeAppShellPreview active={false} />
              </WakePreviewFit>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const DOCS_LINKS = [
  { label: "Privacy Policy", href: "/privacy", external: false },
  { label: "Terms of Service", href: "/terms", external: false },
  { label: "Cookie Policy", href: "/cookies", external: false },
];

function DocsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="lkn-docs-menu">
      <button
        type="button"
        className="lkn-nav-link"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Docs
      </button>
      {open ? (
        <div className="lkn-docs-dropdown" role="menu">
          {DOCS_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noreferrer" : undefined}
              className="lkn-docs-item"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              {link.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const LandingPrototype = () => {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Returning from a canceled Stripe checkout drops the visitor on
  // `/?resume=account`. We no longer have an inline account slide, so just
  // clean the URL — the visitor sees the normal landing page and can sign in
  // again from the header.
  useEffect(() => {
    if (searchParams.get("resume") !== "account") return;
    window.history.replaceState({}, "", "/");
  }, [searchParams]);

  // A signed-in visitor has no use for the marketing page. The route's
  // GuestOnly wrapper already handles this, but guard here too so a stale
  // session never flashes the landing page before bouncing.
  useEffect(() => {
    if (!authLoading && user && searchParams.get("resume") !== "account") {
      navigate("/start-trial", { replace: true });
    }
  }, [authLoading, user, navigate, searchParams]);

  const goToSignup = useCallback(() => navigate("/login"), [navigate]);

  const scrollToId = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="dark lkn-land">
      <header className="lkn-header">
        <div className="lkn-header-inner">
          <button
            type="button"
            className="lkn-brand"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label="LYKN home"
          >
            <img src={lyknLogo} alt="LYKN" className="lkn-brand-logo" />
          </button>

          <nav className="lkn-nav" aria-label="Primary">
            <button type="button" className="lkn-nav-link" onClick={() => scrollToId("product")}>
              Product
            </button>
            <button type="button" className="lkn-nav-link" onClick={() => scrollToId("pricing")}>
              Pricing
            </button>
            <DocsMenu />
            <button type="button" className="lkn-nav-signin" onClick={goToSignup}>
              Sign in
            </button>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero — the video fills the hero only, ending at the hero's bottom
            edge where the app preview below pokes up. */}
        <section className="lkn-hero" id="top">
          <video
            className="lkn-bg-video"
            src={demoVideo}
            autoPlay
            muted
            loop
            playsInline
            aria-hidden
          />
          <div className="lkn-bg-overlay" aria-hidden />
          <div className="lkn-hero-inner">
            <img src={lyknLogo} alt="LYKN" className="lkn-hero-logo" />
            <p className="lkn-hero-tagline">Stop starting over with AI</p>
            <button type="button" className="lykn-primary-btn lkn-cta" onClick={goToSignup}>
              Get started
              <ArrowRight className="lkn-cta-icon" strokeWidth={2.25} />
            </button>
          </div>
        </section>

        {/* Full app load-in — sits below the hero on black, its top poking up */}
        <AppLoadInShowcase />

        {/* The problem LYKN solves — problem/solution pairs */}
        <ProblemSolutions />

        {/* Full app intro */}
        <section className="lkn-product-intro">
          <h2 className="lkn-section-headline">Your entire intelligence layer, in one place.</h2>
          <p className="lkn-section-sub">
            Synthesis, vault, chat, voice, and agents load into a single
            workspace. This is the real app, exactly as it boots up.
          </p>
        </section>

        {/* Three core surfaces side by side — raw UI segments */}
        <FeatureTrio />

        {/* Full-page previews with explanations of what you can do */}
        <PageFeatures />

        {/* Closing CTA / pricing */}
        <section className="lkn-final" id="pricing">
          <div className="lkn-final-inner lkn-reveal is-in">
            <img src={lyknIcon} alt="" className="lkn-final-icon" />
            <h2 className="lkn-final-headline">Build an AI that actually knows you.</h2>
            <p className="lkn-final-sub">
              Start your 7-day free trial. Full access to LYKN Pro for $17/month
              after. Cancel anytime before it ends.
            </p>
            <button type="button" className="lykn-primary-btn lkn-cta" onClick={goToSignup}>
              Get started
              <ArrowRight className="lkn-cta-icon" strokeWidth={2.25} />
            </button>
          </div>
        </section>
      </main>

      <footer className="lkn-footer">
        <div className="lkn-footer-inner">
          <img src={lyknLogo} alt="LYKN" className="lkn-footer-wordmark" />
          <div className="lkn-footer-links">
            <a href="/privacy" className="lkn-footer-link">Privacy</a>
            <a href="/terms" className="lkn-footer-link">Terms</a>
            <a href="/cookies" className="lkn-footer-link">Cookies</a>
          </div>
          <p className="lkn-footer-copy">
            © {new Date().getFullYear()} LYKN
          </p>
        </div>
      </footer>
    </div>
  );
};

export default LandingPrototype;
