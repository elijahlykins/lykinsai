/**
 * Free tier: every authenticated user may use the app. Paid plans (Pro)
 * unlock higher limits and frontier models via PLAN_LIMITS, but no one is
 * locked out of the app itself anymore. The `billing` arg is kept for
 * call-site compatibility (and to honor an explicit comp flag).
 */
export function hasAppAccess(billing) {
  void billing;
  return true;
}

/** Trials were removed in favor of the free tier; no checkout gate remains. */
export function needsTrialCheckout(billing) {
  void billing;
  return false;
}

const SUBSCRIPTION_GATE_EXACT = new Set([
  "/start-trial",
  "/login",
  "/privacy",
  "/terms",
  "/cookies",
  "/dpa",
  "/",
  "/landing",
  "/glass",
  "/share",
]);

const SUBSCRIPTION_GATE_PREFIXES = ["/apps/", "/s/"];

/** Routes signed-in users may visit before completing trial checkout. */
export function isSubscriptionGateExempt(pathname) {
  if (SUBSCRIPTION_GATE_EXACT.has(pathname)) return true;
  return SUBSCRIPTION_GATE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
