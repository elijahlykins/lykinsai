import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { X, Sparkles } from "lucide-react";
import { useUserPlan } from "@/lib/useUserPlan";

// Show the nudge once a prepaid (no subscription) account's usage balance
// drops below this many microdollars ($1.00).
const LOW_BALANCE_MICROS = 1_000_000;
const DISMISS_KEY = "lykn:usage-nudge-dismissed";

// Routes where an upgrade nudge would be noise (already on a billing surface,
// or mid-auth/marketing).
const HIDDEN_PATHS = new Set([
  "/billing",
  "/start-trial",
  "/pricing",
  "/login",
  "/desktop-auth",
  "/billing/success",
  "/billing/cancel",
]);

function readDismissed() {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Small floating card that warns prepaid accounts when their usage balance is
 * almost gone and offers a one-click jump to the billing page. Dismissal lasts
 * for the session; the server-side 402 still backstops at exactly zero.
 */
export default function UsageNudge() {
  const { isGuest, hasActiveSubscription, usageBalance, outOfUsage, loading } = useUserPlan();
  const location = useLocation();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (loading || isGuest || dismissed) return null;
  if (HIDDEN_PATHS.has(location.pathname)) return null;
  // Subscribers have included chat plus monthly usage; don't nag them here.
  if (hasActiveSubscription) return null;
  if (!usageBalance) return null;

  const available = Number(usageBalance.available_micros || 0);
  // Above the threshold: too early. Fully out: the hard 402 owns the moment —
  // a nudge on top of it is just clutter.
  if (outOfUsage || available <= 0 || available >= LOW_BALANCE_MICROS) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* best-effort */
    }
  };

  return (
    <div className="fixed bottom-5 right-5 z-[90] w-[320px] rounded-2xl border border-white/10 bg-[#101218]/95 p-4 text-white shadow-[0_20px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-3 top-3 rounded-md p-1 text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
      >
        <X className="h-4 w-4" />
      </button>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-blue-500/15">
          <Sparkles className="h-4 w-4 text-blue-400" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-snug">
            Your usage balance is almost out
          </p>
          <p className="mt-1 text-[13px] leading-snug text-white/60">
            {usageBalance.available_usd || "Less than $1.00"} left. Top up or
            upgrade to a plan with chat included to keep going without
            interruption.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => {
          dismiss();
          navigate("/billing");
        }}
        className="mt-3 w-full rounded-xl bg-white py-2 text-sm font-semibold text-[#0b0c10] transition-transform hover:scale-[1.02]"
      >
        Keep using LYKN
      </button>
    </div>
  );
}
