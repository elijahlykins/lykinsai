import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { PLAN_LIMITS } from "@/lib/pricing-config";
import { hasAppAccess } from "@/lib/billingAccess";

const FREE_PLAN = "free";

async function fetchBilling() {
  const res = await fetch(`${API_BASE_URL}/api/billing/me`);
  if (!res.ok) throw new Error(`billing/me ${res.status}`);
  return res.json();
}

function resolvePlanId(billing) {
  const raw = String(billing?.plan || "").toLowerCase();
  if (PLAN_LIMITS[raw]) return raw;
  return FREE_PLAN;
}

/**
 * Returns the current user's plan + model tier. For guests (not signed in)
 * always returns the basic tier — the server already enforces this via the
 * guest chat endpoint. For signed-in users it fetches `/api/billing/me` once
 * per session (react-query cached) and derives the tier from PLAN_LIMITS.
 *
 * @returns {{
 *   planId: "free" | "studio" | "studio_pro" | "studio_max",
 *   modelTier: "basic" | "top" | "top+media",
 *   isGuest: boolean,
 *   isActive: boolean,
 *   loading: boolean,
 * }}
 */
export function useUserPlan() {
  const { user, loading: authLoading } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["billing-me", user?.id || "guest"],
    queryFn: fetchBilling,
    enabled: Boolean(user?.id),
    staleTime: 5_000,
    gcTime: 60_000,
    retry: 1,
  });

  if (!user) {
    return {
      planId: FREE_PLAN,
      modelTier: PLAN_LIMITS[FREE_PLAN].modelTier,
      isGuest: true,
      isActive: false,
      hasStripeCustomer: false,
      loading: authLoading,
    };
  }

  const planId = resolvePlanId(data);
  const status = String(data?.status || "").toLowerCase();
  // Monotone-up rule (client side): once a user has reached a paid
  // tier, we honor it forever — `status` is informational only.
  // The server enforces the same rule in resolveUserPlan +
  // syncSubscriptionToBilling, so client/server stay aligned and a
  // canceled or past-due Stripe sub never locks the user out of
  // features they've paid for. Admin can still force-downgrade via
  // scripts/set-user-plan.mjs, which writes plan='free' directly and
  // therefore falls through naturally.
  const effectiveConf = PLAN_LIMITS[planId] || PLAN_LIMITS[FREE_PLAN];
  const isPaidPlan = planId !== FREE_PLAN;
  // `isActive` here means "billing is currently in good standing" —
  // it's now decoupled from access and is just a UI signal so the
  // billing page can show "Past due — update payment" banners without
  // gating any feature on it.
  const isBillingHealthy = !isPaidPlan || status === "active" || status === "trialing";

  return {
    planId,
    modelTier: effectiveConf.modelTier,
    isGuest: false,
    isActive: isBillingHealthy,
    hasAppAccess: hasAppAccess(data),
    // Stripe customer may exist even when status is past_due / canceled:
    // lets the UI offer "Manage subscription" so the user can update
    // payment without starting a fresh checkout.
    hasStripeCustomer: Boolean(data?.has_stripe_customer),
    loading: isLoading || authLoading,
  };
}
