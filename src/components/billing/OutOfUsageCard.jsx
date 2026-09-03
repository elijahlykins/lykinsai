import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { X, Wallet } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";

// Don't auto-reopen for this long after a dismiss — a burst of parallel
// requests all failing with 402 shouldn't re-pop the card the user just
// closed. A fresh failure after the cooldown shows it again.
const REOPEN_COOLDOWN_MS = 60_000;

// Billing/marketing/auth surfaces where the card is redundant noise.
const HIDDEN_PATHS = new Set([
  "/billing",
  "/start-trial",
  "/pricing",
  "/login",
  "/desktop-auth",
  "/billing/success",
  "/billing/cancel",
]);

/**
 * Hard-stop glass card shown the moment any request fails because the usage
 * balance is empty. Listens for the global `lykn:out-of-usage` event, which
 * is dispatched by the fetch interceptor (plain 402s) and the chat stream
 * runner (mid-stream billing errors). One canonical out-of-usage moment —
 * individual features don't render their own version of this message.
 */
export default function OutOfUsageCard() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const lastDismissAt = useRef(0);

  useEffect(() => {
    const onOutOfUsage = (event) => {
      if (Date.now() - lastDismissAt.current < REOPEN_COOLDOWN_MS) return;
      const detail = event?.detail || {};
      setMessage(String(detail.message || "").trim());
      setOpen(true);
    };
    window.addEventListener("lykn:out-of-usage", onOutOfUsage);
    return () => window.removeEventListener("lykn:out-of-usage", onOutOfUsage);
  }, []);

  const dismiss = useCallback(() => {
    lastDismissAt.current = Date.now();
    setOpen(false);
  }, []);

  if (!open || !user) return null;
  if (HIDDEN_PATHS.has(location.pathname)) return null;

  const goToBilling = () => {
    dismiss();
    navigate("/billing");
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label="Out of usage"
    >
      {/* Scrim — click to dismiss */}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="absolute inset-0 cursor-default bg-black/25 backdrop-blur-[2px] dark:bg-black/45"
      />

      <div className="relative w-full max-w-[380px] rounded-3xl border border-black/[0.08] bg-white/85 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.25)] backdrop-blur-2xl dark:border-white/10 dark:bg-[#101218]/90 dark:shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-md p-1 text-black/35 transition-colors hover:bg-black/5 hover:text-black/70 dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white/80"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500/12 dark:bg-blue-500/15">
          <Wallet className="h-5 w-5 text-blue-500 dark:text-blue-400" />
        </div>

        <h2 className="mt-4 text-[17px] font-semibold leading-snug text-black dark:text-white">
          You&apos;re out of usage
        </h2>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-black/55 dark:text-white/55">
          {message || "Your usage balance is empty. Top up to continue, or upgrade to a plan with chat included and monthly usage built in."}
        </p>

        <button
          type="button"
          onClick={goToBilling}
          className="mt-5 w-full rounded-xl bg-black py-2.5 text-sm font-semibold text-white transition-transform hover:scale-[1.01] dark:bg-white dark:text-[#0b0c10]"
        >
          Top up to continue
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="mt-2 w-full rounded-xl py-2 text-[13px] font-medium text-black/45 transition-colors hover:text-black/70 dark:text-white/40 dark:hover:text-white/70"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
