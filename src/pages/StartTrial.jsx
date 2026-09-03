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
import { supabase } from "@/lib/supabase";
import {
  PLANS,
  BILLING_PERIODS,
  getDisplayPrice,
  getAnnualSavings,
  isStudentEmail,
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

function checkoutErrorMessage(err) {
  const code = err?.code || "";
  if (code === "checkout_email_required") {
    return "We couldn't find an email on your account. Sign out and back in, then try again.";
  }
  if (code === "student_email_required") {
    return (
      err?.message ||
      "The Student plan requires a school account email (like name@university.edu). Sign up with your school email or pick another plan."
    );
  }
  if (code === "price_not_configured" || code === "stripe_not_configured") {
    return "Checkout isn't fully configured yet. Please contact support@lykn.io.";
  }
  return err?.message || "Something went wrong starting checkout. Please try again.";
}

export default function StartTrial() {
  const { user, loading: authLoading, signOut, signingOut } = useAuth();
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
          navigate("/studio", { replace: true });
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
            navigate("/studio", { replace: true });
            return;
          }
          // Embedded unavailable — fall back to the hosted redirect.
          const payload = await startTrialCheckout("hosted", planId, period);
          if (!payload?.url) throw new Error("Missing checkout session");
          window.location.assign(payload.url);
        }
      } catch (err) {
        if (err?.code === "already_subscribed") {
          navigate("/studio", { replace: true });
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
          navigate("/studio", { replace: true });
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
    // explicitly chooses a plan. Cap wait so a hung /billing/me can't trap
    // the user on the spinner with no Sign out control.
    let cancelled = false;
    (async () => {
      try {
        const billing = await Promise.race([
          fetchBillingMe(),
          new Promise((_, reject) =>
            window.setTimeout(() => reject(new Error("billing_me_timeout")), 8_000),
          ),
        ]);
        if (cancelled) return;
        if (hasAppAccess(billing)) {
          navigate("/studio", { replace: true });
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

  // Use the provider's signOut so the shared cleanup runs (prototype/
  // onboarding localStorage keys, signingOut guard, hard reload) — calling
  // supabase.auth.signOut directly here used to leak the previous user's
  // onboarding-done flag to the next account on this browser.
  // Land on /login with a clean history entry — do NOT pass from:/start-trial
  // or Login will bounce a still-hydrating session right back here.
  const signOutToLogin = useCallback(async () => {
    await signOut({ redirectTo: "/login" });
  }, [signOut]);

  // Plan picker must fit the desktop window without scrolling. Checkout can
  // scroll because Stripe's embedded form is taller than a laptop viewport.
  const shellClass =
    "fixed inset-0 z-50 bg-white text-slate-900";
  const shellScrollClass = `${shellClass} overflow-y-auto`;
  const shellFitClass = `${shellClass} overflow-hidden`;

  if (signingOut) {
    return (
      <div className={shellFitClass} style={{ fontFamily: LANDING_FONT }}>
        <div className="h-full flex flex-col items-center justify-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" aria-label="Signing out" />
          <p className="text-sm text-slate-500">Signing out…</p>
        </div>
      </div>
    );
  }

  if (!authLoading && !user) {
    // No `from: /start-trial` — that created a bounce loop when abandon-checkout
    // users signed out (Login treated it as a deep link and sent them back).
    return <Navigate to="/login" replace />;
  }

  if (phase === "loading" || phase === "confirming") {
    return (
      <div className={shellFitClass} style={{ fontFamily: LANDING_FONT }}>
        <div className="h-full flex flex-col items-center justify-center gap-4 px-6">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-blue-600" aria-label="Loading" />
          {phase === "confirming" ? (
            <p className="text-sm text-slate-500">Activating your trial…</p>
          ) : (
            <p className="text-sm text-slate-500">Loading plans…</p>
          )}
          <button
            type="button"
            className="mt-2 text-xs text-slate-400 underline underline-offset-4 hover:text-slate-600"
            onClick={signOutToLogin}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (phase === "checkout" && stripePromise && clientSecret) {
    return (
      <div className={shellScrollClass} style={{ fontFamily: LANDING_FONT }}>
        <div className="min-h-full flex items-start justify-center py-6 sm:py-8">
          <div className="w-full max-w-xl px-4">
            <button
              type="button"
              className="mb-3 text-sm text-slate-500 hover:text-slate-800"
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
      <div className={shellFitClass} style={{ fontFamily: LANDING_FONT }}>
        <div className="h-full flex items-center justify-center px-6">
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
            <button
              type="button"
              className="mt-4 block mx-auto text-xs text-slate-400 underline underline-offset-4 hover:text-slate-600"
              onClick={signOutToLogin}
            >
              Sign out
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
  // Student plan is gated on the ACCOUNT email being a school address. The
  // server enforces this on both checkout endpoints (plus an env allowlist
  // for schools on unusual domains); this only drives the disabled CTA state.
  const studentEligible = isStudentEmail(user?.email);

  return (
    <div className={shellFitClass} style={{ fontFamily: LANDING_FONT }}>
      <div className="h-full flex flex-col items-center justify-center px-3 py-3 sm:px-5 sm:py-4">
        <div className="w-full max-w-5xl text-center min-h-0">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700">
            {daysLabel} free. $0 due today.
          </span>
          <h1 className="mt-2 text-2xl sm:text-[1.75rem] font-semibold tracking-tight">
            Choose your plan to start
          </h1>
          <p className="mt-1.5 text-sm text-slate-500 max-w-lg mx-auto leading-snug">
            Every plan starts with a {daysLabel} free trial. Add a card, cancel
            anytime before it ends to pay nothing.
          </p>

          {/* Billing period toggle */}
          <div
            className="mt-3 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5"
            role="group"
            aria-label="Billing period"
          >
            <button
              type="button"
              onClick={() => setPeriod(BILLING_PERIODS.MONTHLY)}
              aria-pressed={period === BILLING_PERIODS.MONTHLY}
              className={`rounded-lg px-3.5 py-1 text-sm font-medium transition-colors ${
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
              className={`rounded-lg px-3.5 py-1 text-sm font-medium transition-colors ${
                period === BILLING_PERIODS.ANNUAL
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-800"
              }`}
            >
              Annual
              <span className="ml-1.5 text-xs font-semibold text-blue-600">Save</span>
            </button>
          </div>

          {/* Plan cards — compact so the whole picker fits a laptop Electron window */}
          <div className="mt-3 grid gap-2.5 sm:grid-cols-3 text-left">
            {TRIAL_PLANS.map((plan) => {
              const price = getDisplayPrice(plan, period);
              const savings = getAnnualSavings(plan);
              const planBusy = starting && pendingPlan === plan.id;
              const studentLocked = plan.id === "student" && !studentEligible;
              const features = plan.features
                .filter((f) => f.included)
                .slice(0, 4);
              return (
                <div
                  key={plan.id}
                  className={`relative flex flex-col rounded-xl border p-3.5 sm:p-4 ${
                    plan.highlighted
                      ? "border-blue-300 bg-blue-50/40 shadow-[0_16px_40px_-28px_rgba(37,99,235,0.5)]"
                      : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-base font-semibold">{plan.name}</h3>
                    {plan.badge && (
                      <span className="rounded-md bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        {plan.badge}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-slate-500 line-clamp-2">
                    {plan.tagline}
                  </p>

                  <div className="mt-2.5">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-bold tracking-tight">$0</span>
                      <span className="text-xs text-slate-500">for {daysLabel}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      then {formatPrice(price)}/mo
                      {isAnnual ? " billed annually" : ""}
                      {isAnnual && savings > 0 ? ` · save $${savings}/yr` : ""}
                    </p>
                  </div>

                  <ul className="mt-2.5 mb-3 flex-1 space-y-1">
                    {features.map((f) => (
                      <li
                        key={f.text}
                        className="flex items-start gap-1.5 text-[12px] leading-snug text-slate-700"
                      >
                        <span aria-hidden className="mt-px text-blue-600">
                          ✓
                        </span>
                        <span className="line-clamp-1">{f.text}</span>
                      </li>
                    ))}
                  </ul>

                  <button
                    type="button"
                    className={`w-full rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60 ${
                      plan.highlighted
                        ? "bg-blue-600 text-white hover:bg-blue-500"
                        : "border border-slate-300 bg-white text-slate-900 hover:border-blue-400 hover:text-blue-700"
                    }`}
                    onClick={() => beginCheckout(plan.id)}
                    disabled={starting || studentLocked}
                  >
                    {studentLocked
                      ? "Requires a school email"
                      : planBusy
                        ? "Starting…"
                        : "Start free trial"}
                  </button>
                  {studentLocked && (
                    <p className="mt-1.5 text-[10px] leading-snug text-slate-400 text-center">
                      Sign up with a school email (.edu / .ac) to unlock Student.
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <p className="mt-2.5 text-[11px] text-slate-400 max-w-xl mx-auto">
            Card required to start. Payments by Stripe. LYKN never sees your card.
          </p>

          <button
            type="button"
            className="mt-2 text-[11px] text-slate-400 underline underline-offset-4 hover:text-slate-600 disabled:opacity-50"
            onClick={signOutToLogin}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
