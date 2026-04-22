import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { PLAN_LIMITS } from "@/lib/pricing-config";

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
  const planConf = PLAN_LIMITS[planId] || PLAN_LIMITS[FREE_PLAN];
  const status = String(data?.status || "").toLowerCase();
  // Paid subscription must be "active" or "trialing" to unlock premium tiers.
  // Anything else (past_due, canceled, unpaid, inactive) downgrades to free.
  const isPaidPlan = planId !== FREE_PLAN;
  const isActive = !isPaidPlan || status === "active" || status === "trialing";
  const effectivePlan = isActive ? planId : FREE_PLAN;
  const effectiveConf = PLAN_LIMITS[effectivePlan] || PLAN_LIMITS[FREE_PLAN];

  return {
    planId: effectivePlan,
    modelTier: effectiveConf.modelTier,
    isGuest: false,
    isActive,
    // Stripe customer may exist even for downgraded plans (e.g. canceled
    // subscription): lets the UI offer "Manage subscription" so the user can
    // re-subscribe or update payment without starting a fresh checkout.
    hasStripeCustomer: Boolean(data?.has_stripe_customer),
    loading: isLoading || authLoading,
  };
}
