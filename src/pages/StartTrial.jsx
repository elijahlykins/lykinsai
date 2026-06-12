import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { loadStripe } from "@stripe/stripe-js";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { hasAppAccess } from "@/lib/billingAccess";
import { toBillingCheckoutError } from "@/lib/billingCheckoutErrors";
import { isConnectOnboardingDone } from "@/lib/prototypeHandoff";
import { supabase } from "@/lib/supabase";
import {
  PLANS,
  BILLING_PERIODS,
  getDisplayPrice,
  getAnnualSavings,
} from "@/lib/pricing-config";

const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

// Plans the trial picker offers: the checkout-able, currently-available tiers
// (Student, Pro). Teams/coming-soon plans are excluded.
const TRIAL_PLANS = PLANS.filter(
  (p) => p.checkout !== false && !p.comingSoon,
);

function formatPrice(value) {
  if (value === 0) return "$0";
  return `$${value % 1 === 0 ? value : value.toFixed(2)}`;
}

function isFreshlyCreatedUser(user) {
  if (!user?.created_at) return false;
  const createdMs = Date.parse(user.created_at);
  if (!Number.isFinite(createdMs)) return false;
  return Date.now() - createdMs < NEW_USER_WINDOW_MS;
}

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchBillingMe() {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE_URL}/api/billing/me`, { headers });
  if (!res.ok) throw new Error(`billing/me ${res.status}`);
  return res.json();
}

async function fetchStripePublishableKey() {
  const res = await fetch(`${API_BASE_URL}/api/billing/stripe-config`);
  if (!res.ok) throw new Error(`stripe-config ${res.status}`);
  const json = await res.json().catch(() => ({}));
  if (!json?.publishableKey) throw new Error("missing publishable key");
  return json.publishableKey;
}

// `mode` is "embedded" (on-site Stripe Checkout) or "hosted" (redirect to
// stripe.com). The Stripe customer + subscription are only created when this
// request fires — i.e. when the user explicitly clicks "Start free trial" —
// so we no longer spawn phantom customers for everyone who merely loads the
// page.
async function startTrialCheckout(mode, plan, period) {
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
  };
  const res = await fetch(`${API_BASE_URL}/api/billing/trial-checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode, plan, period }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.message || json?.error || "Checkout failed");
    err.code = json?.error;
    throw err;
  }
  return json;
}

function postTrialDestination(user) {
  if (isFreshlyCreatedUser(user) && !isConnectOnboardingDone()) {
    return "/onboarding/connect";
  }
  return "/app";
}

async function returnToLandingSignIn() {
  try {
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Best-effort — still send them back to the wake sign-in slide.
  }
  window.location.assign("/?resume=account");
}

export default function StartTrial() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const checkoutResult = searchParams.get("checkout");
  // Phases:
  //   loading    — resolving auth / existing access
  //   intro      — on-site trial offer with an explicit "Start free trial" CTA
  //   starting   — CTA clicked, creating the checkout session
  //   checkout   — embedded Stripe Checkout mounted on-site
  //   confirming — returned from checkout, polling for activation
  //   returning  — user canceled, bouncing back to landing
  //   error      — something failed
  const [phase, setPhase] = useState(() => {
    if (checkoutResult === "success") return "confirming";
    if (checkoutResult === "canceled") return "returning";
    return "loading";
  });
  const [error, setError] = useState(null);
  const [clientSecret, setClientSecret] = useState(null);
  const [publishableKey, setPublishableKey] = useState(null);
  const [period, setPeriod] = useState("annual");
  // Which plan's "Start free trial" button is mid-flight (for the spinner).
  const [pendingPlan, setPendingPlan] = useState(null);
  const cancelHandledRef = useRef(false);

  const stripePromise = useMemo(
    () => (publishableKey ? loadStripe(publishableKey) : null),
    [publishableKey],
  );

  const pollUntilActive = useCallback(async () => {
    for (let i = 0; i < 20; i += 1) {
      const billing = await fetchBillingMe();
      if (hasAppAccess(billing)) return billing;
      await new Promise((r) => window.setTimeout(r, 1500));
    }
    return null;
  }, []);

  // Fall back to the hosted Stripe page if embedded checkout can't initialize
  // (e.g. publishable key not configured) so the signup path never hard-breaks.
  const beginHostedCheckout = useCallback(
    async (plan) => {
      const payload = await startTrialCheckout("hosted", plan, period);
      if (!payload?.url) throw new Error("Missing checkout session");
      window.location.assign(payload.url);
    },
    [period],
  );

  const beginCheckout = useCallback(
    async (plan) => {
      const planId = plan || "studio";
      setError(null);
      setPendingPlan(planId);
      setPhase("starting");
      try {
        // Don't double-charge a user who already converted in another tab.
        const billing = await fetchBillingMe();
        if (hasAppAccess(billing)) {
          navigate(postTrialDestination(user), { replace: true });
          return;
        }

        // Preferred path: on-site embedded checkout.
        try {
          const key = await fetchStripePublishableKey();
          const payload = await startTrialCheckout("embedded", planId, period);
          if (!payload?.client_secret) throw new Error("missing client secret");
          setPublishableKey(key);
          setClientSecret(payload.client_secret);
          setPhase("checkout");
          return;
        } catch (embeddedErr) {
          if (embeddedErr?.code === "already_subscribed") {
            navigate(postTrialDestination(user), { replace: true });
            return;
          }
          // Embedded unavailable — fall back to the hosted redirect.
          await beginHostedCheckout(planId);
        }
      } catch (err) {
        if (err?.code === "already_subscribed") {
          navigate(postTrialDestination(user), { replace: true });
          return;
        }
        setError(toBillingCheckoutError(err));
        setPhase("error");
      }
    },
    [navigate, user, beginHostedCheckout, period],
  );

  useEffect(() => {
    if (authLoading) return;

    if (checkoutResult === "canceled") {
      if (cancelHandledRef.current) return;
      cancelHandledRef.current = true;
      setPhase("returning");
      void returnToLandingSignIn();
      return;
    }

    if (!user) return;

    if (checkoutResult === "success") {
      (async () => {
        setPhase("confirming");
        setError(null);
        try {
          const billing = await pollUntilActive();
          if (!billing) {
            setError(
              "Payment received. Your trial is still activating. Refresh in a moment or contact support if this persists.",
            );
            setPhase("error");
            return;
          }
          navigate(postTrialDestination(user), { replace: true });
        } catch (err) {
          setError(toBillingCheckoutError(err));
          setPhase("error");
        }
      })();
      return;
    }

    // Default: resolve existing access, then show the on-site offer. We do NOT
    // auto-start checkout anymore — a Stripe customer should only be created
    // when the user explicitly chooses to start the trial.
    let cancelled = false;
    (async () => {
      try {
        const billing = await fetchBillingMe();
        if (cancelled) return;
        if (hasAppAccess(billing)) {
          navigate(postTrialDestination(user), { replace: true });
          return;
        }
        setPhase("intro");
      } catch {
        if (!cancelled) setPhase("intro");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, checkoutResult, navigate, pollUntilActive]);

  if (
    !authLoading &&
    !user &&
    checkoutResult !== "canceled" &&
    phase !== "returning"
  ) {
    return <Navigate to="/login" replace state={{ from: { pathname: "/start-trial" } }} />;
  }

  if (phase === "loading" || phase === "confirming" || phase === "returning") {
    return (
      <div className="dark lykn-wake-stage relative w-screen min-h-screen overflow-hidden flex items-center justify-center">
        <div className="lykn-wake-start-trial-spinner" aria-hidden aria-label="Loading" />
      </div>
    );
  }

  if (phase === "checkout" && stripePromise && clientSecret) {
    return (
      <div className="dark lykn-wake-stage relative w-screen min-h-screen overflow-y-auto flex items-start justify-center py-8">
        <div className="w-full max-w-xl px-4">
          <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="dark lykn-wake-stage relative w-screen min-h-screen overflow-hidden flex flex-col">
        <div className="lykn-wake-start-trial">
          <div className="lykn-wake-start-trial-inner">
            <h1 className="lykn-wake-start-trial-title">Could not start checkout</h1>
            <p className="lykn-wake-start-trial-copy">{error}</p>
            <button
              type="button"
              className="lykn-wake-account-submit-btn lykn-wake-start-trial-retry"
              onClick={() => beginCheckout(pendingPlan)}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // intro / starting — a billing-style plan picker framed as a free trial.
  const starting = phase === "starting";
  const isAnnual = period === BILLING_PERIODS.ANNUAL;
  return (
    <div className="dark lykn-wake-stage relative w-screen min-h-screen overflow-y-auto flex flex-col items-center justify-center py-12 px-4">
      <div className="w-full max-w-3xl text-center">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs font-semibold text-emerald-300">
          <span aria-hidden>✦</span> 7 days free, then pick up where you left off
        </span>
        <h1 className="mt-4 text-3xl sm:text-4xl font-semibold tracking-tight text-white">
          Start your 7-day free trial
        </h1>
        <p className="mt-3 text-base text-white/60 max-w-xl mx-auto leading-relaxed">
          Choose your plan below. <strong className="text-white">$0 due today</strong>
          {" "}— we won&apos;t charge you until the trial ends, and you can cancel
          anytime before then.
        </p>

        {/* Billing period toggle */}
        <div
          className="mt-7 inline-flex rounded-xl border border-white/12 bg-white/[0.04] p-1"
          role="group"
          aria-label="Billing period"
        >
          <button
            type="button"
            onClick={() => setPeriod(BILLING_PERIODS.MONTHLY)}
            aria-pressed={period === BILLING_PERIODS.MONTHLY}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              period === BILLING_PERIODS.MONTHLY
                ? "bg-white/12 text-white"
                : "text-white/55 hover:text-white/80"
            }`}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setPeriod(BILLING_PERIODS.ANNUAL)}
            aria-pressed={period === BILLING_PERIODS.ANNUAL}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              period === BILLING_PERIODS.ANNUAL
                ? "bg-white/12 text-white"
                : "text-white/55 hover:text-white/80"
            }`}
          >
            Annual
            <span className="ml-1.5 text-xs text-emerald-400">Save</span>
          </button>
        </div>

        {/* Plan cards */}
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {TRIAL_PLANS.map((plan) => {
            const price = getDisplayPrice(plan, period);
            const savings = getAnnualSavings(plan);
            const planBusy = starting && pendingPlan === plan.id;
            return (
              <div
                key={plan.id}
                className={`relative flex flex-col rounded-2xl border p-6 text-left ${
                  plan.highlighted
                    ? "border-white/25 bg-white/[0.06] ring-1 ring-white/10"
                    : "border-white/10 bg-white/[0.03]"
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-white">{plan.name}</h3>
                  {plan.badge && (
                    <span className="rounded-md bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white/85">
                      {plan.badge}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-white/45">
                  {plan.tagline}
                </p>

                <div className="mt-4">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-3xl font-bold tracking-tight text-white">
                      $0
                    </span>
                    <span className="text-sm text-white/50">for 7 days</span>
                  </div>
                  <p className="mt-1 text-xs text-white/55">
                    then {formatPrice(price)}/mo
                    {isAnnual ? " billed annually" : ""}
                    {isAnnual && savings > 0 ? ` · save $${savings}/yr` : ""}
                  </p>
                </div>

                <ul className="mt-4 mb-6 flex-1 space-y-2">
                  {plan.features
                    .filter((f) => f.included)
                    .map((f) => (
                      <li
                        key={f.text}
                        className="flex items-start gap-2 text-sm text-white/75"
                      >
                        <span aria-hidden className="mt-[2px] text-emerald-400">
                          ✓
                        </span>
                        <span>{f.text}</span>
                      </li>
                    ))}
                </ul>

                <button
                  type="button"
                  className="lykn-wake-account-submit-btn w-full"
                  onClick={() => beginCheckout(plan.id)}
                  disabled={starting}
                >
                  {planBusy ? "Starting…" : "Start free trial"}
                </button>
              </div>
            );
          })}
        </div>

        <p className="mt-6 text-xs text-white/45 max-w-xl mx-auto">
          You&apos;ll add a card to start. Payments are processed securely by
          Stripe, LYKN never sees your card details.
        </p>

        <button
          type="button"
          className="mt-5 text-xs text-white/40 underline underline-offset-4 hover:text-white/70"
          onClick={returnToLandingSignIn}
          disabled={starting}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
