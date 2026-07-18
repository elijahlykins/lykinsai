import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { loadStripe } from "@stripe/stripe-js";
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from "@stripe/react-stripe-js";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { hasAppAccess } from "@/lib/billingAccess";
import { isConnectOnboardingDone } from "@/lib/landingHandoff";
import { supabase } from "@/lib/supabase";
import {
  PLANS,
  BILLING_PERIODS,
  getDisplayPrice,
  getAnnualSavings,
} from "@/lib/pricing-config";

const LANDING_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

const DEFAULT_TRIAL_DAYS = 14;

// Plans the trial picker offers: the checkout-able, currently-available tiers.
// Teams / coming-soon plans are excluded.
const TRIAL_PLANS = PLANS.filter((p) => p.checkout !== false && !p.comingSoon);

function formatPrice(value) {
  if (value === 0) return "$0";
  return `$${value % 1 === 0 ? value : value.toFixed(2)}`;
}

function trialLabel(days) {
  if (days === 14) return "2 weeks";
  return days === 1 ? "1 day" : `${days} days`;
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

// The Stripe customer + subscription are only created when this request
// fires, i.e. when the user explicitly clicks "Start free trial". Their
// trial shows up in Stripe only after they finish checkout with a card.
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

const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

function isFreshlyCreatedUser(user) {
  if (!user?.created_at) return false;
  const createdMs = Date.parse(user.created_at);
  if (!Number.isFinite(createdMs)) return false;
  return Date.now() - createdMs < NEW_USER_WINDOW_MS;
}

// New signups still get the connect-your-AI-tools onboarding after the
// paywall; everyone else drops straight into the app.
function postTrialDestination(user) {
  if (isFreshlyCreatedUser(user) && !isConnectOnboardingDone()) {
    return "/onboarding/connect";
  }
  return "/app";
}

function checkoutErrorMessage(err) {
  const code = err?.code || "";
  if (code === "checkout_email_required") {
    return "We couldn't find an email on your account. Sign out and back in, then try again.";
  }
  if (code === "price_not_configured" || code === "stripe_not_configured") {
    return "Checkout isn't fully configured yet. Please contact support@lykn.io.";
  }
  return err?.message || "Something went wrong starting checkout. Please try again.";
}

export default function StartTrial() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const checkoutResult = searchParams.get("checkout");
  // Phases:
  //   loading    — resolving auth / existing access
  //   pick       — plan picker with explicit "Start free trial" CTAs
  //   starting   — CTA clicked, creating the checkout session
  //   checkout   — embedded Stripe Checkout mounted on-site
  //   confirming — returned from checkout, polling for activation
  //   error      — something failed
  const [phase, setPhase] = useState(() =>
    checkoutResult === "success" ? "confirming" : "loading",
  );
  const [error, setError] = useState(null);
  const [clientSecret, setClientSecret] = useState(null);
  const [publishableKey, setPublishableKey] = useState(null);
  const [period, setPeriod] = useState(BILLING_PERIODS.ANNUAL);
  const [pendingPlan, setPendingPlan] = useState(null);
  const [trialDays, setTrialDays] = useState(DEFAULT_TRIAL_DAYS);
  const queryClient = useQueryClient();

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

  const beginCheckout = useCallback(
    async (plan) => {
      const planId = plan || "studio";
      setError(null);
      setPendingPlan(planId);
      setPhase("starting");
      try {
        // Don't double-subscribe a user who already converted in another tab.
        const billing = await fetchBillingMe();
        if (hasAppAccess(billing)) {
          navigate(postTrialDestination(user), { replace: true });
          return;
        }

        // Preferred path: on-site embedded checkout (required inside the
        // desktop shell, where external redirects open the system browser).
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
          const payload = await startTrialCheckout("hosted", planId, period);
          if (!payload?.url) throw new Error("Missing checkout session");
          window.location.assign(payload.url);
        }
      } catch (err) {
        if (err?.code === "already_subscribed") {
          navigate(postTrialDestination(user), { replace: true });
          return;
        }
        setError(checkoutErrorMessage(err));
        setPhase("error");
      }
    },
    [navigate, period, user],
  );

  useEffect(() => {
    if (authLoading || !user) return;

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
          // Prime the shared billing cache so the app-shell gate doesn't
          // bounce us back here off a stale "no access" payload.
          queryClient.setQueryData(["billing-me", user.id], billing);
          navigate(postTrialDestination(user), { replace: true });
        } catch (err) {
          setError(checkoutErrorMessage(err));
          setPhase("error");
        }
      })();
      return;
    }

    // Returned from a canceled hosted checkout: clear the flag and show the
    // picker again so they can pick a different plan or sign out.
    if (checkoutResult === "canceled") {
      setSearchParams({}, { replace: true });
      setPhase("pick");
      return;
    }

    // Default: resolve existing access, then show the picker. We do NOT
    // auto-start checkout — a Stripe customer is only created when the user
    // explicitly chooses a plan.
    let cancelled = false;
    (async () => {
      try {
        const billing = await fetchBillingMe();
        if (cancelled) return;
        if (hasAppAccess(billing)) {
          navigate(postTrialDestination(user), { replace: true });
          return;
        }
        if (Number(billing?.trial_days) > 0) setTrialDays(Number(billing.trial_days));
        setPhase("pick");
      } catch {
        if (!cancelled) setPhase("pick");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, user, checkoutResult, navigate, pollUntilActive, setSearchParams, queryClient]);

  const signOutToLogin = useCallback(async () => {
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      // Best-effort — still send them to the login screen.
    }
    window.location.assign("/login");
  }, []);

  if (!authLoading && !user) {
    return (
      <Navigate to="/login" replace state={{ from: { pathname: "/start-trial" } }} />
    );
  }

  const shellClass =
    "fixed inset-0 z-50 overflow-y-auto bg-white text-slate-900";

  if (phase === "loading" || phase === "confirming") {
    return (
      <div className={shellClass} style={{ fontFamily: LANDING_FONT }}>
        <div className="min-h-full flex flex-col items-center justify-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" aria-label="Loading" />
          {phase === "confirming" && (
            <p className="text-sm text-slate-500">Activating your trial…</p>
          )}
        </div>
      </div>
    );
  }

  if (phase === "checkout" && stripePromise && clientSecret) {
    return (
      <div className={shellClass} style={{ fontFamily: LANDING_FONT }}>
        <div className="min-h-full flex items-start justify-center py-10">
          <div className="w-full max-w-xl px-4">
            <button
              type="button"
              className="mb-4 text-sm text-slate-500 hover:text-slate-800"
              onClick={() => {
                setClientSecret(null);
                setPhase("pick");
              }}
            >
              &larr; Back to plans
            </button>
            <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className={shellClass} style={{ fontFamily: LANDING_FONT }}>
        <div className="min-h-full flex items-center justify-center px-6">
          <div className="max-w-md text-center">
            <h1 className="text-2xl font-semibold tracking-tight">
              Could not start checkout
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-slate-500">{error}</p>
            <button
              type="button"
              className="mt-6 rounded-full bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-blue-500"
              onClick={() => beginCheckout(pendingPlan)}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // pick / starting — a billing-style plan picker framed as a free trial.
  const starting = phase === "starting";
  const isAnnual = period === BILLING_PERIODS.ANNUAL;
  const daysLabel = trialLabel(trialDays);

  return (
    <div className={shellClass} style={{ fontFamily: LANDING_FONT }}>
      <div className="min-h-full flex flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-5xl text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-semibold text-blue-700">
            {daysLabel} free. $0 due today.
          </span>
          <h1 className="mt-4 text-3xl sm:text-4xl font-semibold tracking-tight">
            Choose your plan to start
          </h1>
          <p className="mt-3 text-base text-slate-500 max-w-xl mx-auto leading-relaxed">
            Every plan starts with a {daysLabel} free trial. Add a card, use
            everything, and cancel anytime before the trial ends to pay nothing.
          </p>

          {/* Billing period toggle */}
          <div
            className="mt-7 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1"
            role="group"
            aria-label="Billing period"
          >
            <button
              type="button"
              onClick={() => setPeriod(BILLING_PERIODS.MONTHLY)}
              aria-pressed={period === BILLING_PERIODS.MONTHLY}
              className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
                period === BILLING_PERIODS.MONTHLY
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
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
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Annual
              <span className="ml-1.5 text-xs font-semibold text-blue-600">Save</span>
            </button>
          </div>

          {/* Plan cards */}
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 text-left">
            {TRIAL_PLANS.map((plan) => {
              const price = getDisplayPrice(plan, period);
              const savings = getAnnualSavings(plan);
              const planBusy = starting && pendingPlan === plan.id;
              return (
                <div
                  key={plan.id}
                  className={`relative flex flex-col rounded-2xl border p-6 ${
                    plan.highlighted
                      ? "border-blue-300 bg-blue-50/40 shadow-[0_20px_50px_-30px_rgba(37,99,235,0.5)]"
                      : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">{plan.name}</h3>
                    {plan.badge && (
                      <span className="rounded-md bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                        {plan.badge}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">
                    {plan.tagline}
                  </p>

                  <div className="mt-4">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-3xl font-bold tracking-tight">$0</span>
                      <span className="text-sm text-slate-500">for {daysLabel}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
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
                          className="flex items-start gap-2 text-sm text-slate-700"
                        >
                          <span aria-hidden className="mt-[2px] text-blue-600">
                            ✓
                          </span>
                          <span>{f.text}</span>
                        </li>
                      ))}
                  </ul>

                  <button
                    type="button"
                    className={`w-full rounded-full px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60 ${
                      plan.highlighted
                        ? "bg-blue-600 text-white hover:bg-blue-500"
                        : "border border-slate-300 bg-white text-slate-900 hover:border-blue-400 hover:text-blue-700"
                    }`}
                    onClick={() => beginCheckout(plan.id)}
                    disabled={starting}
                  >
                    {planBusy ? "Starting…" : "Start free trial"}
                  </button>
                </div>
              );
            })}
          </div>

          <p className="mt-6 text-xs text-slate-400 max-w-xl mx-auto">
            You&apos;ll add a card to start. Payments are processed securely by
            Stripe. LYKN never sees your card details.
          </p>

          <button
            type="button"
            className="mt-5 text-xs text-slate-400 underline underline-offset-4 hover:text-slate-600"
            onClick={signOutToLogin}
            disabled={starting}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
