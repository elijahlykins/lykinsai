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
// House style for all four legal pages: no dashes as punctuation, and no
// accent colors. Plain type only, so the docs read the same everywhere they
// are shown (public page, Settings popup, a reviewer's PDF print).
//
// Last updated: keep the date at the top in sync with material changes
// (new third-party processors, new data categories, new retention rules).
// Trivial copy edits don't bump it.
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const LAST_UPDATED = "August 26, 2026";

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

      <PrivacyBody />
    </main>
  );
}

/** The policy without the page chrome, so Settings can show it in a popup. */
export function PrivacyBody() {
  return (
    <article className="max-w-2xl mx-auto px-5 py-16 prose-style space-y-8">
      <header>
        <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
          Effective {LAST_UPDATED}
        </div>
        <h1 className="text-[40px] font-semibold tracking-[-0.02em] leading-[1.05]">
          Privacy Policy
        </h1>
        <p className="mt-4 text-[14px] leading-relaxed text-black/65 dark:text-white/70">
          LYKN stores your private Markdown Memory, project state, Vault
          content, and conversations, plus <strong>LYKN Glass</strong>, the Mac
          app that puts LYKN on top of everything else you use. Glass can
          answer about your screen, listen when you ask it to, read and write
          files you have shared with it, run commands you approve, browse the
          web for you, and talk with you out loud. This policy explains
          exactly what we collect, why, who else sees it, and how to make it
          disappear.
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
          . Browser and device storage (localStorage, sessionStorage, and the
          files the Mac app keeps on your machine) is documented separately in
          our{" "}
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
            Your account email, Markdown Memory documents, project state,
            Vault items, conversations, and minimal usage telemetry are stored
            in our database (Supabase, hosted in the US).
          </Bullet>
          <Bullet>
            Glass captures your screen, a snip, page text, or audio only when
            you use a feature that needs it. Those captures go to our API and
            then to the AI provider handling that request. They are not sold,
            and no model is trained on them.
          </Bullet>
          <Bullet>
            Local Mode is off until you turn it on. When it is on, LYKN can
            read files in the folders you sync, and it asks you before writing
            a file or running a command.
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
            at any time. Deletion is a hard delete, not a soft flag.
          </Bullet>
        </ul>
      </Section>

      <Section title="What we collect" anchor="data">
        <h3 className="text-[15px] font-semibold tracking-tight mt-4 mb-1">
          Account data
        </h3>
        <p>
          Email address, the sign-in method you used (email, Google, or Apple),
          and a Supabase-issued user ID. We don't ask for phone numbers, names,
          or addresses.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Your LYKN content
        </h3>
        <p>
          Everything you save in LYKN: Markdown Memory documents, Vault items
          (notes, links, files, images, and generated artifacts), project
          definitions and project state, todos and calendar items,
          conversation transcripts inside the app and Glass overlay chats, and
          summaries derived from those.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Screen, audio, and page text (LYKN Glass)
        </h3>
        <p>
          Glass runs as a tray-resident, always-on-top overlay. It processes
          the following only when you invoke a feature that needs it:
        </p>
        <ul className="space-y-2 mt-2">
          <Bullet>
            <strong>Screen stills and snips.</strong> When you ask Glass about
            your screen, take a snip, or ask about what's on screen, we capture
            a still image of your display or the selected region and send it
            with your question to the model handling the request.
          </Bullet>
          <Bullet>
            <strong>Live watch.</strong> If you switch live watch on, Glass
            captures your screen on a repeating interval for as long as it
            stays on, so it can follow along. It is off by default, you turn
            it on, and turning it off stops the capture loop.
          </Bullet>
          <Bullet>
            <strong>Page and window text.</strong> Text read from the front
            browser tab or an open app, through macOS Accessibility or the
            optional LYKN browser extension, so Glass can reason about what is
            on screen without you pasting it.
          </Bullet>
          <Bullet>
            <strong>Microphone and optional system audio.</strong> For voice
            mode, dictation, and live transcription. When you record a meeting,
            Glass captures system audio alongside your microphone. Audio is
            streamed or uploaded to the speech provider for that session and
            transcribed.
          </Bullet>
          <Bullet>
            <strong>Overlay chat history.</strong> Messages and tool results
            from Glass sessions may be stored with your account so you can pick
            work back up later.
          </Bullet>
          <Bullet>
            <strong>OS permission status.</strong> Whether Screen Recording,
            Microphone, Accessibility, and Automation permissions have been
            granted, so we can prompt you to enable what a feature needs.
          </Bullet>
        </ul>
        <p className="mt-3">
          Glass does not stream video of your desktop while it sits idle, and
          it does not log your keystrokes.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Local Mode: your files, apps, and terminal
        </h3>
        <p>
          Local Mode is the switch that lets LYKN touch your Mac at all. It is
          off until you turn it on, and the first time you do we explain what
          it grants before anything is enabled. Sync with Mac is the companion
          setting that decides scope: your whole home folder by default, or
          only the folders you pick. That list lives on your Mac in LYKN's
          application support folder, not on our servers.
        </p>
        <ul className="space-y-2 mt-2">
          <Bullet>
            <strong>Reading.</strong> LYKN can list folders, search, and read
            the text of files inside your synced folders. The first read in a
            chat asks for your approval.
          </Bullet>
          <Bullet>
            <strong>Writing and commands.</strong> LYKN can write text files
            and run shell commands on your Mac. Anything that could change your
            machine asks you first, every time, and shows you the exact command
            or path before it runs. Read-only commands can run once you have
            granted read access.
          </Bullet>
          <Bullet>
            <strong>Apps.</strong> LYKN can list the apps installed on your
            Mac and which are running, open them, and, when you ask about an
            open app, read text from its window through macOS Accessibility.
          </Bullet>
          <Bullet>
            <strong>Your desktop and wallpaper.</strong> If you mirror your Mac
            desktop onto the LYKN home screen, we read the names and icons of
            what is in that folder to draw it. Choosing a wallpaper copies that
            image into LYKN's application support folder for display.
          </Bullet>
        </ul>
        <p className="mt-3">
          All of this runs on your Mac, never on our servers. What we do
          receive is the <em>result</em>: the file text, directory listing,
          command output, or app text that the assistant asked for is sent to
          our API and placed in the conversation, which means the model
          provider handling that request sees it too. Files you attach to a
          chat are uploaded to your vault storage. Mirrored desktop items and
          your wallpaper stay on your Mac unless you ask LYKN about them.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Browsing and research
        </h3>
        <p>
          When you ask LYKN to look something up, we send your query to a
          search provider and fetch the pages in the results. When you use
          agent browsing, LYKN opens pages in a browser it controls on your
          Mac, and the page text and screenshots it needs to decide the next
          step are sent to our API and to the model planning the task. Actions
          with consequences ask for your approval first.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Accounts you connect
        </h3>
        <p>
          If you connect an account (Google, Gmail, Drive, Calendar, Slack,
          Notion, GitHub, Spotify, Linear, and the others on the Connections
          page), we pull the data that connection is scoped to, mostly saved
          items, bookmarks, upcoming events, or starred files, and store it
          with your account so LYKN can use it. The access tokens are
          encrypted before they are written to our database. Disconnecting
          removes the token and stops the sync.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Usage telemetry
        </h3>
        <p>
          Sparse server-side logs of API calls (which endpoint, response time,
          status code, your user ID), AI usage records used to meter credits
          and plan limits, MCP tool invocation counts and tool names (so the
          Connections page can show tool usage), and OAuth client metadata
          for connected AI tools (client name, scopes, last-used timestamp).
          The iOS app additionally forwards Apple MetricKit diagnostics (crash
          reports, hang and performance summaries, never message or vault
          content) to our own servers, associated with your account so we can
          investigate issues you report. These are deleted with your account.
        </p>
        <p className="mt-3">
          On the public website (lykn.io), we also use{" "}
          <strong>Google Analytics 4</strong> for aggregate page-view and
          traffic measurement when you accept analytics cookies. This is
          optional, gated by a consent banner and Google Consent Mode, and
          does not include advertising or remarketing. Details and how to
          change your choice are in the{" "}
          <Link
            to="/cookies#analytics"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Cookie Policy
          </Link>
          . The Mac app does not report to analytics at all.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          What we don't collect
        </h3>
        <ul className="space-y-2 mt-2">
          <Bullet>No advertising IDs, fingerprints, or cross-site trackers.</Bullet>
          <Bullet>
            No keystroke logging, no session replay, and no continuous desktop
            video or background microphone. Screen stills, snips, page text,
            and audio are processed only for features you trigger.
          </Bullet>
          <Bullet>
            No sweep of your Mac. LYKN reads a file when a request needs that
            file, not on a schedule, and only inside the folders you synced.
          </Bullet>
          <Bullet>
            No location beyond approximate IP geolocation derived from server
            logs (used for rate limiting and abuse detection only, not stored
            against your account) and, if you add the weather widget, the city
            you choose for the forecast.
          </Bullet>
          <Bullet>
            No payment-card numbers. Stripe holds those for trial checkout and
            paid plans.
          </Bullet>
        </ul>
      </Section>

      <Section title="How we use your data" anchor="usage">
        <p>Strictly to operate the product:</p>
        <ul className="space-y-2 mt-3">
          <Bullet>
            Authenticate you and serve LYKN on the web, on iOS, and in the Mac
            app.
          </Bullet>
          <Bullet>
            Resolve and update private Markdown Memory when you explicitly ask
            LYKN to remember, change, or forget durable personal context.
          </Bullet>
          <Bullet>
            Power Glass: answering about your screen, snips, live watch, voice
            sessions, local file and command work, agent browsing, artifact
            builds, and the chats around them.
          </Bullet>
          <Bullet>
            Surface your authorized LYKN content to AI tools you have explicitly
            connected via OAuth or personal access tokens.
          </Bullet>
          <Bullet>
            Send transactional email (sign-in codes, account changes, billing
            receipts). No marketing email without separate opt-in.
          </Bullet>
          <Bullet>
            Meter credits and plan limits, and detect and prevent abuse, spam,
            and quota overruns.
          </Bullet>
          <Bullet>Process subscriptions, trials, and plan limits via Stripe.</Bullet>
        </ul>
        <p className="mt-3">
          <strong>We do not</strong> train any AI model on your content. We do
          not aggregate your data into any cross-user dataset. We do not sell,
          rent, or trade your data.
        </p>
      </Section>

      <Section
        title="ChatGPT, Claude, Cursor, and other connected AI tools"
        anchor="connectors"
      >
        <p>
          When you press <strong>Connect</strong> on a card in your{" "}
          <Link
            to="/connections"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Connections
          </Link>{" "}
          page, LYKN issues a scoped, time-limited access token that the
          connecting AI tool uses to call our MCP and REST endpoints on your
          behalf.
        </p>
        <p className="mt-3">
          <strong>What the connected tool sees:</strong> only the data returned
          by the specific MCP tools listed on{" "}
          <Link
            to="/apps/chatgpt"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            /apps/chatgpt
          </Link>
          : authorized Markdown Memory documents, Vault search results, project
          state, and other content returned by the selected tool. Memory writes
          remain subject to authentication, ownership, path, provenance, and
          explicit-user policy checks.
        </p>
        <p className="mt-3">
          <strong>What the connected tool does not see:</strong> your email,
          your raw conversation transcripts inside LYKN, your billing details,
          tokens issued to other tools, anything on your Mac, or any data from
          other LYKN users. Once the data leaves LYKN's servers, it is governed
          by the connecting tool's own privacy policy (for example{" "}
          <a
            href="https://openai.com/policies/privacy-policy/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            OpenAI's
          </a>
          {" "}or{" "}
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
          list on /connections. Revocation is immediate: the next API call from
          the revoked tool returns 401 unauthorized within seconds.
          Refresh-token rotation with replay detection (RFC 6749 §10.4) means a
          leaked refresh token revokes the entire token family the moment it is
          reused.
        </p>
      </Section>

      <Section title="Where your data lives" anchor="processors">
        <p>
          We use the following sub-processors. Each receives the minimum data
          needed to function, and the ones marked optional only receive
          anything if you use the feature they power.
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
            <Row
              p="Supabase"
              purpose="Postgres database, authentication, and file storage (vault, artifacts, generated images, overlay chats)"
              region="US East"
            />
            <Row
              p="Render"
              purpose="API and backend hosting, including Glass endpoints and billing webhooks"
              region="US East"
            />
            <Row
              p="Vercel"
              purpose="Website and web app hosting (lykn.io)"
              region="Global edge"
            />
            <Row
              p="Cloudflare"
              purpose="DNS and edge protection in front of our API"
              region="Global edge"
            />
            <Row
              p="OpenAI"
              purpose="Model inference for chat, Glass, agent browsing, and artifact builds; embeddings; image generation; speech to text; text to speech; realtime voice"
              region="US"
            />
            <Row
              p="Anthropic"
              purpose="Model inference (Claude tiers) for chat and approved project workflows"
              region="US"
            />
            <Row
              p="Google"
              purpose="Model and vision inference (Gemini tiers); image generation fallback; Google sign-in and the Google connectors you enable; Google Analytics 4 on lykn.io when you accept analytics cookies"
              region="US"
            />
            <Row
              p="xAI"
              purpose="Model inference (Grok tiers) when you pick those models"
              region="US"
            />
            <Row
              p="Together AI"
              purpose="Optional. Hosting and fine-tuning for custom and open-weight models you build"
              region="US"
            />
            <Row
              p="ElevenLabs"
              purpose="Optional. Voice mode audio when ElevenLabs is the selected voice provider"
              region="US"
            />
            <Row
              p="Serper"
              purpose="Web and news search queries when LYKN searches the web for you"
              region="US"
            />
            <Row
              p="Apple"
              purpose="Optional. Sign in with Apple, and iCloud Calendar if you connect it"
              region="US"
            />
            <Row
              p="Open-Meteo"
              purpose="Optional. Forecast lookups for the city you pick in the weather widget"
              region="EU"
            />
            <Row
              p="Resend"
              purpose="Transactional email (sign-in codes, account changes)"
              region="US"
            />
            <Row
              p="Stripe"
              purpose="Trials, subscriptions, and invoices (we never see card numbers)"
              region="US"
            />
            <Row
              p="GitHub"
              purpose="Mac app release downloads and auto-update packages"
              region="US"
            />
          </tbody>
        </table>
        <p className="mt-3">
          Accounts you connect yourself (Slack, Notion, Gmail, and the rest of
          the Connections page) receive and return data only while that
          connection is active. Disconnect it and the sync stops.
        </p>
      </Section>

      <Section title="Retention and deletion" anchor="retention">
        <p>
          Account data and LYKN content live in our database for as long
          as your account is active. When you delete your account from{" "}
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
          <Bullet>All Markdown Memory documents, Vault items, conversations, and project state.</Bullet>
          <Bullet>
            All issued personal access tokens and OAuth bearer and refresh
            tokens (their hashes, plus the OAuth client and consent rows that
            mint them), and the encrypted tokens for every account you
            connected.
          </Bullet>
          <Bullet>All user-scoped retrieval indexes and cached embeddings.</Bullet>
          <Bullet>Usage records and any iOS diagnostics tied to your account.</Bullet>
        </ul>
        <p className="mt-3">
          Server-side request logs are kept for up to 30 days for abuse
          detection and then rotated out. They contain only your user ID,
          endpoint, and status code, never request bodies.
        </p>
        <p className="mt-3">
          Backups are encrypted at rest with separate keys and retained for up
          to 7 days from the night they were taken. Deleted accounts are purged
          from the next backup cycle.
        </p>
        <p className="mt-3">
          What the Mac app keeps on your own machine (settings, synced folder
          list, overlay history, cached wallpapers) is removed when you
          uninstall the app and delete its application support folder. We
          cannot delete it for you remotely.
        </p>
      </Section>

      <Section title="Your rights" anchor="rights">
        <p>
          Wherever you live, you have these rights with respect to your LYKN
          data:
        </p>
        <ul className="space-y-2 mt-3">
          <Bullet>
            <strong>Access:</strong> see everything we hold about you, via the
            in-app product surfaces and the export endpoint.
          </Bullet>
          <Bullet>
            <strong>Portability:</strong> export your LYKN content as JSON
            from Settings.
          </Bullet>
          <Bullet>
            <strong>Correction:</strong> edit Markdown Memory and Vault items
            through the available product controls.
          </Bullet>
          <Bullet>
            <strong>Deletion:</strong> delete your account from Settings. We'll
            also honor email requests to{" "}
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
            tool from /connections, disconnect any account you linked, and turn
            off Local Mode to end file, app, and terminal access on your Mac.
          </Bullet>
        </ul>
        <p className="mt-3">
          EU and UK residents may also lodge a complaint with your local
          data-protection authority. California residents have additional
          rights under CCPA and CPRA, through the same email channel.
        </p>
      </Section>

      <Section title="Changes to this policy" anchor="changes">
        <p>
          Material changes (new sub-processors, new data categories, new
          retention rules) will bump the date at the top and trigger an email
          to all active accounts at least 14 days before they take effect.
          Trivial copy edits don't.
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
      <span className="text-black/35 dark:text-white/35 mt-[1px]">•</span>
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
