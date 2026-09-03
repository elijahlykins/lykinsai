// ============================================================================
// Support, public help + contact page at /support
// ============================================================================
// This is the Support URL listed on LYKN's App Store product page, so it must
// stay a real, working page (App Review Guidelines 1.5 and 2.1 require the
// Support URL to be fully functional and provide a way to contact us).
//
// Keep the contact addresses in sync with the rest of the site:
//   • hello@lykn.io    , general support + questions (also used in /terms)
//   • privacy@lykn.io  , privacy and data requests (also used in /privacy)
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { studioSettingsPath } from "@/lib/settingsDeepLink";

export default function Support() {
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
            Support
          </div>
        </div>
      </nav>

      <article className="max-w-2xl mx-auto px-5 py-16 space-y-10">
        <header>
          <h1 className="text-[40px] font-semibold tracking-[-0.02em] leading-[1.05]">
            Support
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-black/65 dark:text-white/70">
            Need help with LYKN on the web or the LYKN iOS app? We're a small
            team and we read everything. The fastest way to reach us is email.
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-[18px] font-semibold tracking-tight">
            Contact us
          </h2>
          <p className="text-[14px] leading-relaxed text-black/65 dark:text-white/70">
            For questions, bug reports, feedback, or help with your account,
            email{" "}
            <a
              href="mailto:hello@lykn.io"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              hello@lykn.io
            </a>
            . Include the email address you signed up with and, if you're
            reporting a problem, what you were doing when it happened. We aim
            to reply within two business days.
          </p>
          <p className="text-[14px] leading-relaxed text-black/65 dark:text-white/70">
            For privacy questions or data requests (export, correction,
            deletion), email{" "}
            <a
              href="mailto:privacy@lykn.io"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              privacy@lykn.io
            </a>
            .
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-semibold tracking-tight">
            Common questions
          </h2>
          <div className="space-y-4 text-[14px] leading-relaxed text-black/65 dark:text-white/70">
            <div>
              <p className="font-medium text-black/80 dark:text-white/85">
                How do I delete my account?
              </p>
              <p>
                In the iOS app, go to Settings → Account → Delete Account. On
                the web and in the Mac app, open{" "}
                <Link
                  to={studioSettingsPath("account")}
                  className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
                >
                  Settings → Account
                </Link>{" "}
                and choose Delete Account. You will have to type DELETE to confirm.
                Deleting your account removes LYKN-held data as described in
                our Privacy Policy. There is no in-app export of your LYKN
                data today. For a copy of what we hold, email privacy@lykn.io.
              </p>
            </div>
            <div>
              <p className="font-medium text-black/80 dark:text-white/85">
                I can't sign in.
              </p>
              <p>
                Make sure you're using the same method (Apple, Google, or
                email) you originally signed up with. If you're still stuck,
                email us and we'll sort it out.
              </p>
            </div>
            <div>
              <p className="font-medium text-black/80 dark:text-white/85">
                Where can I manage my subscription?
              </p>
              <p>
                Subscriptions purchased on the web are managed from Settings →
                Billing on{" "}
                <a
                  href="https://lykn.io"
                  className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
                >
                  lykn.io
                </a>
                .
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-[18px] font-semibold tracking-tight">
            Policies
          </h2>
          <p className="text-[14px] leading-relaxed text-black/65 dark:text-white/70">
            <Link
              to="/privacy"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Privacy Policy
            </Link>
            {" · "}
            <Link
              to="/terms"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Terms of Service
            </Link>
            {" · "}
            <Link
              to="/cookies"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Cookie Policy
            </Link>
          </p>
          <p className="text-[12.5px] leading-relaxed text-black/55 dark:text-white/60">
            LYKN is operated by <strong>Omnia Technologies LLC</strong>.
          </p>
        </section>
      </article>
    </main>
  );
}
