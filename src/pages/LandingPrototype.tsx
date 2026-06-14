import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CloudUpload,
  FileText,
  Plus,
  Sparkles,
  MessagesSquare,
  Mic,
  Bot,
  Archive,
  Plug,
  CalendarDays,
  ShieldCheck,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-BLUE-web.png";
import lyknLogoWhite from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";
import WakePreviewFit from "@/components/wake/WakePreviewFit";
import WakeAppShellPreview from "@/components/wake/WakeAppShellPreview";
import WakeChatSubwindow from "@/components/wake/WakeChatSubwindow";
import WakeSynthesisSubwindow from "@/components/wake/WakeSynthesisSubwindow";
import WakeVoiceSubwindow from "@/components/wake/WakeVoiceSubwindow";
import WakeVoiceTourPreview from "@/components/wake/WakeVoiceTourPreview";
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
  "AI was built for everyone, so it remembers no one. LYKN is the intelligence layer that stays personal, portable, and yours across everything you do.";

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
  {
    problem: {
      title: "AI talks, but never does the work",
      body: "It can outline a plan or list the steps, but you're still the one doing every task by hand once the chat ends.",
    },
    solution: {
      title: "Cloud agents that do the work",
      body: "Hand off real jobs to cloud agents that keep running after you close the app, then deliver the finished result back to you.",
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

// ── Three animated, white mini-UI mocks for the suite cards ──────────────
// These are purely presentational, CSS-animated loops (no data, no auth) so
// they run for signed-out visitors and stay light on the page.

// Card 1 — Projects: a few "active" project rows whose progress bars fill and
// whose live dots pulse, conveying work happening inside LYKN.
const SHOWCASE_PROJECTS = [
  { name: "Product launch", sub: "18 neurons", pct: 72, grad: "linear-gradient(135deg,#60a5fa,#2563eb)" },
  { name: "Research vault", sub: "31 neurons", pct: 48, grad: "linear-gradient(135deg,#c084fc,#7c3aed)" },
  { name: "Marathon training", sub: "9 neurons", pct: 90, grad: "linear-gradient(135deg,#34d399,#059669)" },
];

function ProjectsShowcase() {
  return (
    <div className="lkn-mock lkn-proj">
      <div className="lkn-mock-head">
        <span className="lkn-mock-title">Projects</span>
        <span className="lkn-mock-badge">3 active</span>
      </div>
      <div className="lkn-proj-list">
        {SHOWCASE_PROJECTS.map((p, i) => (
          <div
            key={p.name}
            className="lkn-proj-card"
            style={{ animationDelay: `${i * 0.18}s` }}
          >
            <span className="lkn-proj-icon" style={{ background: p.grad }} />
            <div className="lkn-proj-meta">
              <div className="lkn-proj-top">
                <span className="lkn-proj-name">{p.name}</span>
                <span className="lkn-proj-active">
                  <span className="lkn-proj-dot" />
                  Active
                </span>
              </div>
              <span className="lkn-proj-sub">{p.sub}</span>
              <div className="lkn-proj-track">
                <span
                  className="lkn-proj-fill"
                  style={{ ["--w" as string]: `${p.pct}%`, animationDelay: `${0.3 + i * 0.18}s` }}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Card 2 — Vault: a file repeatedly drops into the upload zone, then lands as
// a new row in the file list with an upload progress bar.
function VaultUploadShowcase() {
  return (
    <div className="lkn-mock lkn-vault">
      <div className="lkn-mock-head">
        <span className="lkn-mock-title">Vault</span>
        <span className="lkn-mock-badge">Uploading</span>
      </div>
      <div className="lkn-vault-drop">
        <div className="lkn-vault-falling">
          <span className="lkn-vault-falling-ico">
            <FileText size={16} strokeWidth={2} />
          </span>
          <span className="lkn-vault-falling-name">research.pdf</span>
        </div>
        <div className="lkn-vault-zone">
          <CloudUpload size={26} strokeWidth={1.75} />
          <span>Drop files to upload</span>
        </div>
      </div>
      <div className="lkn-vault-list">
        <div className="lkn-vault-row lkn-vault-row--new">
          <span className="lkn-vault-row-ico lkn-vault-row-ico--red">
            <FileText size={14} strokeWidth={2} />
          </span>
          <span className="lkn-vault-row-name">research.pdf</span>
          <span className="lkn-vault-progress"><span /></span>
        </div>
        <div className="lkn-vault-row">
          <span className="lkn-vault-row-ico lkn-vault-row-ico--blue">
            <FileText size={14} strokeWidth={2} />
          </span>
          <span className="lkn-vault-row-name">design-notes.md</span>
          <span className="lkn-vault-row-done">Saved</span>
        </div>
        <div className="lkn-vault-row">
          <span className="lkn-vault-row-ico lkn-vault-row-ico--green">
            <FileText size={14} strokeWidth={2} />
          </span>
          <span className="lkn-vault-row-name">interview.mp3</span>
          <span className="lkn-vault-row-done">Saved</span>
        </div>
      </div>
    </div>
  );
}

// Card 3 — Calendar + to-dos: an event chip pops onto today, a task checks
// itself off, and a fresh task slides into the list.
const PLAN_WEEK = ["S", "M", "T", "W", "T", "F", "S"];

function PlanShowcase() {
  const today = new Date().getDay();
  return (
    <div className="lkn-mock lkn-plan">
      <div className="lkn-plan-cal">
        <div className="lkn-mock-head">
          <span className="lkn-mock-title">This week</span>
          <span className="lkn-mock-badge lkn-mock-badge--soft">
            <Plus size={11} strokeWidth={2.5} /> Event
          </span>
        </div>
        <div className="lkn-plan-week">
          {PLAN_WEEK.map((d, i) => (
            <div
              key={i}
              className={`lkn-plan-day ${i === today ? "is-today" : ""}`}
            >
              <span className="lkn-plan-dow">{d}</span>
              <span className="lkn-plan-num">{10 + i}</span>
              {i === today ? <span className="lkn-plan-event" /> : null}
              {i === today + 2 ? <span className="lkn-plan-event lkn-plan-event--alt" /> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="lkn-plan-todo">
        <div className="lkn-mock-head">
          <span className="lkn-mock-title">To-dos</span>
        </div>
        <ul className="lkn-plan-list">
          <li className="lkn-plan-task lkn-plan-task--checking">
            <span className="lkn-plan-check"><Check size={11} strokeWidth={3} /></span>
            <span className="lkn-plan-task-label">Draft launch post</span>
          </li>
          <li className="lkn-plan-task">
            <span className="lkn-plan-check" />
            <span className="lkn-plan-task-label">Review Q3 goals</span>
          </li>
          <li className="lkn-plan-task lkn-plan-task--adding">
            <span className="lkn-plan-check" />
            <span className="lkn-plan-task-label">Book flights for offsite</span>
          </li>
        </ul>
      </div>
    </div>
  );
}

// Three-card "suite" grid: a soft-panelled, white mini-UI per card with a
// bold lead-in + supporting line beneath it, then a strip of the tools LYKN
// works with. Modelled on the reference layout the user shared.
interface SuiteCardDef {
  id: string;
  lead: string;
  rest: string;
  Preview: ComponentType;
}

const SUITE_CARDS: SuiteCardDef[] = [
  {
    id: "projects",
    lead: "Projects, alive.",
    rest:
      "Cluster your neurons into projects and watch LYKN keep them moving, not just folders that sit there.",
    Preview: ProjectsShowcase,
  },
  {
    id: "vault",
    lead: "Your AI Drive.",
    rest:
      "Drop in any file and LYKN turns it into memory you can reason over, not just something in a folder.",
    Preview: VaultUploadShowcase,
  },
  {
    id: "plan",
    lead: "Plans that stay in sync.",
    rest:
      "LYKN adds to your calendar and to-do list as you chat or talk, and keeps everything current, hands-free.",
    Preview: PlanShowcase,
  },
];

// Apps LYKN works with, shown with their real logos. `iconUrl` mirrors the
// catalog's explicit overrides (Google's S2 favicon returns the same generic
// "G" for every google.com sub-app, so those need a real product icon);
// everything else resolves through the same favicon fallback chain the
// Connections grid uses.
interface SuiteTool {
  name: string;
  domain: string;
  iconUrl?: string;
}

const SUITE_TOOLS: SuiteTool[] = [
  { name: "ChatGPT", domain: "chatgpt.com" },
  { name: "Claude", domain: "claude.ai" },
  { name: "Gemini", domain: "gemini.google.com" },
  { name: "Cursor", domain: "cursor.com" },
  { name: "Notion", domain: "notion.so" },
  { name: "Slack", domain: "slack.com" },
  {
    name: "Gmail",
    domain: "mail.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_48dp.png",
  },
  {
    name: "Google Calendar",
    domain: "calendar.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/calendar_2020q4_48dp.png",
  },
  {
    name: "Google Drive",
    domain: "drive.google.com",
    iconUrl: "https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
  },
];

// Logo with the same fallback chain the Connections grid uses: explicit
// catalog icon → Google S2 favicon → DuckDuckGo → a lettered tile.
function SuiteToolLogo({ tool }: { tool: SuiteTool }) {
  const candidates: string[] = [];
  if (tool.iconUrl) candidates.push(tool.iconUrl);
  candidates.push(`https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(tool.domain)}`);
  candidates.push(`https://icons.duckduckgo.com/ip3/${tool.domain}.ico`);
  const [attempt, setAttempt] = useState(0);

  if (attempt >= candidates.length) {
    return (
      <span className="lkn-suite-tool-fallback" aria-hidden>
        {tool.name.charAt(0)}
      </span>
    );
  }
  return (
    <img
      key={attempt}
      src={candidates[attempt]}
      alt={`${tool.name} logo`}
      className="lkn-suite-tool-img"
      width={22}
      height={22}
      loading="lazy"
      onError={() => setAttempt((a) => a + 1)}
    />
  );
}

function FeatureSuite() {
  const { ref, seen } = useReveal<HTMLElement>("0px 0px -10% 0px");
  return (
    <section ref={ref} id="features" className="lkn-suite" aria-label="Built around you">
      <div className={`lkn-suite-head lkn-reveal ${seen ? "is-in" : ""}`}>
        <h2 className="lkn-suite-headline">The only assistant you'll ever need</h2>
        <p className="lkn-suite-sub">
          A suite of features that keep every AI grounded in you.
        </p>
      </div>

      <div className={`lkn-suite-grid lkn-reveal ${seen ? "is-in" : ""}`}>
        {SUITE_CARDS.map((card) => {
          const { Preview } = card;
          return (
            <article key={card.id} id={card.id} className="lkn-suite-card">
              <div className="lkn-suite-demo" aria-hidden>
                {seen ? <Preview /> : null}
              </div>
              <p className="lkn-suite-caption">
                <span className="lkn-suite-caption-lead">{card.lead}</span>{" "}
                {card.rest}
              </p>
            </article>
          );
        })}
      </div>

      <div className={`lkn-suite-tools lkn-reveal ${seen ? "is-in" : ""}`}>
        <p className="lkn-suite-tools-label">Works with everything you already use</p>
        <div className="lkn-suite-tools-row">
          {SUITE_TOOLS.map((tool) => (
            <span key={tool.name} className="lkn-suite-tool">
              <span className="lkn-suite-tool-icon" aria-hidden>
                <SuiteToolLogo tool={tool} />
              </span>
              {tool.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// Closing recap: a wrap-up of everything LYKN brings together, shown as a grid
// of feature pillars right before the final CTA. Styled for the light landing
// theme.
const RECAP_PILLARS: { icon: ComponentType<{ size?: number; strokeWidth?: number }>; title: string; desc: string }[] = [
  {
    icon: Sparkles,
    title: "Personal intelligence",
    desc: "Your beliefs, facts, concepts, and projects become connected neurons the AI reasons from.",
  },
  {
    icon: MessagesSquare,
    title: "Chat, every model",
    desc: "Switch between the best models from every lab, each grounded in your context.",
  },
  {
    icon: Mic,
    title: "Voice like Jarvis",
    desc: "Talk naturally and get answers out loud, hands-free, on any device.",
  },
  {
    icon: Bot,
    title: "Cloud agents",
    desc: "Hand off real work that keeps running after you close the app.",
  },
  {
    icon: Archive,
    title: "Vault",
    desc: "Your files, notes, and media, searchable and wired into everything.",
  },
  {
    icon: Plug,
    title: "Connections",
    desc: "Plug in the apps you already use so LYKN works with your whole stack.",
  },
  {
    icon: CalendarDays,
    title: "Calendar & to-dos",
    desc: "Plans and tasks the AI can see, add to, and act on.",
  },
  {
    icon: ShieldCheck,
    title: "Private & portable",
    desc: "Your data stays yours, in sync across web and mobile.",
  },
];

function LyknRecap() {
  const { ref, seen } = useReveal<HTMLElement>("0px 0px -10% 0px");
  return (
    <section ref={ref} id="recap" className="lkn-recap" aria-label="Everything LYKN brings together">
      <div className={`lkn-recap-head lkn-reveal ${seen ? "is-in" : ""}`}>
        <h2 className="lkn-section-headline">Everything LYKN brings together</h2>
        <p className="lkn-section-sub">
          One private intelligence layer behind every conversation, task, and
          tool, so the AI always works from who you are.
        </p>
      </div>
      <div className={`lkn-recap-grid lkn-reveal ${seen ? "is-in" : ""}`}>
        {RECAP_PILLARS.map((p) => {
          const Icon = p.icon;
          return (
            <article key={p.title} className="lkn-recap-card">
              <span className="lkn-recap-ico" aria-hidden>
                <Icon size={20} strokeWidth={1.9} />
              </span>
              <h3 className="lkn-recap-card-title">{p.title}</h3>
              <p className="lkn-recap-card-desc">{p.desc}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// Two-card showcase (chat + intelligence layer) shown side by side, each in a
// rounded color card with a heading, one-liner, and the real product preview
// sitting inside it.
function IntelligenceShowcase() {
  const { ref, seen } = useReveal<HTMLElement>("0px 0px -10% 0px");
  return (
    <section ref={ref} id="chat" className="lkn-duo" aria-label="Talk to your intelligence layer">
      <h2 className={`lkn-duo-headline lkn-reveal ${seen ? "is-in" : ""}`}>
        Talk to your intelligence layer
      </h2>
      <div className={`lkn-duo-grid lkn-reveal ${seen ? "is-in" : ""}`}>
        <article className="lkn-duo-card lkn-duo-card--light">
          <h3 className="lkn-duo-card-title">Every chat starts from you</h3>
          <p className="lkn-duo-card-sub">
            Every reply starts from your beliefs, facts, and files, not a default
            persona the model invents on the fly. Switch between the best models
            from every lab, all in one place.
          </p>
          <div className="lkn-duo-card-demo lkn-feature-demo--static" aria-hidden>
            <WakeChatSubwindow active={seen} lightMode />
          </div>
        </article>
        <article className="lkn-duo-card lkn-duo-card--light">
          <h3 className="lkn-duo-card-title">Talk to LYKN like Jarvis</h3>
          <p className="lkn-duo-card-sub">
            Speak naturally, get answers out loud, and hand long jobs to cloud
            agents that keep working after you close the app.
          </p>
          <div className="lkn-duo-card-demo">
            <WakeVoiceSubwindow active={seen} />
          </div>
        </article>
      </div>
    </section>
  );
}

// Centered, single-preview showcase for the intelligence (synthesis) layer:
// headline + one-liner over a large preview tucked into a soft blue panel.
function IntelligenceLayerShowcase() {
  const { ref, seen } = useReveal<HTMLElement>("0px 0px -10% 0px");
  return (
    <section ref={ref} id="memory" className="lkn-layer" aria-label="Intelligence Layer">
      <div className={`lkn-layer-head lkn-reveal ${seen ? "is-in" : ""}`}>
        <h2 className="lkn-section-headline">Personal Intelligence</h2>
        <p className="lkn-section-sub">
          Your beliefs, facts, concepts, and projects become connected neurons
          the AI reads and reasons from, so it works from who you are in every
          conversation and task.
        </p>
      </div>
      <div className={`lkn-layer-stage lkn-reveal ${seen ? "is-in" : ""}`}>
        <div className="lkn-layer-demo lkn-feature-demo--static" aria-hidden>
          <WakeSynthesisSubwindow active={seen} />
        </div>
      </div>
    </section>
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
        <h2 className="lkn-section-headline">AI was not made for you.</h2>
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
      <div className={`lkn-laptop lkn-reveal ${shown ? "is-in" : ""}`}>
        <div className="lkn-laptop-screen">
          <div className="lkn-laptop-cam" aria-hidden />
          <div className="lkn-laptop-display">
            <div className="lkn-showcase-noninteractive" aria-hidden>
              <WakePreviewFit designWidth={1180}>
                <WakeAppShellPreview active={false} />
              </WakePreviewFit>
            </div>
          </div>
        </div>
        <div className="lkn-laptop-base" aria-hidden>
          <div className="lkn-laptop-notch" />
        </div>

        {/* Phone mockup overlapping the laptop, running the voice agent. */}
        <div className="lkn-phone">
          <div className="lkn-phone-screen">
            <div className="lkn-phone-display">
              <WakePreviewFit designWidth={360} always>
                <div className="lkn-phone-canvas">
                  <WakeVoiceTourPreview active allowAudio={false} />
                </div>
              </WakePreviewFit>
            </div>
            <div className="lkn-phone-island" aria-hidden />
          </div>
        </div>
      </div>
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
      navigate("/app", { replace: true });
    }
  }, [authLoading, user, navigate, searchParams]);

  const goToSignup = useCallback(() => navigate("/login"), [navigate]);

  // Header is transparent (white logo + links) while resting over the blue
  // hero, then flips to a solid light bar once the visitor scrolls past it so
  // the white content stays legible over the light page sections.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 80);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToId = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="dark lkn-land">
      <header className={`lkn-header ${scrolled ? "is-scrolled" : ""}`}>
        <div className="lkn-header-inner">
          <button
            type="button"
            className="lkn-brand"
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            aria-label="LYKN home"
          >
            <img
              src={scrolled ? lyknLogo : lyknLogoWhite}
              alt="LYKN"
              className="lkn-brand-logo"
            />
          </button>

          <nav className="lkn-nav" aria-label="Primary">
            <button type="button" className="lkn-nav-link" onClick={() => scrollToId("product")}>
              Product
            </button>
            <button type="button" className="lkn-nav-link" onClick={() => navigate("/pricing")}>
              Pricing
            </button>
            <button type="button" className="lkn-nav-link" onClick={() => navigate("/mobile")}>
              Mobile
            </button>
            <div className="lkn-nav-auth">
              <button type="button" className="lkn-nav-signup" onClick={goToSignup}>
                Sign up
              </button>
              <button type="button" className="lkn-nav-signin" onClick={goToSignup}>
                Sign in
              </button>
            </div>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero — blue gradient backdrop; the app preview below pokes up into
            the bottom of it. */}
        <section className="lkn-hero" id="top">
          <div className="lkn-hero-inner">
            <h1 className="lkn-hero-headline">Stop starting over with AI.</h1>
            <p className="lkn-hero-sub">
              Persistent memory runs your projects, to-do lists, calendar, documents,
              <br />
              uploads, inspiration, and cloud agents in one place. Chat or talk to it
              <br />
              from any device, no download needed, private by design.
            </p>
            <div className="lkn-hero-actions">
              <button
                type="button"
                className="lkn-hero-btn lkn-hero-btn--light"
                onClick={goToSignup}
              >
                Sign up
              </button>
              <button
                type="button"
                className="lkn-hero-btn lkn-hero-btn--dark"
                onClick={goToSignup}
              >
                Sign in
              </button>
            </div>
          </div>
        </section>

        {/* Full app load-in — sits below the hero on black, its top poking up */}
        <AppLoadInShowcase />

        {/* The problem LYKN solves — problem/solution pairs */}
        <ProblemSolutions />

        {/* Chat + voice, presented as two side-by-side cards */}
        <IntelligenceShowcase />

        {/* Intelligence layer — centered single-preview showcase */}
        <IntelligenceLayerShowcase />

        {/* Three-card suite: Vault, Connections, Calendar/To-dos */}
        <FeatureSuite />

        {/* Wrap-up recap of everything LYKN brings together */}
        <LyknRecap />

        {/* Closing CTA / pricing */}
        <section className="lkn-final" id="pricing">
          <div className="lkn-final-inner lkn-reveal is-in">
            <div className="lkn-final-copy">
              <h2 className="lkn-final-headline">
                Personal AI built to know you.
                <span className="lkn-final-headline-sub">
                  Sign up and start in your browser today.
                </span>
              </h2>
              <button type="button" className="lkn-final-cta" onClick={goToSignup}>
                Get started
              </button>
            </div>
          </div>
        </section>
      </main>

      <footer className="lkn-footer">
        <div className="lkn-footer-inner lkn-footer-simple">
          <img src={lyknLogo} alt="LYKN" className="lkn-footer-logo" />
          <nav className="lkn-footer-nav" aria-label="Footer">
            <button type="button" onClick={() => navigate("/pricing")}>Pricing</button>
            <button type="button" onClick={() => navigate("/mobile")}>Mobile</button>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
            <a href="/cookies">Cookies</a>
          </nav>
          <p className="lkn-footer-copy">© {new Date().getFullYear()} LYKN</p>
        </div>
      </footer>
    </div>
  );
};

export default LandingPrototype;
