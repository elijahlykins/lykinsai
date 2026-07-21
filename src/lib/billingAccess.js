import { PLAN_LIMITS } from "@/lib/pricing-config";

/**
 * True when the user may use the app (trialing, paying, comped, or a
 * canceled sub still inside its paid period).
 *
 * The server (`billingMePayload` → `hasAppAccessRow`) is authoritative: it
 * implements revoke-on-period-end, so once a canceled subscription's
 * `current_period_end` passes the user loses access. We trust its
 * `needs_trial_checkout` flag and only fall back to local status checks for
 * legacy payloads that don't carry it.
 */
export function hasAppAccess(billing) {
  if (!billing) return false;
  if (billing.comped) return true;
  if (typeof billing.needs_trial_checkout === "boolean") {
    return !billing.needs_trial_checkout;
  }
  // Legacy / partial payload fallback: active subscription or a manual paid
  // plan on file with no Stripe sub (admin-granted).
  if (billing.has_active_subscription === true) return true;
  const rawPlan = String(billing.plan || "free").toLowerCase();
  if (!billing.stripe_subscription_id && rawPlan !== "free" && PLAN_LIMITS[rawPlan]) {
    return true;
  }
  const status = String(billing.status || "").toLowerCase();
  return (
    Boolean(billing.stripe_subscription_id) &&
    ["trialing", "active", "past_due"].includes(status)
  );
}

/** True when the signed-in user still has to pass the trial-checkout wall. */
export function needsTrialCheckout(billing) {
  if (!billing) return true;
  if (billing.comped) return false;
  if (typeof billing.needs_trial_checkout === "boolean") {
    return billing.needs_trial_checkout;
  }
  return !hasAppAccess(billing);
}

// Marketing / legal / auth surfaces stay reachable without a subscription —
// everything else redirects to /start-trial until checkout is done.
// `/oauth/consent` must stay exempt: it arrives with client_id / redirect_uri /
// PKCE params from an external tool (MCP, Claude, Cursor), and a Navigate to
// /start-trial would drop them and break the connect flow entirely.
const SUBSCRIPTION_GATE_EXACT = new Set([
  "/start-trial",
  "/login",
  "/reset-password",
  "/desktop-auth",
  "/oauth/consent",
  "/privacy",
  "/terms",
  "/cookies",
  "/dpa",
  "/support",
  "/",
  "/landing",
  "/glass",
  "/share",
  "/pricing",
  "/download",
  "/news",
  "/mobile",
]);

const SUBSCRIPTION_GATE_PREFIXES = ["/apps/", "/s/", "/news/", "/product/"];

/** Routes signed-in users may visit before completing trial checkout. */
export function isSubscriptionGateExempt(pathname) {
  if (SUBSCRIPTION_GATE_EXACT.has(pathname)) return true;
  return SUBSCRIPTION_GATE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
