// Google Analytics 4 (gtag) helpers + cookie consent storage.
// Tag loads from index.html with Consent Mode defaults denied; this module
// restores a prior choice and updates consent / SPA page views.

export const GA_MEASUREMENT_ID = "G-Q4KSD1G8YF";
export const COOKIE_CONSENT_KEY = "lykn_cookie_consent";
export const COOKIE_CONSENT_EVENT = "lykn:cookie-consent";
export const MANAGE_COOKIES_EVENT = "lykn:manage-cookies";

/** @typedef {{ analytics: boolean, decidedAt: string }} CookieConsent */

export function isAnalyticsRuntime() {
  if (typeof window === "undefined") return false;
  // Desktop Glass shell is not the marketing/web property.
  if (window.lykn?.desktop) return false;
  return true;
}

/** @returns {CookieConsent | null} */
export function getCookieConsent() {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.analytics !== "boolean") return null;
    return {
      analytics: parsed.analytics,
      decidedAt: typeof parsed.decidedAt === "string" ? parsed.decidedAt : "",
    };
  } catch {
    return null;
  }
}

function emitConsent(consent) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(COOKIE_CONSENT_EVENT, { detail: consent }),
  );
}

function gtag(...args) {
  if (typeof window === "undefined") return;
  if (typeof window.gtag === "function") {
    window.gtag(...args);
    return;
  }
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push(args);
}

/** Apply Consent Mode v2 flags to the loaded Google tag. */
export function applyAnalyticsConsent(granted) {
  if (!isAnalyticsRuntime()) return;
  gtag("consent", "update", {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: granted ? "granted" : "denied",
  });
}

/** Persist choice, update gtag, notify listeners. */
export function setCookieConsent(analyticsGranted) {
  if (typeof window === "undefined") return null;
  const consent = {
    analytics: !!analyticsGranted,
    decidedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify(consent));
  } catch {
    // Private mode / blocked storage — still update the tag for this session.
  }
  applyAnalyticsConsent(consent.analytics);
  emitConsent(consent);
  return consent;
}

/** Clear stored choice so the banner can ask again. */
export function resetCookieConsent() {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(COOKIE_CONSENT_KEY);
  } catch {
    // ignore
  }
  applyAnalyticsConsent(false);
  emitConsent(null);
}

/** Restore consent from localStorage on boot (before first paint interactions). */
export function initAnalyticsConsent() {
  if (!isAnalyticsRuntime()) return;
  const existing = getCookieConsent();
  if (existing) {
    applyAnalyticsConsent(existing.analytics);
  }
}

export function trackPageview(path) {
  if (!isAnalyticsRuntime()) return;
  const pagePath =
    path ||
    `${window.location.pathname}${window.location.search}${window.location.hash}`;
  gtag("event", "page_view", {
    page_path: pagePath,
    page_location: window.location.href,
    page_title: document.title,
    send_to: GA_MEASUREMENT_ID,
  });
}

/** Re-open the consent banner (e.g. from Cookie Policy). */
export function openCookiePreferences() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MANAGE_COOKIES_EVENT));
}
