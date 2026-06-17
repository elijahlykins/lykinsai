// ============================================================================
// CookiePolicy, public cookie + browser-storage policy at /cookies
// ============================================================================
// Required by:
//   • EU ePrivacy Directive (the "cookie law") for any EU visitor
//   • GDPR Article 13 transparency obligations
//   • CCPA/CPRA notice requirements for California residents
//
// LYKN's honest position: we don't actually set traditional HTTP cookies for
// tracking. We do use localStorage / sessionStorage / IndexedDB extensively
// for UI state and auth, which is functionally equivalent and legally
// equivalent under ePrivacy guidance, so it gets disclosed here in the
// same shape a Cookies page would normally take.
//
// Keep the table below in sync with what's actually written client-side:
//   • Auth (Supabase SDK)       , sb-<project>-auth-token
//   • UI preferences            , lykinsai_settings
//   • Last-opened board         , lyknchat_active_id, lyknchat_title
//   • Vault view mode           , lykn_vault_view
//   • Canvas prefs              , lykn_wheel_zoom_mode, lykn_show_grid
//   • Onboarding/dismissals     , lykn:lastLoadInGreetingChatId
//
// If we ever add analytics, advertising, or third-party trackers, this page
// becomes a real consent-required surface and the lawful basis flips from
// "strictly necessary" to "consent." That's a material change, bump the
// LAST_UPDATED date and notify users per Privacy Policy §Changes.
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

const LAST_UPDATED = "May 20, 2026";

export default function CookiePolicy() {
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
            Cookie Policy
          </div>
        </div>
      </nav>

      <article className="max-w-2xl mx-auto px-5 py-16 space-y-8">
        <header>
          <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
            Effective {LAST_UPDATED}
          </div>
          <h1 className="text-[40px] font-semibold tracking-[-0.02em] leading-[1.05]">
            Cookie Policy
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-black/65 dark:text-white/70">
            This page explains what LYKN stores in your browser, why, and what
            you can do about it. It's a companion to our{" "}
            <Link
              to="/privacy"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Privacy Policy
            </Link>
            .
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-black/55 dark:text-white/60">
            The operator of LYKN is{" "}
            <strong>Omnia Technologies LLC</strong>. Questions about anything
            below:{" "}
            <a
              href="mailto:privacy@lykn.io"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              privacy@lykn.io
            </a>
            .
          </p>
        </header>

        <Section title="The short version" anchor="tldr">
          <ul className="space-y-2">
            <Bullet>
              We don't set any HTTP cookies for analytics, advertising, or
              cross-site tracking. We don't share any storage with third
              parties.
            </Bullet>
            <Bullet>
              We do use your browser's <code>localStorage</code> and{" "}
              <code>sessionStorage</code> for two things: keeping you signed
              in, and remembering your UI preferences. Both are{" "}
              <strong>strictly necessary</strong> for the app to function.
            </Bullet>
            <Bullet>
              You can clear all of it at any time from your browser's site
              settings, or by deleting your account from{" "}
              <Link
                to="/settings"
                className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
              >
                Settings
              </Link>
              .
            </Bullet>
            <Bullet>
              If we ever add analytics or advertising tech, we'll surface a
              real consent banner first. Not before.
            </Bullet>
          </ul>
        </Section>

        <Section title="Cookies vs. localStorage" anchor="cookies-vs-storage">
          <p>
            For clarity: LYKN itself doesn't set traditional HTTP cookies
            from <code>lykn.io</code>. Some of our infrastructure providers
            (Supabase, Vercel, Render) may issue a session cookie when you
            load the app, those are strictly necessary for routing and
            load balancing and contain no personal identifiers.
          </p>
          <p className="mt-3">
            The data LYKN itself writes lives in <code>localStorage</code>,{" "}
            <code>sessionStorage</code>, and (for cached vault thumbnails)
            <code> IndexedDB</code>. EU ePrivacy guidance treats these the
            same as cookies, so we disclose them here too.
          </p>
        </Section>

        <Section title="What we store, and why" anchor="inventory">
          <p>Everything LYKN writes to your browser, organised by purpose:</p>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            Authentication (strictly necessary)
          </h3>
          <p>
            Supabase's SDK stores a signed JWT and refresh token in{" "}
            <code>localStorage</code> under a key like{" "}
            <code>sb-&lt;project&gt;-auth-token</code>. Without this you'd
            be signed out on every page load.
          </p>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            UI preferences and last-used state (strictly necessary)
          </h3>
          <table className="w-full text-[12.5px] mt-3 border-collapse">
            <thead>
              <tr className="border-b border-black/[0.08] dark:border-white/[0.1]">
                <th className="text-left py-2 pr-4 font-semibold">Key</th>
                <th className="text-left py-2 pr-4 font-semibold">Purpose</th>
                <th className="text-left py-2 font-semibold">Lifetime</th>
              </tr>
            </thead>
            <tbody className="text-black/65 dark:text-white/70">
              <StorageRow
                k="lykinsai_settings"
                purpose="Your settings (theme, default model, layout density)"
                life="Persistent until cleared"
              />
              <StorageRow
                k="lyknchat_active_id"
                purpose="Last-opened board, so /grid restores where you were"
                life="Persistent until cleared"
              />
              <StorageRow
                k="lyknchat_title"
                purpose="Last-opened board's display title"
                life="Persistent until cleared"
              />
              <StorageRow
                k="lykn_vault_view"
                purpose="Vault view mode (grid vs list)"
                life="Persistent until cleared"
              />
              <StorageRow
                k="lykn_wheel_zoom_mode"
                purpose="Canvas wheel-zoom preference"
                life="Persistent until cleared"
              />
              <StorageRow
                k="lykn_show_grid"
                purpose="Canvas grid toggle"
                life="Persistent until cleared"
              />
              <StorageRow
                k="lykn:lastLoadInGreetingChatId"
                purpose="Tracks which board last triggered the load-in briefing so we don't re-show it"
                life="Persistent until cleared"
              />
              <StorageRow
                k="lykn:* (sessionStorage)"
                purpose="Per-tab UI state: open panels, scroll position, dismissed prompts"
                life="Cleared when you close the tab"
              />
            </tbody>
          </table>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            IndexedDB (strictly necessary, opportunistic)
          </h3>
          <p>
            Some browsers cache vault thumbnails and recently-viewed files
            via IndexedDB so the Vault loads instantly on second visit. Cap
            is whatever quota the browser grants (typically a few hundred
            MB). Nothing personally identifying is stored there, just
            blobs you uploaded yourself.
          </p>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            What we never set
          </h3>
          <ul className="space-y-2 mt-2">
            <Bullet>
              No analytics cookies (no Google Analytics, no Plausible, no
              Fathom, we use server-side logs only).
            </Bullet>
            <Bullet>
              No advertising or remarketing cookies. We don't show ads.
            </Bullet>
            <Bullet>
              No third-party social-media cookies. There are no embedded
              Facebook / X / LinkedIn pixels anywhere in the app.
            </Bullet>
            <Bullet>
              No fingerprinting libraries. We don't probe canvas, WebGL, or
              fonts to identify your device.
            </Bullet>
          </ul>
        </Section>

        <Section title="Lawful basis" anchor="basis">
          <p>
            Everything in the table above is processed on the basis of{" "}
            <strong>strict necessity</strong> (GDPR Art. 6(1)(b), performance
            of a contract, and the ePrivacy Directive's strictly-necessary
            exemption from consent). The app cannot function without it: you
            wouldn't stay signed in, your settings wouldn't persist, and the
            vault would re-download every file on every visit.
          </p>
          <p className="mt-3">
            Because nothing here is for analytics, advertising, or profiling,
            no consent banner is required under EU/UK ePrivacy guidance. If
            that ever changes, for example, if we add an opt-in analytics
            integration, we'll add a real consent flow before the new
            storage is set.
          </p>
        </Section>

        <Section title="How to clear it" anchor="clearing">
          <p>
            All browsers let you wipe site storage for <code>lykn.io</code>:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              <strong>Chrome / Edge / Brave:</strong> Settings → Privacy →
              Cookies and other site data → See all site data → search
              "lykn" → remove.
            </Bullet>
            <Bullet>
              <strong>Safari:</strong> Settings → Privacy → Manage Website
              Data → search "lykn" → remove.
            </Bullet>
            <Bullet>
              <strong>Firefox:</strong> Settings → Privacy & Security →
              Cookies and Site Data → Manage Data → search "lykn" → remove.
            </Bullet>
          </ul>
          <p className="mt-3">
            Clearing storage signs you out. The next time you sign in,
            preferences reset to defaults.
          </p>
          <p className="mt-3">
            If you want the server-side counterparts gone too, your
            account, vault, synthesis content, delete your account from{" "}
            <Link
              to="/settings"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Settings
            </Link>
            . That's a hard delete; see{" "}
            <Link
              to="/privacy#retention"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Privacy Policy §Retention
            </Link>
            .
          </p>
        </Section>

        <Section title="Third-party infrastructure" anchor="processors">
          <p>
            LYKN runs on the sub-processors listed in{" "}
            <Link
              to="/privacy#processors"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Privacy Policy §Where your data lives
            </Link>
            . Of those, only the three that serve traffic from your browser
            may set their own infrastructure cookies:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              <strong>Supabase</strong>, auth tokens in localStorage (see
              above).
            </Bullet>
            <Bullet>
              <strong>Vercel</strong>, may set short-lived load-balancer
              cookies for routing. No identifiers; cleared with the rest of
              site storage.
            </Bullet>
            <Bullet>
              <strong>Stripe</strong>, only on billing pages (
              <code>/billing</code>, checkout). Stripe sets its own fraud-
              prevention cookies governed by{" "}
              <a
                href="https://stripe.com/cookie-settings"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
              >
                Stripe's cookie policy
              </a>
              .
            </Bullet>
          </ul>
        </Section>

        <Section title="Changes" anchor="changes">
          <p>
            Material changes (a new category of storage, a new third party
            with cookies, or any move away from strict necessity) bump the
            date at the top and trigger the same 14-day email notice that
            applies to the Privacy Policy.
          </p>
        </Section>

        <Section title="Contact" anchor="contact">
          <p>
            Questions or requests:{" "}
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
              <Link to="/privacy" className="hover:text-black/85 dark:hover:text-white/85">
                Privacy
              </Link>
              <Link to="/terms" className="hover:text-black/85 dark:hover:text-white/85">
                Terms
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

function StorageRow({ k, purpose, life }) {
  return (
    <tr className="border-b border-black/[0.05] dark:border-white/[0.05]">
      <td className="py-2 pr-4 align-top">
        <code className="text-[11.5px] text-black/85 dark:text-white/85">{k}</code>
      </td>
      <td className="py-2 pr-4 align-top">{purpose}</td>
      <td className="py-2 align-top whitespace-nowrap">{life}</td>
    </tr>
  );
}
