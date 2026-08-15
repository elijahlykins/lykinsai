import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { X, Sparkles } from "lucide-react";
import { useUserPlan } from "@/lib/useUserPlan";

// Show the nudge once the free allowance is this far gone.
const NUDGE_THRESHOLD = 0.9;
const DISMISS_KEY = "lykn:free-credits-nudge-dismissed";

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
 * Small floating card that warns free accounts when they're almost out of
 * their signup credit allowance (FREE_PLAN_CREDITS server-side) and offers a
 * one-click jump to the billing page. Dismissal lasts for the session; the
 * hard 402 paywall still backstops when credits fully run out.
 */
export default function FreeCreditsNudge() {
  const { isGuest, freeCredits, loading } = useUserPlan();
  const location = useLocation();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (loading || isGuest || dismissed) return null;
  if (HIDDEN_PATHS.has(location.pathname)) return null;
  if (!freeCredits || !freeCredits.limit) return null;

  const fraction = freeCredits.used / freeCredits.limit;
  // Under the threshold: too early. Nothing remaining: the hard paywall owns
  // the moment — a nudge on top of it is just clutter.
  if (fraction < NUDGE_THRESHOLD || freeCredits.remaining <= 0) return null;

  const pct = Math.min(100, Math.round(fraction * 100));

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
            You&apos;re almost out of the free version
          </p>
          <p className="mt-1 text-[13px] leading-snug text-white/60">
            {pct}% of your free credits are used. Upgrade to keep using LYKN
            without interruption.
          </p>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400"
          style={{ width: `${pct}%` }}
        />
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
