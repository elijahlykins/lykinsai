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
// Lawyer review status: NOT YET RUN BY COUNSEL. Treat this as a v1 draft
// suitable for early users and OpenAI submission. Before any meaningful
// commercial contract or enterprise deal, run this past an attorney
// (especially the Liability and Indemnity sections).
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft, ShieldAlert } from "lucide-react";

const LAST_UPDATED = "July 21, 2026";

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
            By creating a LYKN account, installing the desktop app, or
            connecting LYKN to an AI tool you agree to these Terms and to our{" "}
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
            , and, where you route personal data of EU/UK data subjects
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
              You're responsible for keeping your sign-in credentials secure
              and for any activity under your account.
            </Bullet>
            <Bullet>
              One human, one account. You can connect as many AI tools to
              your account as you like, but each LYKN account belongs to a
              single person.
            </Bullet>
          </ul>
        </Section>

        <Section title="What you can do with LYKN" anchor="acceptable">
          <p>You can:</p>
          <ul className="space-y-2 mt-2">
            <Bullet>
              Save anything you have the right to save: your notes, your
              links, your files, content you created or were licensed.
            </Bullet>
            <Bullet>
              Use LYKN Glass on devices you control to chat, build, imagine,
              voice, snip, and ask about on-screen content for your own work.
            </Bullet>
            <Bullet>
              Connect LYKN to any AI tool that speaks MCP, OAuth, or our REST
              API and use it however you like for your own work.
            </Bullet>
            <Bullet>
              Export your data at any time and walk away.
            </Bullet>
          </ul>
          <p className="mt-4">You can't:</p>
          <ul className="space-y-2 mt-2">
            <Bullet>
              Upload or generate content that's illegal where you live or
              where we operate (US): CSAM, non-consensual intimate imagery,
              targeted harassment, threats of violence, malware, doxxing
              material, or content infringing someone else's IP.
            </Bullet>
            <Bullet>
              Use Glass to capture, record, or share screens, audio, or
              confidential material you are not allowed to process — including
              other people&apos;s private screens, workplaces, or regulated
              data — without any consent or authority the law requires.
            </Bullet>
            <Bullet>
              Use LYKN to operate a service that resells or proxies our APIs
              to other people without our written permission. Personal use
              is fine; SaaS-on-top-of-LYKN needs a conversation first.
            </Bullet>
            <Bullet>
              Reverse-engineer the service, scrape rate-limited endpoints,
              or attempt to extract another user's data.
            </Bullet>
            <Bullet>
              Forge OAuth client metadata to impersonate a brand you don't
              own when registering against our IdP.
            </Bullet>
          </ul>
        </Section>

        <Section title="LYKN Glass (desktop software)" anchor="glass">
          <p>
            LYKN Glass is our downloadable desktop overlay. By installing it
            you license a non-exclusive, non-transferable right to use the
            app with your LYKN account on devices you own or control. The
            license ends when your account is closed or we terminate access
            under these Terms.
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              <strong>Permissions.</strong> Glass may ask for Screen Recording,
              Microphone, Accessibility, and related OS permissions. You
              control those in system settings. Without them, some features
              will not work.
            </Bullet>
            <Bullet>
              <strong>Capture is feature-triggered.</strong> Screen stills,
              snips, page text, mic audio, and optional system audio are
              processed when you use a feature that needs them — not as
              continuous surveillance while Glass sits idle in the tray.
            </Bullet>
            <Bullet>
              <strong>Updates.</strong> The app may download and install
              updates automatically from our release channel so security and
              feature fixes ship promptly. You can quit the app to pause use;
              uninstalling removes the local software (your cloud account data
              remains until you delete the account).
            </Bullet>
            <Bullet>
              <strong>Your responsibility.</strong> You are responsible for
              what Glass sees and sends on your behalf, including content on
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
            including passing it to AI tools you have explicitly connected.
            That licence ends when you delete the content or your account.
          </p>
          <p className="mt-3">
            We do not train any AI model on your content. We do not aggregate
            your content into any cross-user dataset.
          </p>
        </Section>

        <Section title="AI-generated output" anchor="ai-output">
          <p>
            LYKN passes your content (and, when using Glass, screen stills,
            snips, page text, and voice audio) to model and voice providers
            such as OpenAI, Anthropic, Google, xAI, and ElevenLabs, depending
            on the feature and model you select. AI output can be wrong,
            biased, or fabricated. <strong>You are responsible for reviewing
            and verifying anything an AI tool generates inside or via LYKN
            before relying on it</strong>, especially for medical, legal,
            financial, or safety-critical decisions.
          </p>
        </Section>

        <Section title="Connected AI tools" anchor="connectors">
          <p>
            When you connect an AI tool to LYKN (ChatGPT, Claude, Cursor,
            etc.), that tool operates under <em>its own</em> terms and privacy
            policy once your data leaves our servers. We pass the data because
            you authorised it; what the tool does with it after that is
            governed by its own contract with you.
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
            Access to LYKN (including Glass) generally requires completing
            checkout for a plan — Student, Pro, or Max — as shown at{" "}
            <Link
              to="/pricing"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Pricing
            </Link>
            . New accounts typically start with a card-required free trial
            whose length is shown at checkout (currently on the order of
            two weeks unless we state otherwise). If you cancel before the
            trial ends, you should not be charged for that trial period.
          </p>
          <p className="mt-3">
            Paid plans renew at the cadence shown at checkout (monthly or
            annual). You can manage or cancel from the in-app billing /
            customer portal. On cancellation after a paid period starts, your
            plan stays active until the end of the current billing period; we
            don&apos;t pro-rate refunds unless required by law or we say
            otherwise in writing.
          </p>
          <p className="mt-3">
            Student pricing requires a school-associated account email (and
            any other eligibility checks we publish). Plan limits (for
            example Glass requests, image generations, and artifact builds)
            are described on Pricing and may be enforced in the product.
          </p>
          <p className="mt-3">
            Stripe processes all payments. We never see your card number.
            Prices, plan limits, and quotas may change with at least 14 days
            notice via email; existing committed terms (annual prepay) are
            honored at the original price for the committed term.
          </p>
        </Section>

        <Section title="Service availability" anchor="availability">
          <p>
            We aim for high uptime but don't promise it. The service is
            provided "as is" and "as available." Nightly synthesis runs and
            third-party AI providers can be delayed or interrupted; LYKN's
            own backend may be down for maintenance from time to time.
          </p>
          <p className="mt-3">
            We will give reasonable notice (in-app or by email) before any
            scheduled maintenance window we expect to take more than a few
            minutes.
          </p>
        </Section>

        <Section title="Suspension and termination" anchor="termination">
          <p>
            We can suspend or terminate your account if you materially breach
            these Terms, for example, uploading prohibited content, abusing
            quotas, or attacking the service. Where the breach is fixable
            and not malicious, we'll usually warn you first.
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
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 mb-3 flex gap-2 items-start">
            <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <p className="text-[12.5px]">
              The next two paragraphs are written in capitals because the
              law in some jurisdictions requires limitation-of-liability
              language to be conspicuous. The substance is normal SaaS
              practice.
            </p>
          </div>
          <p className="uppercase text-[12.5px]">
            LYKN IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EXPRESS
            OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR
            A PARTICULAR PURPOSE, AND NON-INFRINGEMENT, TO THE MAXIMUM EXTENT
            PERMITTED BY APPLICABLE LAW.
          </p>
          <p className="uppercase text-[12.5px] mt-3">
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, LYKN'S TOTAL LIABILITY TO
            YOU FOR ANY CLAIM ARISING FROM OR RELATING TO THE SERVICE IS
            LIMITED TO THE AMOUNT YOU PAID LYKN IN THE 12 MONTHS BEFORE THE
            EVENT GIVING RISE TO THE CLAIM, OR US$100, WHICHEVER IS GREATER.
            LYKN IS NOT LIABLE FOR INDIRECT, INCIDENTAL, CONSEQUENTIAL,
            SPECIAL, OR PUNITIVE DAMAGES.
          </p>
          <p className="mt-3">
            Nothing in these Terms limits liability for fraud, gross
            negligence, willful misconduct, or anything else that can't be
            limited under applicable law.
          </p>
        </Section>

        <Section title="Indemnity" anchor="indemnity">
          <p>
            If your use of LYKN, including content you upload or actions
            you take with connected AI tools, causes a third party to bring
            a claim against us, you'll defend us against that claim and pay
            any settlements or judgments. We'll tell you about the claim
            promptly, let you control the defense, and cooperate reasonably.
          </p>
        </Section>

        <Section title="Changes" anchor="changes">
          <p>
            We may update these Terms. Material changes (new restrictions on
            use, changes to the liability cap, new fees) will be announced by
            email at least 14 days before they take effect. Continuing to use
            LYKN after the effective date means you accept the new Terms.
          </p>
        </Section>

        <Section title="Governing law and disputes" anchor="law">
          <p>
            These Terms are governed by the laws of the State of Utah,
            USA, without regard to conflict-of-laws principles. Any dispute
            arising from these Terms or LYKN will be resolved in the state
            or federal courts located in Salt Lake County, Utah, and you and
            LYKN consent to personal jurisdiction there.
          </p>
          <p className="mt-3">
            If you're a consumer in the EU/UK, this clause does not deprive
            you of the protections of the mandatory consumer-protection laws
            of your country of residence.
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
