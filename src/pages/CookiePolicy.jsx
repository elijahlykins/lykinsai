// ============================================================================
// CookiePolicy, public cookie + browser-storage policy at /cookies
// ============================================================================
// Required by:
//   • EU ePrivacy Directive (the "cookie law") for any EU visitor
//   • GDPR Article 13 transparency obligations
//   • CCPA/CPRA notice requirements for California residents
//
// LYKN uses localStorage / sessionStorage / IndexedDB for UI state and auth
// (strictly necessary), plus optional Google Analytics 4 cookies when the
// visitor accepts analytics via the consent banner (Consent Mode v2).
//
// Keep the table below in sync with what's actually written client-side:
//   • Auth (Supabase SDK)       , sb-<project>-auth-token
//   • UI preferences            , lykinsai_settings
//   • Last-opened board         , lyknchat_active_id, lyknchat_title
//   • Vault view mode           , lykn_vault_view
//   • Canvas prefs              , lykn_wheel_zoom_mode, lykn_show_grid
//   • Onboarding/dismissals     , lykn:lastLoadInGreetingChatId
//   • Cookie consent choice     , lykn_cookie_consent
//   • Google Analytics (opt-in) , _ga, _ga_*, via gtag G-Q4KSD1G8YF
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { openCookiePreferences } from "@/lib/analytics";

const LAST_UPDATED = "July 27, 2026";

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
            This page explains what LYKN stores in your browser and in the
            LYKN Glass desktop app, why, and what you can do about it. It&apos;s
            a companion to our{" "}
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
              We use your browser&apos;s <code>localStorage</code> and{" "}
              <code>sessionStorage</code> for signing you in and remembering UI
              preferences. Those are <strong>strictly necessary</strong>.
            </Bullet>
            <Bullet>
              Optional <strong>Google Analytics 4</strong> runs on lykn.io only
              after you accept analytics in the cookie banner (or change your
              choice later). We do not use advertising or remarketing cookies.
            </Bullet>
            <Bullet>
              LYKN Glass stores local preferences and session tokens on your
              device; it does not load the website analytics tag.
            </Bullet>
            <Bullet>
              You can accept, reject, or change analytics anytime via{" "}
              <button
                type="button"
                onClick={() => openCookiePreferences()}
                className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
              >
                Manage cookie preferences
              </button>
              , or clear site data in your browser.
            </Bullet>
          </ul>
        </Section>

        <Section title="Cookies vs. localStorage" anchor="cookies-vs-storage">
          <p>
            LYKN writes most of its own state to <code>localStorage</code>,{" "}
            <code>sessionStorage</code>, and (for cached vault thumbnails){" "}
            <code>IndexedDB</code>. EU ePrivacy guidance treats these the same
            as cookies, so they are disclosed here.
          </p>
          <p className="mt-3">
            When you accept analytics, Google Analytics may also set first-party
            cookies (for example <code>_ga</code> / <code>_ga_*</code>) on{" "}
            <code>lykn.io</code>. Infrastructure providers (Supabase, Vercel,
            Render) may issue short-lived session or routing cookies that are
            strictly necessary and contain no advertising identifiers.
          </p>
        </Section>

        <Section title="Analytics (optional, consent)" anchor="analytics">
          <p>
            We use <strong>Google Analytics 4</strong> (measurement ID{" "}
            <code>G-Q4KSD1G8YF</code>) to understand aggregate traffic on
            lykn.io — pages viewed, approximate geography from IP, device /
            browser category, and referral source. This helps us see which
            product and marketing pages are useful.
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              Lawful basis: <strong>consent</strong> (GDPR Art. 6(1)(a) and
              ePrivacy). Analytics storage stays denied until you accept.
            </Bullet>
            <Bullet>
              We configure Google Consent Mode so ads-related storage (
              <code>ad_storage</code>, <code>ad_user_data</code>,{" "}
              <code>ad_personalization</code>) remains denied. We do not run
              Google Ads remarketing from this tag.
            </Bullet>
            <Bullet>
              IP anonymization is enabled on the tag configuration.
            </Bullet>
            <Bullet>
              Your choice is stored locally under{" "}
              <code>lykn_cookie_consent</code> so we do not re-ask every visit.
            </Bullet>
            <Bullet>
              Google acts as a sub-processor for this analytics data; see{" "}
              <Link
                to="/privacy#processors"
                className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
              >
                Privacy Policy §Where your data lives
              </Link>
              .
            </Bullet>
          </ul>
          <div className="mt-4">
            <button
              type="button"
              onClick={() => openCookiePreferences()}
              className="inline-flex items-center justify-center rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3.5 py-2 transition-colors"
            >
              Manage cookie preferences
            </button>
          </div>
        </Section>

        <Section title="LYKN Glass (desktop)" anchor="desktop">
          <p>
            The desktop app is not a website cookie jar, but it does keep
            similar strictly necessary data on your machine so Glass can
            stay signed in and remember your preferences:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              Auth session tokens (so you don&apos;t re-sign-in every launch)
            </Bullet>
            <Bullet>
              UI / hotkey / overlay preferences and local feature flags
            </Bullet>
            <Bullet>
              Short-lived caches for recent chats or assets needed offline or
              for faster reopen (never used for advertising)
            </Bullet>
            <Bullet>
              Auto-updater state pointing at our GitHub Releases channel
            </Bullet>
          </ul>
          <p className="mt-3">
            Glass does not load the lykn.io Google Analytics tag. Screen stills,
            snips, and audio processed by Glass features are handled as
            described in the{" "}
            <Link
              to="/privacy#data"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Privacy Policy
            </Link>
            ; they are not advertising storage.
          </p>
        </Section>

        <Section title="What we store, and why" anchor="inventory">
          <p>Everything LYKN writes to your browser, organised by purpose:</p>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            Authentication (strictly necessary)
          </h3>
          <p>
            Supabase&apos;s SDK stores a signed JWT and refresh token in{" "}
            <code>localStorage</code> under a key like{" "}
            <code>sb-&lt;project&gt;-auth-token</code>. Without this you&apos;d
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
                k="lykn_cookie_consent"
                purpose="Your analytics accept/reject choice so we don't re-prompt every visit"
                life="Persistent until cleared or changed"
              />
              <StorageRow
                k="lykn:* (sessionStorage)"
                purpose="Per-tab UI state: open panels, scroll position, dismissed prompts"
                life="Cleared when you close the tab"
              />
            </tbody>
          </table>

          <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
            Google Analytics (optional — only after Accept)
          </h3>
          <table className="w-full text-[12.5px] mt-3 border-collapse">
            <thead>
              <tr className="border-b border-black/[0.08] dark:border-white/[0.1]">
                <th className="text-left py-2 pr-4 font-semibold">Cookie</th>
                <th className="text-left py-2 pr-4 font-semibold">Purpose</th>
                <th className="text-left py-2 font-semibold">Lifetime</th>
              </tr>
            </thead>
            <tbody className="text-black/65 dark:text-white/70">
              <StorageRow
                k="_ga"
                purpose="Distinguishes visitors for aggregate Analytics reports"
                life="Up to 2 years (Google default)"
              />
              <StorageRow
                k="_ga_*"
                purpose="Persists GA4 session state for the LYKN property"
                life="Up to 2 years (Google default)"
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
              No advertising or remarketing cookies. We don&apos;t show ads.
            </Bullet>
            <Bullet>
              No third-party social-media pixels. There are no embedded
              Facebook / X / LinkedIn trackers in the app.
            </Bullet>
            <Bullet>
              No fingerprinting libraries. We don&apos;t probe canvas, WebGL, or
              fonts to identify your device.
            </Bullet>
          </ul>
        </Section>

        <Section title="Lawful basis" anchor="basis">
          <p>
            Strictly necessary storage (auth, UI preferences, vault caches) is
            processed on the basis of <strong>strict necessity</strong> (GDPR
            Art. 6(1)(b), performance of a contract, and the ePrivacy
            Directive&apos;s strictly-necessary exemption from consent). The
            app cannot function without it.
          </p>
          <p className="mt-3">
            Google Analytics cookies and related client identifiers are
            processed only on the basis of <strong>consent</strong>. Until you
            accept, Consent Mode keeps <code>analytics_storage</code> denied.
            You can withdraw consent anytime via Manage cookie preferences or
            by clearing site data.
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
              &quot;lykn&quot; → remove.
            </Bullet>
            <Bullet>
              <strong>Safari:</strong> Settings → Privacy → Manage Website
              Data → search &quot;lykn&quot; → remove.
            </Bullet>
            <Bullet>
              <strong>Firefox:</strong> Settings → Privacy &amp; Security →
              Cookies and Site Data → Manage Data → search &quot;lykn&quot; → remove.
            </Bullet>
          </ul>
          <p className="mt-3">
            Clearing storage signs you out and resets preferences (including
            your analytics choice). The next visit shows the consent banner
            again.
          </p>
          <p className="mt-3">
            If you want the server-side counterparts gone too — your
            account, vault, synthesis content — delete your account from{" "}
            <Link
              to="/settings"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Settings
            </Link>
            . That&apos;s a hard delete; see{" "}
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
            . Of those, the following may set cookies or similar storage from
            your browser:
          </p>
          <ul className="space-y-2 mt-3">
            <Bullet>
              <strong>Supabase</strong> — auth tokens in localStorage (see
              above).
            </Bullet>
            <Bullet>
              <strong>Vercel</strong> — may set short-lived load-balancer
              cookies for routing. No advertising identifiers.
            </Bullet>
            <Bullet>
              <strong>Google Analytics</strong> — only after you accept
              analytics (<code>_ga</code> / <code>_ga_*</code>). Governed by{" "}
              <a
                href="https://policies.google.com/privacy"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
              >
                Google&apos;s Privacy Policy
              </a>
              .
            </Bullet>
            <Bullet>
              <strong>Stripe</strong> — only on billing pages (
              <code>/billing</code>, checkout). Stripe sets its own fraud-
              prevention cookies governed by{" "}
              <a
                href="https://stripe.com/cookie-settings"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
              >
                Stripe&apos;s cookie policy
              </a>
              .
            </Bullet>
          </ul>
        </Section>

        <Section title="Changes" anchor="changes">
          <p>
            Material changes (a new category of storage, a new third party
            with cookies, or any change to consent requirements) bump the
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
