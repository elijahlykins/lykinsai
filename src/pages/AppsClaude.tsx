// ============================================================================
// AppsClaude — public landing page for the LYKN Claude Connector
// ============================================================================
// Lives at /apps/claude. Sister page to /apps/chatgpt. Two purposes:
//
//   1. SUBMISSION GATE for Anthropic's Connectors Directory. Anthropic's
//      reviewers will visit this page during directory review. They want
//      to see: a clear explanation of what the connector does, install
//      CTA, OAuth scopes matching the actual data we touch, and links
//      to /privacy and /terms. Every element below is keyed to the
//      pre-submission checklist published at
//      https://claude.com/docs/connectors/building/review-criteria.
//
//   2. CONVERSION SURFACE for users landing here from search, the
//      eventual directory listing, or our own marketing. The primary
//      CTA points at /connections#claude today (the one-click
//      prefill-modal flow that covers web / Desktop / mobile / Cowork),
//      and flips to the directory deep-link once Anthropic approves us.
//
// Visual idiom mirrors AppsChatGPT.tsx exactly so the two read as a
// matched set — same hero shape, same animation primitives, same
// sectional rhythm — only the copy and the install instructions diff.
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
  Globe,
} from "lucide-react";

// Public Connectors Directory URL placeholder. Once Anthropic approves
// the directory listing this becomes the real `https://claude.ai/...`
// URL and the primary CTA flips to it as the default. Until then the
// CTA shows as the existing one-button paste-URL flow on /connections.
const DIRECTORY_URL: string | null = null;

const tools = [
  {
    name: "lykn_getContextBlock",
    summary:
      "One-shot pull of your active beliefs, rules, and current project state — pasted into Claude's reasoning at the top of a chat.",
  },
  {
    name: "lykn_getBeliefs",
    summary:
      "Your ratified core principles (third-person, durable). Claude prefers these over generic best-practice when answering you.",
  },
  {
    name: "lykn_getRules",
    summary:
      "If-then conditions derived from your beliefs (\"if the user asks about pricing, lead with units\"). Cited back to the source belief.",
  },
  {
    name: "lykn_getFacts",
    summary:
      "Identity / preference / constraint facts Claude should treat as ground truth (e.g. \"works as a designer in Brooklyn\").",
  },
  {
    name: "lykn_getProjectState",
    summary:
      "The working memory of whatever you're currently building — accumulated by every other AI client you use, not just Claude.",
  },
  {
    name: "lykn_searchVault",
    summary:
      "Substring search across your saved notes, links, and attachments. Returns the raw items so Claude can reason over them.",
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
      "When Claude actually used one of your rules to shape its reply, it logs the citation here so you see the audit trail.",
  },
  {
    name: "lykn_setActiveProject",
    summary:
      "Switches which project Claude is contributing to, so its state pushes land in the right bucket.",
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
    body: "OAuth-issued bearers are stored as SHA-256 digests in LYKN's database. The plaintext leaves our server exactly once — to Claude. We can't read it back to recover access on your behalf, and a database leak doesn't expose live tokens.",
  },
  {
    icon: Clock,
    title: "Bearers expire in an hour",
    body: "Every access token Claude receives expires in 3,600 seconds. If you lose your laptop with Claude signed in, the worst-case window is 60 minutes (and you can revoke immediately from /connections).",
  },
  {
    icon: RefreshCw,
    title: "Refresh-token replay detection",
    body: "We rotate refresh tokens on every use. The instant a previously-consumed token is replayed, we revoke the entire token family — RFC 6749 §10.4 compliant.",
  },
  {
    icon: Shield,
    title: "You see the consent screen",
    body: "Claude can't connect silently. The very first time it tries to read your data, you see a LYKN-branded screen on lykn.io showing exactly what scopes are being granted, with Approve and Deny buttons.",
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

export default function AppsClaude() {
  const primaryCta = DIRECTORY_URL
    ? {
        label: "Install from Claude Directory",
        href: DIRECTORY_URL,
        external: true as const,
      }
    : {
        label: "Connect Claude to LYKN",
        href: "/connections#claude",
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
            Apps · Claude
          </div>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────────────── */}
      <section className="px-5 pt-16 pb-12 sm:pt-24 sm:pb-20">
        <div className="max-w-3xl mx-auto text-center">
          <AnimatedBlock>
            <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#D97757]/10 border border-[#D97757]/25 text-[10.5px] font-medium text-[#A85838] dark:text-[#E89478] uppercase tracking-wide mb-6">
              <Sparkles className="h-3 w-3" />
              Claude Connector
            </div>
          </AnimatedBlock>
          <AnimatedBlock delay={120}>
            <h1 className="text-[40px] sm:text-[56px] font-semibold tracking-[-0.02em] leading-[1.05]">
              Give Claude
              <br />
              <span className="text-black/55 dark:text-white/55">your context.</span>
            </h1>
          </AnimatedBlock>
          <AnimatedBlock delay={240}>
            <p className="mt-6 text-[16px] sm:text-[18px] leading-relaxed text-black/60 dark:text-white/65 max-w-xl mx-auto">
              LYKN is your synthesis layer — your ratified beliefs, rules, facts,
              vault, and live project state. Connect once and every Claude
              surface (web, Desktop, mobile, Cowork, Claude Code) reasons through
              what you actually believe instead of generic best-practice.
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
                href="https://claude.ai/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-black/15 dark:border-white/20 bg-white/60 dark:bg-zinc-900/60 px-5 py-3 text-[14px] font-medium text-black/80 dark:text-white/85 hover:bg-white dark:hover:bg-zinc-900 transition-colors"
              >
                Open Claude
              </a>
            </div>
            <p className="mt-4 text-[11.5px] text-black/45 dark:text-white/45">
              Works on Free and Pro — no Developer Mode toggle, no
              waitlist.{" "}
              {!DIRECTORY_URL && (
                <>
                  Directory listing pending Anthropic review; today the
                  Connect button drops you into the one-paste setup flow.
                </>
              )}
            </p>
          </AnimatedBlock>
        </div>
      </section>

      {/* ── What you get ────────────────────────────────────────────── */}
      <section className="px-5 pb-20">
        <div className="max-w-5xl mx-auto">
          <AnimatedBlock>
            <div className="text-center mb-12">
              <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
                What changes inside Claude
              </div>
              <h2 className="text-[28px] sm:text-[34px] font-semibold tracking-[-0.01em]">
                Claude stops asking you to repeat yourself.
              </h2>
            </div>
          </AnimatedBlock>
          <div className="grid md:grid-cols-3 gap-4">
            {[
              {
                icon: Brain,
                title: "Reasons through your beliefs",
                body: "Claude pulls your principles at the top of a chat and prefers them over generic best-practice. Answers get visibly more on-brand by message #2.",
              },
              {
                icon: Globe,
                title: "Works on every Claude surface",
                body: "Connect once on claude.ai and the same tools light up automatically in Claude Desktop, mobile, Cowork, and Claude Code. No per-app config.",
              },
              {
                icon: Layers,
                title: "Picks up the work in flight",
                body: "Every other AI client you use (ChatGPT, Cursor, Claude Code) has been pushing project state into LYKN. Claude inherits all of it.",
              },
              {
                icon: Zap,
                title: "Pushes back what it learns",
                body: "When you say something belief-shaped (\"I think X is non-negotiable\"), Claude proposes it back to LYKN — you ratify with one click.",
              },
              {
                icon: RefreshCw,
                title: "Read-write, with consent",
                body: "Claude can read your synthesis layer AND propose updates to it — but writes always land in your inbox to ratify, never silently active.",
              },
              {
                icon: Shield,
                title: "Revokable in one click",
                body: "Visit /connections any time and pull Claude's access. The session disconnects within seconds across every Claude surface.",
              },
            ].map((card, i) => (
              <AnimatedBlock key={card.title} delay={i * 80}>
                <div className="rounded-2xl border border-black/[0.08] dark:border-white/10 bg-white dark:bg-zinc-950 p-5 h-full">
                  <card.icon className="h-5 w-5 text-[#D97757] dark:text-[#E89478] mb-3" />
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

      {/* ── Tools the connector exposes ─────────────────────────────── */}
      <section className="px-5 pb-20 bg-black/[0.02] dark:bg-white/[0.02] py-16">
        <div className="max-w-4xl mx-auto">
          <AnimatedBlock>
            <div className="mb-8">
              <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
                The 11 tools Claude can call
              </div>
              <h2 className="text-[26px] sm:text-[30px] font-semibold tracking-[-0.01em]">
                Everything LYKN exposes, in one place.
              </h2>
              <p className="mt-2 text-[13px] text-black/55 dark:text-white/60 max-w-2xl">
                Read tools never modify your data. Write tools propose changes
                that you ratify in LYKN before they land. Each tool is annotated
                with <code className="text-[11px]">readOnlyHint</code> /{" "}
                <code className="text-[11px]">destructiveHint</code> per the
                MCP spec, so Claude knows which ones are safe to call without
                asking.
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
                The very first time Claude tries to call LYKN, you see a
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
                  <CheckCircle2 className="h-5 w-5 text-[#D97757] flex-shrink-0 mt-0.5" />
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
                Anthropic's Connectors flow speaks all of those natively
                (oauth_dcr) — we didn't invent anything.
              </p>
            </div>
          </AnimatedBlock>
          <div className="grid md:grid-cols-2 gap-4">
            {securityPoints.map((point, i) => (
              <AnimatedBlock key={point.title} delay={i * 80}>
                <div className="rounded-2xl border border-black/[0.08] dark:border-white/10 bg-white dark:bg-zinc-950 p-5 h-full">
                  <point.icon className="h-5 w-5 text-[#D97757] dark:text-[#E89478] mb-3" />
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
                {DIRECTORY_URL
                  ? "One click in Claude."
                  : "One paste, then it syncs everywhere."}
              </h2>
            </div>
          </AnimatedBlock>

          {DIRECTORY_URL ? (
            <AnimatedBlock delay={100}>
              <ol className="space-y-3 text-[13px] leading-relaxed text-black/70 dark:text-white/75">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-black text-white dark:bg-white dark:text-black text-[11px] font-semibold inline-flex items-center justify-center">
                    1
                  </span>
                  <span>
                    Click <strong>Install from Claude Directory</strong> above.
                    Anthropic's directory page opens in a new tab.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-black text-white dark:bg-white dark:text-black text-[11px] font-semibold inline-flex items-center justify-center">
                    2
                  </span>
                  <span>
                    Click <strong>Connect</strong> in Claude. A LYKN consent
                    screen pops up — Approve.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-black text-white dark:bg-white dark:text-black text-[11px] font-semibold inline-flex items-center justify-center">
                    3
                  </span>
                  <span>
                    Open any chat → <strong>+</strong> → <strong>LYKN</strong>{" "}
                    → ask whatever you want. Claude (and every other Claude
                    surface you sign into) now reasons through your synthesis
                    layer.
                  </span>
                </li>
              </ol>
            </AnimatedBlock>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              <AnimatedBlock delay={100}>
                <div className="rounded-2xl border-2 border-[#D97757]/40 bg-[#D97757]/[0.05] dark:bg-[#D97757]/[0.08] p-5 h-full">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-[#A85838] dark:text-[#E89478] bg-[#D97757]/15 px-2 py-0.5 rounded-full">
                      Available now
                    </span>
                  </div>
                  <h3 className="text-[15px] font-semibold tracking-tight mb-1">
                    Add as a custom connector
                  </h3>
                  <p className="text-[12.5px] text-black/60 dark:text-white/65 leading-relaxed mb-4">
                    Free and Pro are both eligible — no Developer Mode toggle.
                    We'll copy the URL, deep-link you into{" "}
                    <strong>Settings → Connectors</strong>, and the connection
                    auto-syncs to Desktop, mobile, Cowork, and Claude Code.
                  </p>
                  <Link
                    to="/connections#claude"
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#C5654A] hover:bg-[#B85841] dark:bg-[#D97757] dark:hover:bg-[#C5654A] text-white px-4 py-2 text-[12.5px] font-semibold transition-colors w-full"
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
                    Anthropic Connectors Directory
                  </h3>
                  <p className="text-[12.5px] text-black/60 dark:text-white/65 leading-relaxed mb-4">
                    One-click install from Claude's built-in Directory — no
                    URL paste, no setup. Pending Anthropic review.
                  </p>
                  <a
                    href="https://claude.com/docs/connectors/directory"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-2 rounded-xl border border-black/15 dark:border-white/20 bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] px-4 py-2 text-[12.5px] font-medium text-black/65 dark:text-white/65 w-full transition-colors"
                  >
                    See Anthropic's directory
                  </a>
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
            <Link to="/why" className="hover:text-black/85 dark:hover:text-white/85">
              Why LYKN
            </Link>
            <Link to="/apps/chatgpt" className="hover:text-black/85 dark:hover:text-white/85">
              ChatGPT App
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
