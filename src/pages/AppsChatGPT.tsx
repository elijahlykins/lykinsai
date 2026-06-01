// ============================================================================
// AppsChatGPT — public landing page for the LYKN ChatGPT App
// ============================================================================
// Lives at /apps/chatgpt. Two purposes:
//
//   1. SUBMISSION GATE for OpenAI's ChatGPT Apps catalog. OpenAI's reviewers
//      will visit this page during app review. They want to see: a clear
//      explanation of what the app does, a direct install CTA, the data
//      it accesses (matching the OAuth scopes), and links to /privacy
//      and /terms. Every element below is keyed to the review checklist
//      published in the Apps SDK developer docs.
//
//   2. CONVERSION SURFACE for users who land here from search, Twitter,
//      or the eventual catalog listing itself. The primary CTA splits
//      into two paths because the audience does:
//        • Pro/Team/Enterprise users today → "Connect ChatGPT" deep-link
//          into the existing /connections flow (Developer Mode path).
//        • Everyone else → "Install from ChatGPT App Store" placeholder
//          that flips to a real catalog URL once the review lands.
//
// Visual idiom mirrors the wake landing — generous spacing,
// tracking-tight headings, light/dark parity, intersection-observer fade-ins
// so the page feels intentional rather than a spec sheet.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Shield,
  CheckCircle2,
  Zap,
  Lock,
  Clock,
  Brain,
  Layers,
  RefreshCw,
} from "lucide-react";

// Public catalog URL placeholder. Once the Apps catalog listing is live
// this becomes the real URL OpenAI assigns and the primary CTA flips
// to it as the default. While null, the CTA shows as "coming soon" and
// the Developer-Mode path is promoted instead.
const APPS_CATALOG_URL: string | null = null;

const tools = [
  {
    name: "lykn_getContextBlock",
    summary:
      "One-shot pull of your active beliefs, rules, and current project state — pasted into ChatGPT's reasoning at the top of a chat.",
  },
  {
    name: "lykn_getBeliefs",
    summary:
      "Your ratified core principles (third-person, durable). ChatGPT prefers these over generic best-practice when answering you.",
  },
  {
    name: "lykn_getRules",
    summary:
      "If-then conditions derived from your beliefs (\"if the user asks about pricing, lead with units\"). Cited back to the source belief.",
  },
  {
    name: "lykn_getFacts",
    summary:
      "Identity / preference / constraint facts ChatGPT should treat as ground truth (e.g. \"works as a designer in Brooklyn\").",
  },
  {
    name: "lykn_getProjectState",
    summary:
      "The working memory of whatever you're currently building — accumulated by every other AI client you use, not just ChatGPT.",
  },
  {
    name: "lykn_searchVault",
    summary:
      "Substring search across your saved notes, links, and attachments. Returns the raw items so ChatGPT can reason over them.",
  },
  {
    name: "lykn_proposeBelief",
    summary:
      "Suggests a new belief based on the conversation. Lands in your LYKN inbox to ratify — never auto-promoted.",
  },
  {
    name: "lykn_proposeFact",
    summary:
      "Records a new identity / preference / constraint fact. Same review-before-active flow as beliefs.",
  },
  {
    name: "lykn_pushProjectState",
    summary:
      "Updates your active project's working memory so the next AI client picks up where this one left off.",
  },
  {
    name: "lykn_recordRuleApplication",
    summary:
      "When ChatGPT actually used one of your rules to shape its reply, it logs the citation here so you see the audit trail.",
  },
  {
    name: "lykn_setActiveProject",
    summary:
      "Switches which project ChatGPT is contributing to, so its state pushes land in the right bucket.",
  },
];

const scopes = [
  {
    id: "lykn:read",
    title: "Read",
    description:
      "Beliefs, rules, facts, vault items, and active project state. Read-only — never modifies anything.",
  },
  {
    id: "lykn:write",
    title: "Propose & update",
    description:
      "Propose new beliefs and facts (you ratify before they go live), and push state updates to your active project.",
  },
  {
    id: "offline_access",
    title: "Stay connected",
    description:
      "A short-lived bearer token plus a rotating refresh token, so you don't re-approve every hour.",
  },
];

const securityPoints = [
  {
    icon: Lock,
    title: "Tokens hashed at rest",
    body: "OAuth-issued bearers are stored as SHA-256 digests in LYKN's database. The plaintext leaves our server exactly once — to ChatGPT. We can't read it back to recover access on your behalf, and a database leak doesn't expose live tokens.",
  },
  {
    icon: Clock,
    title: "Bearers expire in an hour",
    body: "Every access token ChatGPT receives expires in 3,600 seconds. If you lose your laptop with ChatGPT signed in, the worst-case window is 60 minutes (and you can revoke immediately from /connections).",
  },
  {
    icon: RefreshCw,
    title: "Refresh-token replay detection",
    body: "We rotate refresh tokens on every use. The instant a previously-consumed token is replayed, we revoke the entire token family — RFC 6749 §10.4 compliant.",
  },
  {
    icon: Shield,
    title: "You see the consent screen",
    body: "ChatGPT can't connect silently. The very first time it tries to read your data, you see a LYKN-branded screen on lykn.io showing exactly what scopes are being granted, with Approve and Deny buttons.",
  },
];

const AnimatedBlock = ({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setVisible(true), delay);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className="transition-all duration-700 ease-out"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(20px)",
        filter: visible ? "blur(0)" : "blur(3px)",
      }}
    >
      {children}
    </div>
  );
};

export default function AppsChatGPT() {
  const primaryCta = APPS_CATALOG_URL
    ? {
        label: "Install from ChatGPT",
        href: APPS_CATALOG_URL,
        external: true as const,
      }
    : {
        label: "Connect ChatGPT to LYKN",
        href: "/connections#chatgpt",
        external: false as const,
      };

  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-50 to-white dark:from-zinc-950 dark:to-zinc-900 text-black/90 dark:text-white/90">
      {/* ── Top nav ─────────────────────────────────────────────────── */}
      <nav className="sticky top-0 z-30 backdrop-blur-md bg-white/70 dark:bg-zinc-950/70 border-b border-black/[0.06] dark:border-white/[0.06]">
        <div className="max-w-5xl mx-auto px-5 py-3 flex items-center justify-between">
          <Link
            to="/"
            className="text-[13px] font-semibold tracking-tight inline-flex items-center gap-1.5 hover:opacity-80 transition-opacity"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            LYKN
          </Link>
          <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45">
            Apps · ChatGPT
          </div>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section className="px-5 pt-16 pb-12 sm:pt-24 sm:pb-20">
        <div className="max-w-3xl mx-auto text-center">
          <AnimatedBlock>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-[10.5px] font-medium text-emerald-700 dark:text-emerald-300 uppercase tracking-wide mb-6">
              <Sparkles className="h-3 w-3" />
              ChatGPT App
            </div>
          </AnimatedBlock>
          <AnimatedBlock delay={120}>
            <h1 className="text-[40px] sm:text-[56px] font-semibold tracking-[-0.02em] leading-[1.05]">
              Give ChatGPT
              <br />
              <span className="text-black/55 dark:text-white/55">your context.</span>
            </h1>
          </AnimatedBlock>
          <AnimatedBlock delay={240}>
            <p className="mt-6 text-[16px] sm:text-[18px] leading-relaxed text-black/60 dark:text-white/65 max-w-xl mx-auto">
              LYKN is your synthesis layer — your ratified beliefs, rules, facts,
              vault, and live project state. Connect it to ChatGPT and every
              answer reasons through what you actually believe instead of
              generic best-practice.
            </p>
          </AnimatedBlock>
          <AnimatedBlock delay={360}>
            <div className="mt-9 flex flex-col sm:flex-row gap-3 justify-center">
              {primaryCta.external ? (
                <a
                  href={primaryCta.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-black text-white dark:bg-white dark:text-black px-5 py-3 text-[14px] font-semibold hover:opacity-90 transition-opacity"
                >
                  {primaryCta.label}
                  <ArrowRight className="h-4 w-4" />
                </a>
              ) : (
                <Link
                  to={primaryCta.href}
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-black text-white dark:bg-white dark:text-black px-5 py-3 text-[14px] font-semibold hover:opacity-90 transition-opacity"
                >
                  {primaryCta.label}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              )}
              <a
                href="https://chatgpt.com/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-black/15 dark:border-white/20 bg-white/60 dark:bg-zinc-900/60 px-5 py-3 text-[14px] font-medium text-black/80 dark:text-white/85 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
              >
                Open ChatGPT
              </a>
            </div>
            {!APPS_CATALOG_URL && (
              <p className="mt-4 text-[11.5px] text-black/45 dark:text-white/45">
                Public catalog listing pending OpenAI review. Connect today via{" "}
                <span className="font-medium text-black/65 dark:text-white/65">
                  Settings → Apps &amp; Connectors → Developer Mode
                </span>{" "}
                (ChatGPT Pro / Team / Enterprise).
              </p>
            )}
          </AnimatedBlock>
        </div>
      </section>

      {/* ── What you get ────────────────────────────────────────────── */}
      <section className="px-5 pb-20">
        <div className="max-w-5xl mx-auto">
          <AnimatedBlock>
            <div className="text-center mb-12">
              <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
                What changes inside ChatGPT
              </div>
              <h2 className="text-[28px] sm:text-[34px] font-semibold tracking-[-0.01em]">
                ChatGPT stops talking past you.
              </h2>
            </div>
          </AnimatedBlock>
          <div className="grid md:grid-cols-3 gap-4">
            {[
              {
                icon: Brain,
                title: "Reasons through your beliefs",
                body: "ChatGPT pulls your principles at the top of a chat and prefers them over generic best-practice. Answers get visibly more on-brand by message #2.",
              },
              {
                icon: Layers,
                title: "Picks up the work in flight",
                body: "Every other AI client you use (Claude, Cursor, Claude Code) has been pushing project state into LYKN. ChatGPT inherits all of it.",
              },
              {
                icon: Zap,
                title: "Pushes back what it learns",
                body: "When you say something belief-shaped (\"I think X is non-negotiable\"), ChatGPT proposes it back to LYKN — you ratify with one click.",
              },
            ].map((card, i) => (
              <AnimatedBlock key={card.title} delay={i * 100}>
                <div className="rounded-2xl border border-black/[0.08] dark:border-white/10 bg-white dark:bg-zinc-950 p-5 h-full">
                  <card.icon className="h-5 w-5 text-emerald-600 dark:text-emerald-400 mb-3" />
                  <h3 className="text-[15px] font-semibold tracking-tight mb-1.5">
                    {card.title}
                  </h3>
                  <p className="text-[13px] leading-relaxed text-black/60 dark:text-white/65">
                    {card.body}
                  </p>
                </div>
              </AnimatedBlock>
            ))}
          </div>
        </div>
      </section>

      {/* ── Tools the app exposes ───────────────────────────────────── */}
      <section className="px-5 pb-20 bg-black/[0.02] dark:bg-white/[0.02] py-16">
        <div className="max-w-4xl mx-auto">
          <AnimatedBlock>
            <div className="mb-8">
              <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
                The 11 tools ChatGPT can call
              </div>
              <h2 className="text-[26px] sm:text-[30px] font-semibold tracking-[-0.01em]">
                Everything LYKN exposes, in one place.
              </h2>
              <p className="mt-2 text-[13px] text-black/55 dark:text-white/60 max-w-2xl">
                Read tools never modify your data. Write tools propose changes
                that you ratify in LYKN before they land. ChatGPT sees the same
                tool list any other MCP client does — no special access.
              </p>
            </div>
          </AnimatedBlock>
          <AnimatedBlock delay={120}>
            <div className="rounded-2xl border border-black/[0.08] dark:border-white/10 bg-white dark:bg-zinc-950 overflow-hidden">
              <table className="w-full text-[12.5px]">
                <tbody>
                  {tools.map((tool, i) => (
                    <tr
                      key={tool.name}
                      className={
                        i !== 0
                          ? "border-t border-black/[0.05] dark:border-white/[0.06]"
                          : ""
                      }
                    >
                      <td className="px-4 py-3 align-top whitespace-nowrap font-mono text-[11.5px] text-black/85 dark:text-white/85 w-[210px]">
                        {tool.name}
                      </td>
                      <td className="px-4 py-3 align-top text-black/65 dark:text-white/70 leading-relaxed">
                        {tool.summary}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </AnimatedBlock>
        </div>
      </section>

      {/* ── Permissions / scopes ────────────────────────────────────── */}
      <section className="px-5 pb-20 pt-16">
        <div className="max-w-4xl mx-auto">
          <AnimatedBlock>
            <div className="mb-8">
              <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
                What you're approving
              </div>
              <h2 className="text-[26px] sm:text-[30px] font-semibold tracking-[-0.01em]">
                Three OAuth scopes. Plain English.
              </h2>
              <p className="mt-2 text-[13px] text-black/55 dark:text-white/60 max-w-2xl">
                The very first time ChatGPT tries to call LYKN, you see a
                consent screen on lykn.io showing exactly these scopes. You
                can revoke any of them later from{" "}
                <Link
                  to="/connections"
                  className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
                >
                  Connections
                </Link>
                .
              </p>
            </div>
          </AnimatedBlock>
          <div className="space-y-3">
            {scopes.map((scope, i) => (
              <AnimatedBlock key={scope.id} delay={i * 80}>
                <div className="rounded-xl border border-black/[0.08] dark:border-white/10 bg-white dark:bg-zinc-950 p-4 flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <h3 className="text-[14px] font-semibold tracking-tight">
                        {scope.title}
                      </h3>
                      <code className="text-[11px] font-mono text-black/55 dark:text-white/55">
                        {scope.id}
                      </code>
                    </div>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-black/65 dark:text-white/70">
                      {scope.description}
                    </p>
                  </div>
                </div>
              </AnimatedBlock>
            ))}
          </div>
        </div>
      </section>

      {/* ── Security model ──────────────────────────────────────────── */}
      <section className="px-5 pb-20 bg-black/[0.02] dark:bg-white/[0.02] py-16">
        <div className="max-w-4xl mx-auto">
          <AnimatedBlock>
            <div className="mb-10">
              <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
                Security
              </div>
              <h2 className="text-[26px] sm:text-[30px] font-semibold tracking-[-0.01em]">
                Standard OAuth 2.1, no shortcuts.
              </h2>
              <p className="mt-2 text-[13px] text-black/55 dark:text-white/60 max-w-2xl">
                LYKN is a fully-spec'd OAuth 2.1 identity provider with PKCE
                (S256), Dynamic Client Registration (RFC 7591), Token
                Revocation (RFC 7009), and Token Introspection (RFC 7662).
                ChatGPT speaks all of those — we didn't invent anything.
              </p>
            </div>
          </AnimatedBlock>
          <div className="grid md:grid-cols-2 gap-4">
            {securityPoints.map((point, i) => (
              <AnimatedBlock key={point.title} delay={i * 80}>
                <div className="rounded-2xl border border-black/[0.08] dark:border-white/10 bg-white dark:bg-zinc-950 p-5 h-full">
                  <point.icon className="h-5 w-5 text-emerald-600 dark:text-emerald-400 mb-3" />
                  <h3 className="text-[14px] font-semibold tracking-tight mb-1.5">
                    {point.title}
                  </h3>
                  <p className="text-[12.5px] leading-relaxed text-black/60 dark:text-white/65">
                    {point.body}
                  </p>
                </div>
              </AnimatedBlock>
            ))}
          </div>
        </div>
      </section>

      {/* ── Install instructions ────────────────────────────────────── */}
      <section className="px-5 pb-20 pt-16">
        <div className="max-w-3xl mx-auto">
          <AnimatedBlock>
            <div className="mb-8">
              <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
                Install in 60 seconds
              </div>
              <h2 className="text-[26px] sm:text-[30px] font-semibold tracking-[-0.01em]">
                {APPS_CATALOG_URL
                  ? "One click in ChatGPT."
                  : "Two paths today, one path soon."}
              </h2>
            </div>
          </AnimatedBlock>

          {APPS_CATALOG_URL ? (
            <AnimatedBlock delay={100}>
              <ol className="space-y-3 text-[13px] leading-relaxed text-black/70 dark:text-white/75">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-black text-white dark:bg-white dark:text-black text-[11px] font-semibold inline-flex items-center justify-center">
                    1
                  </span>
                  <span>
                    Click <strong>Install from ChatGPT</strong> above. The
                    catalog page opens in a new tab.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-black text-white dark:bg-white dark:text-black text-[11px] font-semibold inline-flex items-center justify-center">
                    2
                  </span>
                  <span>
                    In ChatGPT, click <strong>Install</strong>. A LYKN consent
                    screen pops up — Approve.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-black text-white dark:bg-white dark:text-black text-[11px] font-semibold inline-flex items-center justify-center">
                    3
                  </span>
                  <span>
                    Open any chat → <strong>+</strong> → <strong>LYKN</strong>{" "}
                    → ask whatever you want. ChatGPT now reasons through your
                    synthesis layer.
                  </span>
                </li>
              </ol>
            </AnimatedBlock>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              <AnimatedBlock delay={100}>
                <div className="rounded-2xl border-2 border-emerald-500/30 bg-emerald-500/[0.04] dark:bg-emerald-500/[0.06] p-5 h-full">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300 bg-emerald-500/10 px-2 py-0.5 rounded-full">
                      Available now
                    </span>
                  </div>
                  <h3 className="text-[15px] font-semibold tracking-tight mb-1">
                    Connect via Developer Mode
                  </h3>
                  <p className="text-[12.5px] text-black/60 dark:text-white/65 leading-relaxed mb-4">
                    Requires ChatGPT Pro, Team, or Enterprise. Toggle Developer
                    Mode in ChatGPT settings and we'll walk you through the
                    rest from <Link to="/connections" className="underline underline-offset-2">your Connections page</Link>.
                  </p>
                  <Link
                    to="/connections#chatgpt"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-600/90 dark:bg-emerald-500 dark:hover:bg-emerald-500/90 text-white px-4 py-2 text-[12.5px] font-semibold transition-colors w-full"
                  >
                    Open Connections
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </AnimatedBlock>
              <AnimatedBlock delay={180}>
                <div className="rounded-2xl border border-black/[0.08] dark:border-white/10 bg-white dark:bg-zinc-950 p-5 h-full">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-black/55 dark:text-white/55 bg-black/[0.04] dark:bg-white/[0.05] px-2 py-0.5 rounded-full">
                      Coming soon
                    </span>
                  </div>
                  <h3 className="text-[15px] font-semibold tracking-tight mb-1">
                    Install from ChatGPT App Store
                  </h3>
                  <p className="text-[12.5px] text-black/60 dark:text-white/65 leading-relaxed mb-4">
                    One click. No Developer Mode. Available on every ChatGPT
                    plan including Free. Pending OpenAI review.
                  </p>
                  <button
                    type="button"
                    disabled
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-black/15 dark:border-white/20 bg-black/[0.03] dark:bg-white/[0.04] px-4 py-2 text-[12.5px] font-medium text-black/45 dark:text-white/40 w-full cursor-not-allowed"
                  >
                    Notify me when it's live
                  </button>
                </div>
              </AnimatedBlock>
            </div>
          )}
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="px-5 py-10 border-t border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.02]">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between text-[11.5px] text-black/55 dark:text-white/55">
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-amber-500" />
            <span className="font-semibold text-black/75 dark:text-white/75">LYKN</span>
            <span>· The synthesis layer.</span>
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            <Link to="/" className="hover:text-black/85 dark:hover:text-white/85">
              Home
            </Link>
            <Link to="/" className="hover:text-black/85 dark:hover:text-white/85">
              Why LYKN
            </Link>
            <Link to="/privacy" className="hover:text-black/85 dark:hover:text-white/85">
              Privacy
            </Link>
            <Link to="/terms" className="hover:text-black/85 dark:hover:text-white/85">
              Terms
            </Link>
            <Link to="/cookies" className="hover:text-black/85 dark:hover:text-white/85">
              Cookies
            </Link>
            <Link to="/dpa" className="hover:text-black/85 dark:hover:text-white/85">
              DPA
            </Link>
            <a
              href="mailto:hello@lykn.io"
              className="hover:text-black/85 dark:hover:text-white/85"
            >
              Contact
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
