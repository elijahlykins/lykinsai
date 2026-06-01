/** True when the user may use the app (trialing, paying, or comped). */
export function hasAppAccess(billing) {
  if (!billing) return false;
  if (billing.comped) return true;
  if (billing.has_active_subscription === true) return true;
  if (!billing.stripe_subscription_id && billing.has_stripe_customer) {
    // Legacy payload without subscription id — fall back to status.
    const status = String(billing.status || "").toLowerCase();
    return ["trialing", "active", "past_due"].includes(status);
  }
  if (billing.needs_trial_checkout === false) return true;
  if (billing.needs_trial_checkout === true) return false;
  const status = String(billing.status || "").toLowerCase();
  return (
    Boolean(billing.stripe_subscription_id) &&
    ["trialing", "active", "past_due"].includes(status)
  );
}

export function needsTrialCheckout(billing) {
  if (!billing) return true;
  if (billing.comped) return false;
  if (typeof billing.needs_trial_checkout === "boolean") {
    return billing.needs_trial_checkout;
  }
  return !hasAppAccess(billing);
}

const SUBSCRIPTION_GATE_EXACT = new Set([
  "/start-trial",
  "/login",
  "/privacy",
  "/terms",
  "/cookies",
  "/dpa",
  "/",
  "/landing-prototype",
  "/share",
]);

const SUBSCRIPTION_GATE_PREFIXES = ["/apps/", "/s/"];

/** Routes signed-in users may visit before completing trial checkout. */
export function isSubscriptionGateExempt(pathname) {
  if (SUBSCRIPTION_GATE_EXACT.has(pathname)) return true;
  return SUBSCRIPTION_GATE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
