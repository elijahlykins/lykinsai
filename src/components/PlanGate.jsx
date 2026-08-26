import React from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Sparkles, X } from "lucide-react";
import { useUserPlan } from "@/lib/useUserPlan";
import { useAuth } from "@/lib/SupabaseAuth";
import { PLAN_LIMITS, planLabel } from "@/lib/pricing-config";

// Access rank by entitlement, not price. `free` is the floor; every paid tier
// (Student + Pro + legacy ids) shares full access, so they rank equal. Mirrors
// PLAN_RANK in server.js.
const PLAN_RANK = {
  free: 0,
  student: 1,
  studio: 1,
  studio_pro: 1,
  studio_max: 1,
  max: 2,
};

function planRank(planId) {
  return PLAN_RANK[String(planId || "free").toLowerCase()] ?? 0;
}

/**
 * Gate a route (or any subtree) behind a minimum plan tier.
 *
 * Usage:
 *   <PlanGate minPlan="studio" feature="Advanced models">
 *     <ModelPicker />
 *   </PlanGate>
 *
 * Props:
 *   - minPlan: "free" | "studio" — the lowest plan that can access the
 *     children. (User-facing labels: Free / Pro.)
 *   - feature: human-readable feature name shown in the paywall.
 *   - description: optional extra copy under the title.
 *   - fallback: if provided, rendered instead of the default paywall.
 *   - loadingFallback: rendered while the plan is resolving (defaults to a
 *     blank full-screen placeholder so nothing flashes).
 */
export default function PlanGate({
  minPlan = "studio",
  feature = "This feature",
  description,
  children,
  fallback,
  loadingFallback = null,
}) {
  const { planId, loading, isGuest } = useUserPlan();
  const { signInWithOAuth } = useAuth();
  const nav = useNavigate();

  if (loading) return loadingFallback;

  if (planRank(planId) >= planRank(minPlan)) {
    return <>{children}</>;
  }

  if (fallback) return fallback;

  const minLabel = planLabel(minPlan);

  if (isGuest) {
    return (
      <div className="fixed inset-0 z-[220] bg-[var(--app-background,#ececeb)] overflow-y-auto">
        <button
          type="button"
          onClick={() => nav(-1)}
          className="absolute top-3 right-3 w-7 h-7 rounded-md inline-flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/75 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          aria-label="Close sign-in blocker"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="min-h-full w-full flex items-center justify-center px-6 py-10">
          <div className="w-full max-w-xs text-center">
            <p className="mb-2 text-[1.75rem] leading-tight font-medium text-black/90 dark:text-white/90">
              Improve your LYKN experience
            </p>
            <h2 className="text-xs font-semibold tracking-[0.03em] text-black/45 dark:text-white/45">
            Sign in or sign up to continue
            </h2>

            <div className="mt-5 space-y-2">
              <button
                type="button"
                onClick={() => signInWithOAuth("google")}
                className="w-full rounded-lg bg-[#1f1f1d] text-white px-4 py-2.5 text-sm font-semibold hover:bg-[#292926] transition-colors"
              >
                Continue with Google
              </button>
              <button
                type="button"
                onClick={() => nav("/login")}
                className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 text-black/70 dark:text-white/70 px-4 py-2.5 text-sm font-medium hover:bg-white dark:hover:bg-white/10 transition-colors"
              >
                Continue with email
              </button>
            </div>

            <button
              type="button"
              onClick={() => nav(-1)}
              className="mt-6 w-full rounded-lg px-4 py-2 text-sm text-black/55 dark:text-white/55 hover:bg-black/[0.03] dark:hover:bg-white/5 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-[100svh] flex items-center justify-center bg-[var(--app-background,transparent)] p-6">
      <div className="max-w-md w-full rounded-2xl border border-black/10 dark:border-white/10 bg-white/80 dark:bg-white/5 backdrop-blur-md p-8 shadow-lg">
        <div className="w-12 h-12 rounded-2xl bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center mb-4">
          <Lock className="w-6 h-6 text-amber-500 dark:text-amber-400" />
        </div>
        <h2 className="text-lg font-semibold text-black/85 dark:text-white/90 mb-1.5">
          {feature} needs {minLabel}
        </h2>
        <p className="text-sm text-black/55 dark:text-white/55 leading-relaxed mb-6">
          {description || `Your ${planLabel(planId)} plan doesn't include ${feature.toLowerCase()} yet. Upgrade to ${minLabel} to unlock it.`}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => nav(-1)}
            className="flex-1 py-2 px-4 rounded-lg border border-black/10 dark:border-white/10 text-sm font-medium text-black/65 dark:text-white/60 hover:bg-black/[0.03] dark:hover:bg-white/5 transition-colors"
          >
            Go back
          </button>
          <button
            type="button"
            onClick={() => nav(isGuest ? "/login" : "/billing")}
            className="flex-1 py-2 px-4 rounded-lg border border-blue-300/30 bg-blue-950 text-blue-200 text-sm font-semibold hover:bg-blue-900 transition-colors inline-flex items-center justify-center gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {isGuest ? "Sign in" : "View plans"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Pure helper — returns true if the caller's plan meets or exceeds `minPlan`.
 * Safe to call outside React (doesn't read from the hook).
 */
export function planMeets(currentPlan, minPlan) {
  return planRank(currentPlan) >= planRank(minPlan);
}

// Re-exported so callers can reason about limits without pulling
// pricing-config directly.
export { PLAN_LIMITS };
