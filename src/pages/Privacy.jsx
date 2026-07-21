// ============================================================================
// Privacy, public privacy policy at /privacy
// ============================================================================
// Required by:
//   • Apple / Google app review (eventual mobile)
//   • OpenAI ChatGPT Apps catalog submission
//   • Stripe Connect onboarding (if billing-side scope expands)
//   • EU residents under GDPR Article 13/14
//
// Tone: plain English, structurally faithful to the GDPR/CCPA categories
// reviewers look for, but not so legalese it stops being read. The
// ChatGPT Connector section near the bottom is what OpenAI specifically
// reviews for app submissions, it must explicitly address what the
// connecting client sees vs. what stays inside LYKN.
//
// Last updated: keep the date at the top in sync with material changes
// (new third-party processors, new data categories, new retention rules).
// Trivial copy edits don't bump it.
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const LAST_UPDATED = "May 11, 2026";

export default function Privacy() {
  return (
    <main className="min-h-screen bg-white dark:bg-zinc-950 text-black/90 dark:text-white/90">
      <nav className="sticky top-0 z-30 backdrop-blur-md bg-white/70 dark:bg-zinc-950/70 border-b border-black/[0.06] dark:border-white/[0.06]">
        <div className="max-w-3xl mx-auto px-5 py-3 flex items-center justify-between">
          <Link
            to="/"
            className="text-[13px] font-semibold tracking-tight inline-flex items-center gap-1.5 hover:opacity-80 transition-opacity"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            LYKN
          </Link>
          <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45">
            Privacy Policy
          </div>
        </div>
      </nav>

      <article className="max-w-2xl mx-auto px-5 py-16 prose-style space-y-8">
        <header>
          <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
            Effective {LAST_UPDATED}
          </div>
          <h1 className="text-[40px] font-semibold tracking-[-0.02em] leading-[1.05]">
            Privacy Policy
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-black/65 dark:text-white/70">
            LYKN is a personal synthesis layer, your beliefs, rules, facts,
            project state, and vault, surfaced to you and to the AI tools you
            connect. This policy explains exactly what we collect, why,
            who else sees it, and how to make it disappear.
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-black/55 dark:text-white/60">
            The data controller for the purposes of GDPR and CCPA is{" "}
            <strong>Omnia Technologies LLC</strong>, the company that operates
            LYKN. Contact us at{" "}
            <a
              href="mailto:privacy@lykn.io"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              privacy@lykn.io
            </a>
            . Browser-side storage (localStorage, sessionStorage, IndexedDB)
            is documented separately in our{" "}
            <Link
              to="/cookies"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Cookie Policy
            </Link>
            . Customers routing personal data of EU/UK data subjects through
            LYKN as a controller should also read our{" "}
            <Link
              to="/dpa"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Data Processing Agreement
            </Link>
            .
          </p>
        </header>

        <Section title="The short version" anchor="tldr">
          <ul className="space-y-2">
            <Bullet>
              Your account email, your synthesis content (beliefs, facts,
              rules, project state, vault items), and minimal usage telemetry
              are stored in our database (Supabase, hosted in the US).
            </Bullet>
            <Bullet>
              We never sell your data. We do not show ads. We do not train any
              model on your content.
            </Bullet>
            <Bullet>
              When you connect ChatGPT, Claude, Cursor, or another AI tool, we
              show you exactly what that tool will see and require your explicit
              consent before issuing any access token.
            </Bullet>
            <Bullet>
              You can export everything and delete your account from{" "}
              <Link
                to="/settings"
                className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
              >
                Settings
              </Link>{" "}
              at any time. Deletion is a hard delete, not a soft-flag.
            </Bullet>
          </ul>
        </Section>

        <Section title="What we collect" anchor="data">
          <h3 className="text-[15px] font-semibold tracking-tight mt-4 mb-1">
            Account data
          </h3>
          <p>
            Email address, the OAuth provider you signed up through (Google,
            Apple, etc.), and a Supabase-issued user ID. We don't ask for
            phone numbers, names, or addresses.
          </p>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            Your synthesis content
          </h3>
          <p>
            Everything you save, propose, or ratify in LYKN: vault items
            (notes, links, files), beliefs, rules, facts, project definitions
            and project state, conversation transcripts within the app,
            and any AI-generated summaries derived from those. This is the
            content the synthesis layer is.
          </p>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            Usage telemetry
          </h3>
          <p>
            Sparse server-side logs of API calls (which endpoint, response
            time, status code, your user ID), MCP tool invocation counts and
            tool names (so the Connections page can show you "Claude Desktop
            called <code>getBeliefs</code> 14 times today"), and OAuth client
            metadata for connected AI tools (client name, scopes, last-used
            timestamp). No third-party analytics, we use server logs only.
            The iOS app additionally forwards Apple MetricKit diagnostics
            (crash reports, hang and performance summaries — never message or
            vault content) to our own servers, associated with your account so
            we can investigate issues you report; these are deleted with your
            account.
          </p>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            What we don't collect
          </h3>
          <ul className="space-y-2 mt-2">
            <Bullet>No advertising IDs, fingerprints, or cross-site trackers.</Bullet>
            <Bullet>No keystroke logs, screen recordings, or session replays.</Bullet>
            <Bullet>
              No location beyond approximate IP geolocation derived from server
              logs (used for rate-limiting and abuse detection only, not stored
              against your account).
            </Bullet>
            <Bullet>
              No payment-card numbers, Stripe holds those if billing applies
              to your plan.
            </Bullet>
          </ul>
        </Section>

        <Section title="How we use your data" anchor="usage">
          <p>
            Strictly to operate the product:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>Authenticate you and serve the LYKN app.</Bullet>
            <Bullet>
              Power the synthesis pipeline, extracting beliefs, facts, and
              rules from your vault and conversations.
            </Bullet>
            <Bullet>
              Surface your synthesis content to AI tools you have explicitly
              connected via OAuth or personal-access tokens.
            </Bullet>
            <Bullet>
              Send transactional email (sign-in, account changes, billing
              receipts). No marketing email without separate opt-in.
            </Bullet>
            <Bullet>Detect and prevent abuse, spam, and quota overruns.</Bullet>
          </ul>
          <p className="mt-3">
            <strong>We do not</strong> train any AI model on your content. We
            do not aggregate your data into any cross-user dataset. We do not
            sell, rent, or trade your data.
          </p>
        </Section>

        <Section title="ChatGPT, Claude, Cursor, and other connected AI tools" anchor="connectors">
          <p>
            When you press <strong>Connect</strong> on a card in your{" "}
            <Link
              to="/connections"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Connections
            </Link>{" "}
            page, LYKN issues a scoped, time-limited access token that the
            connecting AI tool uses to call our MCP and REST endpoints on
            your behalf.
          </p>
          <p className="mt-3">
            <strong>What the connected tool sees:</strong> only the data
            returned by the specific MCP tools listed on{" "}
            <Link
              to="/apps/chatgpt"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              /apps/chatgpt
            </Link>
            : your active beliefs, rules, facts, vault search results, project
            state, and any context blocks you request. Read-only by default;
            write tools (propose belief / propose fact / push project state)
            create draft entries you ratify before they go live.
          </p>
          <p className="mt-3">
            <strong>What the connected tool does NOT see:</strong> your email,
            your raw conversation transcripts inside LYKN, your billing details,
            tokens issued to other tools, or any data from other LYKN users.
            Once the data leaves LYKN's servers, it is governed by the
            connecting tool's own privacy policy (e.g.{" "}
            <a
              href="https://openai.com/policies/privacy-policy/"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              OpenAI's
            </a>
            ,{" "}
            <a
              href="https://www.anthropic.com/legal/privacy"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Anthropic's
            </a>
            ).
          </p>
          <p className="mt-3">
            <strong>Revocation</strong> is one click from the Connected Clients
            list on /connections. Revocation is immediate, the next API call
            from the revoked tool returns 401 unauthorized within seconds.
            Refresh-token rotation with replay detection (RFC 6749 §10.4) means
            a leaked refresh token revokes the entire token family the moment
            it is reused.
          </p>
        </Section>

        <Section title="Where your data lives" anchor="processors">
          <p>
            We use the following sub-processors. Each receives the minimum data
            needed to function:
          </p>
          <table className="w-full text-[12.5px] mt-4 border-collapse">
            <thead>
              <tr className="border-b border-black/[0.08] dark:border-white/[0.1]">
                <th className="text-left py-2 pr-4 font-semibold">Processor</th>
                <th className="text-left py-2 pr-4 font-semibold">Purpose</th>
                <th className="text-left py-2 font-semibold">Region</th>
              </tr>
            </thead>
            <tbody className="text-black/65 dark:text-white/70">
              <Row p="Supabase" purpose="Postgres database, auth, file storage" region="US-East" />
              <Row p="Render" purpose="Backend hosting (Express server, cron jobs)" region="US-East" />
              <Row p="Vercel" purpose="Frontend hosting (the lykn.io SPA)" region="Global edge" />
              <Row p="Anthropic" purpose="LLM inference for synthesis (when you opt in to Claude tiers)" region="US" />
              <Row p="OpenAI" purpose="LLM inference for synthesis (when you opt in to GPT tiers); embeddings; Voice Mode — live microphone audio and conversation context stream to OpenAI's Realtime API during a Voice Mode session in the iOS app" region="US" />
              <Row p="Resend" purpose="Transactional email (sign-in links, account changes)" region="US" />
              <Row p="Stripe" purpose="Billing (paid plans only; we never see card numbers)" region="US" />
            </tbody>
          </table>
        </Section>

        <Section title="Retention and deletion" anchor="retention">
          <p>
            Account data and synthesis content live in our database for as
            long as your account is active. When you delete your account from{" "}
            <Link
              to="/settings"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Settings
            </Link>
            , we hard-delete:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>Your row in the users table.</Bullet>
            <Bullet>All vault items, beliefs, rules, facts, project state.</Bullet>
            <Bullet>
              All issued PATs and OAuth bearer/refresh tokens (their hashes
              + the OAuth client/consent rows that mint them).
            </Bullet>
            <Bullet>All synthesis run records and any cached embeddings.</Bullet>
          </ul>
          <p className="mt-3">
            Server-side request logs are kept for up to 30 days for
            abuse-detection purposes and then rotated out. They contain only
            your user ID, endpoint, and status code, never request bodies.
          </p>
          <p className="mt-3">
            Backups are encrypted at rest with separate keys and retained for
            up to 7 days from the night they were taken; deleted accounts are
            purged from the next backup cycle.
          </p>
        </Section>

        <Section title="Your rights" anchor="rights">
          <p>
            Wherever you live, you have these rights with respect to your
            LYKN data:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              <strong>Access:</strong> see everything we hold about you, via
              the in-app vault/synthesis views and the export endpoint.
            </Bullet>
            <Bullet>
              <strong>Portability:</strong> export your synthesis content as
              JSON from Settings.
            </Bullet>
            <Bullet>
              <strong>Correction:</strong> edit any belief, fact, rule, or
              vault item directly in the app.
            </Bullet>
            <Bullet>
              <strong>Deletion:</strong> delete your account from Settings.
              We'll also honor email requests to{" "}
              <a
                href="mailto:privacy@lykn.io"
                className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
              >
                privacy@lykn.io
              </a>{" "}
              within 30 days.
            </Bullet>
            <Bullet>
              <strong>Withdrawal of consent:</strong> revoke any connected AI
              tool's access from /connections.
            </Bullet>
          </ul>
          <p className="mt-3">
            EU/UK residents may also lodge a complaint with your local
            data-protection authority. California residents have additional
            rights under CCPA/CPRA, same email channel.
          </p>
        </Section>

        <Section title="Changes to this policy" anchor="changes">
          <p>
            Material changes (new sub-processors, new data categories, new
            retention rules) will bump the date at the top and trigger an
            email to all active accounts at least 14 days before they take
            effect. Trivial copy edits don't.
          </p>
        </Section>

        <Section title="Contact" anchor="contact">
          <p>
            Questions, complaints, deletion requests:{" "}
            <a
              href="mailto:privacy@lykn.io"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              privacy@lykn.io
            </a>
            .
          </p>
        </Section>

        <footer className="pt-10 mt-10 border-t border-black/[0.06] dark:border-white/[0.08]">
          <div className="flex items-center justify-between text-[11.5px] text-black/55 dark:text-white/55">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-black/75 dark:text-white/75">LYKN</span>
            </div>
            <div className="flex gap-5">
              <Link to="/terms" className="hover:text-black/85 dark:hover:text-white/85">
                Terms
              </Link>
              <Link to="/cookies" className="hover:text-black/85 dark:hover:text-white/85">
                Cookies
              </Link>
              <Link to="/dpa" className="hover:text-black/85 dark:hover:text-white/85">
                DPA
              </Link>
              <Link to="/" className="hover:text-black/85 dark:hover:text-white/85">
                Home
              </Link>
            </div>
          </div>
        </footer>
      </article>
    </main>
  );
}

function Section({ title, anchor, children }) {
  return (
    <section id={anchor} className="scroll-mt-20">
      <h2 className="text-[20px] font-semibold tracking-tight mb-3">{title}</h2>
      <div className="text-[13.5px] leading-relaxed text-black/70 dark:text-white/75 space-y-2">
        {children}
      </div>
    </section>
  );
}

function Bullet({ children }) {
  return (
    <li className="flex gap-2">
      <span className="text-emerald-500 mt-[1px]">•</span>
      <span>{children}</span>
    </li>
  );
}

function Row({ p, purpose, region }) {
  return (
    <tr className="border-b border-black/[0.05] dark:border-white/[0.05]">
      <td className="py-2 pr-4 font-medium text-black/85 dark:text-white/85 align-top">{p}</td>
      <td className="py-2 pr-4 align-top">{purpose}</td>
      <td className="py-2 align-top whitespace-nowrap">{region}</td>
    </tr>
  );
}
