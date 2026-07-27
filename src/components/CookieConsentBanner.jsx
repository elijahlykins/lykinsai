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
      className="fixed inset-x-0 bottom-0 z-[10000] border-t border-black/10 dark:border-white/12 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md"
    >
      <div className="mx-auto max-w-6xl px-4 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-[13px] leading-none text-black/70 dark:text-white/75 min-w-0">
          We use cookies for analytics.{" "}
          <Link
            to="/cookies"
            className="underline underline-offset-2 hover:text-black/90 dark:hover:text-white/90"
          >
            Cookie Policy
          </Link>
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setCookieConsent(true)}
            className="inline-flex items-center justify-center rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-[13px] font-semibold px-3.5 py-2 transition-colors"
          >
            Accept cookies
          </button>
          <button
            type="button"
            onClick={() => setCookieConsent(false)}
            className="inline-flex items-center justify-center rounded-xl border border-black/12 dark:border-white/15 bg-transparent hover:bg-black/[0.04] dark:hover:bg-white/[0.06] text-black/80 dark:text-white/85 text-[13px] font-medium px-3.5 py-2 transition-colors"
          >
            Reject cookies
          </button>
        </div>
      </div>
    </div>
  );
}
