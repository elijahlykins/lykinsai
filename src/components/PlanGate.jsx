import React from "react";
import { useNavigate } from "react-router-dom";
import { Lock, Sparkles } from "lucide-react";
import { useUserPlan } from "@/lib/useUserPlan";
import { PLAN_LIMITS } from "@/lib/pricing-config";

// Plans ordered cheapest → priciest. `minPlan` means "allow this plan and any
// plan above it".
const PLAN_ORDER = ["free", "studio", "studio_pro", "studio_max"];

function planRank(planId) {
  const idx = PLAN_ORDER.indexOf(String(planId || "free"));
  return idx === -1 ? 0 : idx;
}

function planLabel(planId) {
  switch (planId) {
    case "studio": return "Studio";
    case "studio_pro": return "Studio Pro";
    case "studio_max": return "Studio Max";
    case "free":
    default: return "Free";
  }
}

/**
 * Gate a route (or any subtree) behind a minimum plan tier.
 *
 * Usage:
 *   <PlanGate minPlan="studio" feature="Mind Map">
 *     <SynthesisLayer />
 *   </PlanGate>
 *
 * Props:
 *   - minPlan: "free" | "studio" | "studio_pro" | "studio_max" — the lowest
 *     plan that can access the children.
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
  const nav = useNavigate();

  if (loading) return loadingFallback;

  if (planRank(planId) >= planRank(minPlan)) {
    return <>{children}</>;
  }

  if (fallback) return fallback;

  const minLabel = planLabel(minPlan);
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
            className="flex-1 py-2 px-4 rounded-lg bg-blue-500 text-white text-sm font-semibold hover:bg-blue-600 transition-colors inline-flex items-center justify-center gap-1.5"
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
