// ============================================================================
// CookiePolicy, public cookie + browser-storage policy at /cookies
// ============================================================================
// Required by:
//   • EU ePrivacy Directive (the "cookie law") for any EU visitor
//   • GDPR Article 13 transparency obligations
//   • CCPA/CPRA notice requirements for California residents
//
// LYKN uses localStorage / sessionStorage for auth and UI state (strictly
// necessary), plus optional Google Analytics 4 cookies when a website
// visitor accepts analytics via the consent banner (Consent Mode v2). The
// Mac app keeps its own files in the application support folder instead.
//
// House style for all four legal pages: no dashes as punctuation, and no
// accent colors.
//
// Keep the tables below in sync with what is actually written client-side.
// Group by key family rather than listing every per-id key: the chat, vault,
// desktop, and handoff families all mint keys per chat / item / window.
// ============================================================================

import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { openCookiePreferences } from "@/lib/analytics";

const LAST_UPDATED = "August 13, 2026";

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

      <CookiePolicyBody />
    </main>
  );
}

/** The policy without the page chrome, so Settings can show it in a popup. */
export function CookiePolicyBody() {
  return (
    <article className="max-w-2xl mx-auto px-5 py-16 space-y-8">
      <header>
        <div className="text-[10.5px] uppercase tracking-wide text-black/45 dark:text-white/45 mb-2">
          Effective {LAST_UPDATED}
        </div>
        <h1 className="text-[40px] font-semibold tracking-[-0.02em] leading-[1.05]">
          Cookie Policy
        </h1>
        <p className="mt-4 text-[14px] leading-relaxed text-black/65 dark:text-white/70">
          This page explains what LYKN stores in your browser, and what the
          LYKN Glass Mac app stores on your machine, why, and what you can do
          about it. It is a companion to our{" "}
          <Link
            to="/privacy"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Privacy Policy
          </Link>
          .
        </p>
        <p className="mt-3 text-[12.5px] leading-relaxed text-black/55 dark:text-white/60">
          The operator of LYKN is <strong>Omnia Technologies LLC</strong>.
          Questions about anything below:{" "}
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
            We use your browser's <code>localStorage</code> and{" "}
            <code>sessionStorage</code> to sign you in and to remember how you
            left the app. Those are <strong>strictly necessary</strong>.
          </Bullet>
          <Bullet>
            Optional <strong>Google Analytics 4</strong> runs on lykn.io only
            after you accept analytics in the cookie banner, or change your
            choice later. We do not use advertising or remarketing cookies.
          </Bullet>
          <Bullet>
            The Mac app keeps preferences, your synced-folder list, and local
            caches in its own folder on your machine. It does not report to
            analytics.
          </Bullet>
          <Bullet>
            You can accept, reject, or change analytics anytime with{" "}
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

      <Section title="Cookies and browser storage" anchor="cookies-vs-storage">
        <p>
          LYKN writes almost all of its own state to <code>localStorage</code>{" "}
          and <code>sessionStorage</code> rather than to cookies. EU ePrivacy
          guidance treats those the same as cookies, so they are disclosed
          here. LYKN itself does not set any cookies from its own code.
        </p>
        <p className="mt-3">
          When you accept analytics, Google Analytics sets first-party cookies
          (for example <code>_ga</code> and <code>_ga_*</code>) on{" "}
          <code>lykn.io</code>. Infrastructure providers (Supabase, Vercel,
          Render, Cloudflare, Stripe on billing pages) may issue short-lived
          session, routing, or fraud-prevention cookies that are strictly
          necessary and contain no advertising identifiers.
        </p>
      </Section>

      <Section title="Analytics (optional, consent)" anchor="analytics">
        <p>
          We use <strong>Google Analytics 4</strong> (measurement ID{" "}
          <code>G-Q4KSD1G8YF</code>) to understand aggregate traffic on
          lykn.io: pages viewed, approximate geography from IP, device and
          browser category, and referral source. This helps us see which
          product and marketing pages are useful.
        </p>
        <ul className="space-y-2 mt-3">
          <Bullet>
            Lawful basis: <strong>consent</strong> (GDPR Art. 6(1)(a) and
            ePrivacy). Analytics storage stays denied until you accept.
          </Bullet>
          <Bullet>
            We configure Google Consent Mode v2 so ads-related storage (
            <code>ad_storage</code>, <code>ad_user_data</code>,{" "}
            <code>ad_personalization</code>) stays denied whatever you choose.
            We do not run Google Ads remarketing from this tag.
          </Bullet>
          <Bullet>IP anonymization is enabled on the tag configuration.</Bullet>
          <Bullet>
            Your choice is stored locally under{" "}
            <code>lykn_cookie_consent</code> so we do not re-ask every visit.
          </Bullet>
          <Bullet>
            Analytics is disabled entirely inside the Mac app, which is why you
            never see the banner there.
          </Bullet>
          <Bullet>
            Google acts as a sub-processor for this analytics data. See{" "}
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
            className="inline-flex items-center justify-center rounded-xl border border-black/15 dark:border-white/20 text-[13px] font-medium px-3.5 py-2 text-black/80 dark:text-white/85 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors"
          >
            Manage cookie preferences
          </button>
        </div>
      </Section>

      <Section title="What we store in your browser" anchor="inventory">
        <p>
          Everything below is strictly necessary: it either signs you in or
          keeps the app where you left it. Keys shown with{" "}
          <code>&lt;id&gt;</code> are written once per chat, project, item, or
          window.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Authentication
        </h3>
        <p>
          Supabase's SDK stores a signed JWT and refresh token in{" "}
          <code>localStorage</code> under a key like{" "}
          <code>sb-&lt;project&gt;-auth-token</code>. Without this you would be
          signed out on every page load.
        </p>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Preferences and last-used state (localStorage)
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
              purpose="Your settings in one blob: theme and appearance, default model, assistant name and instructions, voice, home widgets, and desktop sync"
              life="Until cleared"
            />
            <StorageRow
              k="lykn_cookie_consent"
              purpose="Your analytics accept or reject choice, so we don't re-prompt every visit"
              life="Until cleared or changed"
            />
            <StorageRow
              k="lykn_local_mode_consented"
              purpose="Records that you have seen and accepted the one-time explainer for local file access"
              life="Until cleared"
            />
            <StorageRow
              k="lyknchat_active_id, lyknchat_title"
              purpose="Last opened chat, so the app restores where you were"
              life="Until cleared"
            />
            <StorageRow
              k="lyknchat_draft_<id>, lyknchat_chat_<id>, lyknchat_camera_<id>, lyknchat_vault_saved_<id>"
              purpose="Per-chat drafts, a cached transcript for instant reopen, canvas position, and which vault items you added"
              life="Until cleared"
            />
            <StorageRow
              k="lykn_vault_view, vault_collage_order_v1_<user>"
              purpose="Vault layout mode and the order you dragged your cards into"
              life="Until cleared"
            />
            <StorageRow
              k="lykn_home_widget_layout, lykn_desktop_folders, lykn_desktop_sort, lykn_desktop_icon_files, lykn_desktop_mirror_pos, lykn_desktop_visibility"
              purpose="Your home desktop: widget layout, folders, sort order, hide/show, and where you dragged each icon"
              life="Until cleared"
            />
            <StorageRow
              k="lykn_app_window:<id>, lykn_widget_note_<id>, lykn-studio-agent-chat-width"
              purpose="Window sizes and positions, quick-note text, and panel widths"
              life="Until cleared"
            />
            <StorageRow
              k="lykn_user_projects:<user>, lykn_user_links:<user>, project:<id>, lykn_active_custom_model_id, lykn.synthesis.viewMode"
              purpose="Project and link caches, the custom model you have selected, and your synthesis view mode"
              life="Until cleared"
            />
            <StorageRow
              k="lykn_connect_onboarding_done, lykn:loadInBrief:hidden, lykn:chatAppDock:hidden, lykn:vaultAppDock:hidden, lykn:imagine:hasUsed"
              purpose="Things you have finished or dismissed, so we don't show them again"
              life="Until cleared"
            />
            <StorageRow
              k="lykn.glass.translateLang, lykn_night_brief_dismissed"
              purpose="Mac app overlay only: your translate language and a dismissed night brief"
              life="Until cleared"
            />
          </tbody>
        </table>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Per-tab state (sessionStorage)
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
              k="lykn_pending_*"
              purpose="Hands something off between screens: a message typed on Home, a file you asked about, a vault item you sent to chat"
              life="Cleared when the tab closes"
            />
            <StorageRow
              k="lykn_open_chat_threads_v1, lykn_pending_board_threads_v1"
              purpose="Which chat threads are open, and threads waiting to be saved"
              life="Cleared when the tab closes"
            />
            <StorageRow
              k="lykn:desktop-auth-*, lykn:pendingSignupVerify, lykn:pendingShare"
              purpose="Sign-in handoff between your browser and the Mac app, pending email verification, and a link you shared into LYKN"
              life="Cleared when the tab closes"
            />
            <StorageRow
              k="lykn.embed.*"
              purpose="Remembers that this window is an embedded or overlay view"
              life="Cleared when the tab closes"
            />
            <StorageRow
              k="lykn:free-credits-nudge-dismissed, lykn_intake_skipped_<user>"
              purpose="One-per-session prompts, so you see them once and not on every screen"
              life="Cleared when the tab closes"
            />
            <StorageRow
              k="lykn_*_boundary_stale_reload_done"
              purpose="Stops a reload loop when the app updates while you have it open"
              life="Cleared when the tab closes"
            />
          </tbody>
        </table>

        <h3 className="text-[15px] font-semibold tracking-tight mt-5 mb-1">
          Google Analytics (optional, only after you accept)
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
          What we never set
        </h3>
        <ul className="space-y-2 mt-2">
          <Bullet>
            No advertising or remarketing cookies. We don't show ads.
          </Bullet>
          <Bullet>
            No third-party social media pixels. There are no embedded Facebook,
            X, or LinkedIn trackers in the app.
          </Bullet>
          <Bullet>
            No fingerprinting libraries. We don't probe canvas, WebGL, or fonts
            to identify your device.
          </Bullet>
          <Bullet>
            No IndexedDB. Earlier versions of this policy mentioned a vault
            cache there; the app does not use it.
          </Bullet>
        </ul>
      </Section>

      <Section title="What the Mac app keeps on your machine" anchor="desktop">
        <p>
          LYKN Glass is not a website, so it has no cookie jar. It keeps the
          equivalent strictly necessary data in its own folder,{" "}
          <code>~/Library/Application Support/LYKN</code>:
        </p>
        <ul className="space-y-2 mt-3">
          <Bullet>
            Your sign-in session, so you don't sign in again every launch
          </Bullet>
          <Bullet>
            <code>local-mode.json</code>, which holds whether Local Mode is on
            and the list of folders you synced. This list never leaves your Mac.
          </Bullet>
          <Bullet>
            Setup and preference files: your welcome choices, dock and widget
            picks, overlay settings, and hotkeys
          </Bullet>
          <Bullet>
            Local history and caches: overlay chat sessions, agent browsing
            history, and your chosen wallpaper copied in for the background
          </Bullet>
          <Bullet>Auto-updater state pointing at our GitHub release channel</Bullet>
        </ul>
        <p className="mt-3">
          Deleting the app and that folder removes all of it. Screen stills,
          snips, audio, and files that Glass features process are handled as
          described in the{" "}
          <Link
            to="/privacy#data"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Privacy Policy
          </Link>
          . None of it is advertising storage.
        </p>
      </Section>

      <Section title="Lawful basis" anchor="basis">
        <p>
          Strictly necessary storage (auth, preferences, per-tab state) is
          processed on the basis of <strong>strict necessity</strong> (GDPR
          Art. 6(1)(b), performance of a contract, and the ePrivacy Directive's
          strictly-necessary exemption from consent). The app cannot function
          without it.
        </p>
        <p className="mt-3">
          Google Analytics cookies and related client identifiers are processed
          only on the basis of <strong>consent</strong>. Until you accept,
          Consent Mode keeps <code>analytics_storage</code> denied. You can
          withdraw consent anytime with Manage cookie preferences or by
          clearing site data.
        </p>
      </Section>

      <Section title="How to clear it" anchor="clearing">
        <p>
          All browsers let you wipe site storage for <code>lykn.io</code>:
        </p>
        <ul className="space-y-2 mt-3">
          <Bullet>
            <strong>Chrome, Edge, Brave:</strong> Settings, Privacy, Cookies
            and other site data, See all site data, search "lykn", remove.
          </Bullet>
          <Bullet>
            <strong>Safari:</strong> Settings, Privacy, Manage Website Data,
            search "lykn", remove.
          </Bullet>
          <Bullet>
            <strong>Firefox:</strong> Settings, Privacy and Security, Cookies
            and Site Data, Manage Data, search "lykn", remove.
          </Bullet>
        </ul>
        <p className="mt-3">
          Clearing storage signs you out and resets preferences, including your
          analytics choice. The next visit shows the consent banner again.
        </p>
        <p className="mt-3">
          If you want the server-side counterparts gone too, meaning your
          account, vault, and synthesis content, delete your account from{" "}
          <Link
            to="/settings"
            className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
          >
            Settings
          </Link>
          . That is a hard delete. See{" "}
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
            <strong>Supabase:</strong> auth tokens in localStorage, as above.
          </Bullet>
          <Bullet>
            <strong>Vercel and Cloudflare:</strong> short-lived routing and
            protection cookies. No advertising identifiers.
          </Bullet>
          <Bullet>
            <strong>Google Analytics:</strong> only after you accept analytics
            (<code>_ga</code> and <code>_ga_*</code>). Governed by{" "}
            <a
              href="https://policies.google.com/privacy"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-black/85 dark:hover:text-white/90"
            >
              Google's Privacy Policy
            </a>
            .
          </Bullet>
          <Bullet>
            <strong>Stripe:</strong> only on billing and checkout pages. Stripe
            sets its own fraud-prevention cookies, governed by{" "}
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
          Material changes (a new category of storage, a new third party with
          cookies, or any change to consent requirements) bump the date at the
          top and trigger the same 14-day email notice that applies to the
          Privacy Policy.
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
