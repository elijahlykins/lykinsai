import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  COOKIE_CONSENT_EVENT,
  MANAGE_COOKIES_EVENT,
  getCookieConsent,
  isAnalyticsRuntime,
  resetCookieConsent,
  setCookieConsent,
} from "@/lib/analytics";

/**
 * Bottom consent bar for Google Analytics (Consent Mode).
 * Hidden in the desktop shell and embedded preview surfaces.
 */
export default function CookieConsentBanner() {
  const location = useLocation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isAnalyticsRuntime()) {
      setVisible(false);
      return;
    }
    if (location.search.includes("embedded=")) {
      setVisible(false);
      return;
    }

    const sync = () => {
      setVisible(getCookieConsent() === null);
    };
    sync();

    const onConsent = () => sync();
    const onManage = () => {
      resetCookieConsent();
      setVisible(true);
    };
    window.addEventListener(COOKIE_CONSENT_EVENT, onConsent);
    window.addEventListener(MANAGE_COOKIES_EVENT, onManage);
    return () => {
      window.removeEventListener(COOKIE_CONSENT_EVENT, onConsent);
      window.removeEventListener(MANAGE_COOKIES_EVENT, onManage);
    };
  }, [location.search]);

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie preferences"
      className="fixed inset-x-0 bottom-0 z-[10000] p-3 sm:p-4 pointer-events-none"
    >
      <div className="mx-auto max-w-2xl pointer-events-auto rounded-2xl border border-black/10 dark:border-white/12 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md shadow-[0_-4px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_-4px_40px_rgba(0,0,0,0.45)] px-4 py-4 sm:px-5 sm:py-4">
        <p className="text-[13px] leading-relaxed text-black/70 dark:text-white/75">
          We use Google Analytics to understand how people use lykn.io — page
          views and basic device info, not ads. Choose whether to allow
          analytics cookies.{" "}
          <Link
            to="/cookies"
            className="underline underline-offset-2 hover:text-black/90 dark:hover:text-white/90"
          >
            Cookie Policy
          </Link>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setCookieConsent(true)}
            className="inline-flex items-center justify-center rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3.5 py-2 transition-colors"
          >
            Accept analytics
          </button>
          <button
            type="button"
            onClick={() => setCookieConsent(false)}
            className="inline-flex items-center justify-center rounded-xl border border-black/12 dark:border-white/15 bg-transparent hover:bg-black/[0.04] dark:hover:bg-white/[0.06] text-black/80 dark:text-white/85 text-[13px] font-medium px-3.5 py-2 transition-colors"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
