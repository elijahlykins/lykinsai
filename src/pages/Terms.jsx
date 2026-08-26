// ============================================================================
// Terms, public terms of service at /terms
// ============================================================================
// Required by:
//   • OpenAI ChatGPT Apps catalog submission
//   • Stripe (when paid plans are enabled)
//   • App store reviews (eventual mobile)
//
// These terms intentionally avoid the kitchen-sink approach. Every clause
// here is one we'd actually invoke. We'd rather have short, defensible
// terms users might actually read than a 12-page boilerplate they skip.
//
// House style for all four legal pages: no dashes as punctuation, and no
// accent colors.
//
// Lawyer review status: NOT YET RUN BY COUNSEL. Treat this as a v1 draft
// suitable for early users and OpenAI submission. Before any meaningful
// commercial contract or enterprise deal, run this past an attorney
// (especially the Liability and Indemnity sections).
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const LAST_UPDATED = "August 26, 2026";

export default function Terms() {
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
            Terms of Service
          </div>
        </div>
      </nav>

      <TermsBody />
    </main>
  );
}

/** The terms without the page chrome, so Settings can show them in a popup. */
export function TermsBody() {
  return (
    <article className="max-w-2xl mx-auto px-5 py-16 space-y-8">
      <header>
        <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
          Effective {LAST_UPDATED}
        </div>
        <h1 className="text-[40px] font-semibold tracking-[-0.02em] leading-[1.05]">
          Terms of Service
        </h1>
        <p className="mt-4 text-[14px] leading-relaxed text-black/65 dark:text-white/70">
          By using LYKN you agree to these terms. They are written in plain
          English on purpose. If anything below is unclear, email{" "}
          <a
            href="mailto:hello@lykn.io"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            hello@lykn.io
          </a>
          .
        </p>
      </header>

      <Section title="The agreement" anchor="agreement">
        <p>
          "LYKN" and "we" mean the LYKN service operated at lykn.io and the
          LYKN Glass desktop application by{" "}
          <strong>Omnia Technologies LLC</strong>, a Utah limited liability
          company. "You" means the person using LYKN under their own account.
          By creating a LYKN account, installing the desktop app, or connecting
          LYKN to an AI tool you agree to these Terms and to our{" "}
          <Link
            to="/privacy"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Privacy Policy
          </Link>
          ,{" "}
          <Link
            to="/cookies"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Cookie Policy
          </Link>
          , and, where you route personal data of EU or UK data subjects
          through LYKN as a controller, our{" "}
          <Link
            to="/dpa"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Data Processing Agreement
          </Link>
          , each of which is incorporated by reference.
        </p>
      </Section>

      <Section title="Your account" anchor="account">
        <ul className="space-y-2">
          <Bullet>
            You must be 13 or older. If you're between 13 and the age of
            majority in your country, you must have a parent or guardian's
            permission to use LYKN.
          </Bullet>
          <Bullet>
            You're responsible for keeping your sign-in credentials secure and
            for any activity under your account.
          </Bullet>
          <Bullet>
            One human, one account. You can connect as many AI tools to your
            account as you like, but each LYKN account belongs to a single
            person.
          </Bullet>
        </ul>
      </Section>

      <Section title="What you can do with LYKN" anchor="acceptable">
        <p>You can:</p>
        <ul className="space-y-2 mt-2">
          <Bullet>
            Save anything you have the right to save: your notes, your links,
            your files, content you created or were licensed.
          </Bullet>
          <Bullet>
            Use LYKN Glass on Macs you control to chat, build, imagine, use
            voice, snip, ask about what is on screen, work with your own files,
            and run tasks you approve.
          </Bullet>
          <Bullet>
            Connect LYKN to any AI tool that speaks MCP, OAuth, or our REST API
            and use it however you like for your own work.
          </Bullet>
          <Bullet>Export your data at any time and walk away.</Bullet>
        </ul>
        <p className="mt-4">You can't:</p>
        <ul className="space-y-2 mt-2">
          <Bullet>
            Upload or generate content that's illegal where you live or where
            we operate (US): CSAM, non-consensual intimate imagery, targeted
            harassment, threats of violence, malware, doxxing material, or
            content infringing someone else's IP.
          </Bullet>
          <Bullet>
            Use Glass to capture, record, or share screens, audio, or
            confidential material you are not allowed to process, including
            other people's private screens, workplaces, or regulated data,
            without whatever consent or authority the law requires.
          </Bullet>
          <Bullet>
            Point LYKN's local file and command access at a machine or files
            you don't have the right to read or change, or use it to bypass a
            security control on someone else's system.
          </Bullet>
          <Bullet>
            Use agent browsing to break another site's terms, defeat access
            controls, paywalls, or bot protection, or scrape at a volume that
            burdens a site.
          </Bullet>
          <Bullet>
            Use LYKN to operate a service that resells or proxies our APIs to
            other people without our written permission. Personal use is fine.
            Building a SaaS on top of LYKN needs a conversation first.
          </Bullet>
          <Bullet>
            Reverse-engineer the service, scrape rate-limited endpoints, or
            attempt to extract another user's data.
          </Bullet>
          <Bullet>
            Forge OAuth client metadata to impersonate a brand you don't own
            when registering against our IdP.
          </Bullet>
        </ul>
      </Section>

      <Section title="LYKN Glass (desktop software)" anchor="glass">
        <p>
          LYKN Glass is our downloadable Mac app. By installing it you license
          a non-exclusive, non-transferable right to use the app with your LYKN
          account on devices you own or control. The license ends when your
          account is closed or we terminate access under these Terms.
        </p>
        <ul className="space-y-2 mt-3">
          <Bullet>
            <strong>Permissions.</strong> Glass may ask for Screen Recording,
            Microphone, Accessibility, Automation, and related OS permissions.
            You control those in system settings. Without them, some features
            will not work.
          </Bullet>
          <Bullet>
            <strong>Capture is feature-triggered.</strong> Screen stills,
            snips, page text, microphone, and optional system audio are
            processed when you use a feature that needs them, not as continuous
            surveillance while Glass sits in the tray. Live watch is the one
            repeating capture, and it runs only while you leave it on.
          </Bullet>
          <Bullet>
            <strong>Local Mode is yours to grant.</strong> Access to your
            files, apps, and terminal is off until you turn it on, scoped to
            the folders you sync, and revocable at any time. LYKN asks before
            it writes a file or runs a command that could change your Mac.
            Approving an action means you are authorizing it: review what you
            are approving, and keep backups of work you cannot lose.
          </Bullet>
          <Bullet>
            <strong>Agent tasks.</strong> When you hand LYKN a task it can run
            steps on its own, including browsing sites and working with your
            files. It can misread a page or a request. You remain responsible
            for what you set it loose on and for checking the result.
          </Bullet>
          <Bullet>
            <strong>Updates.</strong> The app may download and install updates
            automatically from our release channel so security and feature
            fixes ship promptly. You can quit the app to pause use.
            Uninstalling removes the local software, and your cloud account
            data remains until you delete the account.
          </Bullet>
          <Bullet>
            <strong>Your responsibility.</strong> You are responsible for what
            Glass sees and sends on your behalf, including content in
            third-party apps and websites visible on your screen. Review AI
            output before acting on it.
          </Bullet>
        </ul>
      </Section>

      <Section title="Your content stays yours" anchor="content">
        <p>
          You retain all rights to the content you put into LYKN. You grant
          LYKN a narrow, revocable licence to host, display, transmit, and
          process that content as needed to operate the service for you,
          including passing it to AI tools you have explicitly connected. That
          licence ends when you delete the content or your account.
        </p>
        <p className="mt-3">
          We do not train any AI model on your content. We do not aggregate
          your content into any cross-user dataset.
        </p>
      </Section>

      <Section title="AI-generated output" anchor="ai-output">
        <p>
          LYKN passes your content, and when you use Glass the screen stills,
          snips, page text, file contents, command output, and voice audio a
          feature needs, to model and voice providers such as OpenAI,
          Anthropic, Google, xAI, and ElevenLabs, depending on the feature and
          the model you select. AI output can be wrong, biased, or fabricated.{" "}
          <strong>
            You are responsible for reviewing and verifying anything an AI tool
            generates inside or via LYKN before relying on it
          </strong>
          , especially for medical, legal, financial, or safety-critical
          decisions.
        </p>
      </Section>

      <Section title="Connected AI tools" anchor="connectors">
        <p>
          When you connect an AI tool to LYKN (ChatGPT, Claude, Cursor, and so
          on), that tool operates under <em>its own</em> terms and privacy
          policy once your data leaves our servers. We pass the data because
          you authorised it. What the tool does with it after that is governed
          by its own contract with you. The same is true in reverse for
          accounts you connect to LYKN, such as Google, Slack, or Notion: we
          use the access you grant, within the scopes shown, until you
          disconnect.
        </p>
        <p className="mt-3">
          You can revoke any connected tool's access at any time from your{" "}
          <Link
            to="/connections"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Connections page
          </Link>
          . Revocation is immediate.
        </p>
      </Section>

      <Section title="Plans and billing" anchor="billing">
        <p>
          Access to LYKN, including Glass, generally requires completing
          checkout for a plan. The current plans are{" "}
          <strong>Student</strong> at $20 per month or $144 per year,{" "}
          <strong>Pro</strong> at $25 per month or $204 per year, and{" "}
          <strong>Max</strong> at $100 per month or $900 per year, as shown at{" "}
          <Link
            to="/pricing"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Pricing
          </Link>
          . A plan for teams is not available yet. New accounts start with a
          two-week free trial of the plan you pick: you add a card at signup,
          pay nothing that day, and can cancel any time before the trial ends
          without being charged.
        </p>
        <p className="mt-3">
          Accounts that are not on a plan run on a small pool of starter
          credits. When those run out, AI features stop until you start a plan.
        </p>
        <p className="mt-3">
          Paid plans renew at the cadence shown at checkout, monthly or annual.
          You can manage or cancel from the in-app billing portal. On
          cancellation after a paid period starts, your plan stays active until
          the end of the current billing period. We don't pro-rate refunds
          unless required by law or we say otherwise in writing.
        </p>
        <p className="mt-3">
          Student pricing requires a school-associated account email, plus any
          other eligibility checks we publish. Plan limits, for example Glass
          requests, image generations, and artifact builds, are described on
          Pricing and are enforced in the product.
        </p>
        <p className="mt-3">
          Stripe processes all payments. We never see your card number. Prices,
          plan limits, and quotas may change with at least 14 days notice by
          email. Existing committed terms (annual prepay) are honored at the
          original price for the committed term.
        </p>
      </Section>

      <Section title="Service availability" anchor="availability">
        <p>
          We aim for high uptime but don't promise it. The service is provided
          "as is" and "as available." Third-party AI providers and scheduled
          project workflows can be delayed or interrupted, and LYKN's backend may
          be down for maintenance from time to time.
        </p>
        <p className="mt-3">
          We will give reasonable notice, in-app or by email, before any
          scheduled maintenance window we expect to take more than a few
          minutes.
        </p>
      </Section>

      <Section title="Suspension and termination" anchor="termination">
        <p>
          We can suspend or terminate your account if you materially breach
          these Terms, for example by uploading prohibited content, abusing
          quotas, or attacking the service. Where the breach is fixable and not
          malicious, we'll usually warn you first.
        </p>
        <p className="mt-3">
          You can terminate your account at any time from{" "}
          <Link
            to="/settings"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Settings
          </Link>
          . Hard deletion of your data follows the timeline in our Privacy
          Policy.
        </p>
      </Section>

      <Section title="Warranties and liability" anchor="liability">
        <div className="rounded-xl border border-black/10 dark:border-white/15 p-3 mb-3">
          <p className="text-[12.5px]">
            The next two paragraphs are written in capitals because the law in
            some jurisdictions requires limitation-of-liability language to be
            conspicuous. The substance is normal SaaS practice.
          </p>
        </div>
        <p className="uppercase text-[12.5px]">
          LYKN IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
          IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, AND NON-INFRINGEMENT, TO THE MAXIMUM EXTENT
          PERMITTED BY APPLICABLE LAW.
        </p>
        <p className="uppercase text-[12.5px] mt-3">
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, LYKN'S TOTAL LIABILITY TO YOU
          FOR ANY CLAIM ARISING FROM OR RELATING TO THE SERVICE, INCLUDING ANY
          ACTION TAKEN ON YOUR DEVICE OR ON YOUR BEHALF WITH YOUR APPROVAL, IS
          LIMITED TO THE AMOUNT YOU PAID LYKN IN THE 12 MONTHS BEFORE THE EVENT
          GIVING RISE TO THE CLAIM, OR US$100, WHICHEVER IS GREATER. LYKN IS
          NOT LIABLE FOR INDIRECT, INCIDENTAL, CONSEQUENTIAL, SPECIAL, OR
          PUNITIVE DAMAGES, INCLUDING LOST DATA OR LOST PROFITS.
        </p>
        <p className="mt-3">
          Nothing in these Terms limits liability for fraud, gross negligence,
          willful misconduct, or anything else that can't be limited under
          applicable law.
        </p>
      </Section>

      <Section title="Indemnity" anchor="indemnity">
        <p>
          If your use of LYKN, including content you upload and actions you
          take with connected AI tools or with local access on your machine,
          causes a third party to bring a claim against us, you'll defend us
          against that claim and pay any settlements or judgments. We'll tell
          you about the claim promptly, let you control the defense, and
          cooperate reasonably.
        </p>
      </Section>

      <Section title="Changes" anchor="changes">
        <p>
          We may update these Terms. Material changes (new restrictions on use,
          changes to the liability cap, new fees) will be announced by email at
          least 14 days before they take effect. Continuing to use LYKN after
          the effective date means you accept the new Terms.
        </p>
      </Section>

      <Section title="Governing law and disputes" anchor="law">
        <p>
          These Terms are governed by the laws of the State of Utah, USA,
          without regard to conflict-of-laws principles. Any dispute arising
          from these Terms or LYKN will be resolved in the state or federal
          courts located in Salt Lake County, Utah, and you and LYKN consent to
          personal jurisdiction there.
        </p>
        <p className="mt-3">
          If you're a consumer in the EU or UK, this clause does not deprive
          you of the protections of the mandatory consumer-protection laws of
          your country of residence.
        </p>
      </Section>

      <Section title="Contact" anchor="contact">
        <p>
          Questions about these Terms:{" "}
          <a
            href="mailto:hello@lykn.io"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            hello@lykn.io
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
            <Link to="/privacy" className="hover:text-black/85 dark:hover:text-white/85">
              Privacy
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
