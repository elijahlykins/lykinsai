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

const NEW_USER_WINDOW_MS = 10 * 60 * 1000;
const TRIAL_PRICE_LABEL = "$25/month";

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
async function startTrialCheckout(mode) {
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
  };
  const res = await fetch(`${API_BASE_URL}/api/billing/trial-checkout`, {
    method: "POST",
    headers,
    body: JSON.stringify({ mode }),
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
  const beginHostedCheckout = useCallback(async () => {
    const payload = await startTrialCheckout("hosted");
    if (!payload?.url) throw new Error("Missing checkout session");
    window.location.assign(payload.url);
  }, []);

  const beginCheckout = useCallback(async () => {
    setError(null);
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
        const payload = await startTrialCheckout("embedded");
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
        await beginHostedCheckout();
      }
    } catch (err) {
      if (err?.code === "already_subscribed") {
        navigate(postTrialDestination(user), { replace: true });
        return;
      }
      setError(toBillingCheckoutError(err));
      setPhase("error");
    }
  }, [navigate, user, beginHostedCheckout]);

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
              onClick={beginCheckout}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  // intro / starting
  const starting = phase === "starting";
  return (
    <div className="dark lykn-wake-stage relative w-screen min-h-screen overflow-hidden flex flex-col">
      <div className="lykn-wake-start-trial">
        <div className="lykn-wake-start-trial-inner">
          <h1 className="lykn-wake-start-trial-title">Start your 7-day free trial</h1>
          <p className="lykn-wake-start-trial-copy">
            Full access to LYKN Pro. <strong>$0 due today</strong> — we won&apos;t
            charge you until the trial ends, and you can cancel anytime before then.
          </p>

          <ul className="mt-5 mb-6 space-y-2 text-left text-sm text-white/80">
            <li className="flex items-start gap-2">
              <span aria-hidden className="mt-[2px] text-emerald-400">✓</span>
              <span>7 days free, then {TRIAL_PRICE_LABEL}</span>
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden className="mt-[2px] text-emerald-400">✓</span>
              <span>Cancel anytime before it ends — you won&apos;t be charged</span>
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden className="mt-[2px] text-emerald-400">✓</span>
              <span>Unlimited neurons &amp; Vault, every model and connection</span>
            </li>
          </ul>

          <button
            type="button"
            className="lykn-wake-account-submit-btn"
            onClick={beginCheckout}
            disabled={starting}
          >
            {starting ? "Starting…" : "Start free trial"}
          </button>

          <p className="mt-4 text-xs text-white/45">
            You&apos;ll add a card to start. Payments are processed securely by
            Stripe — LYKN never sees your card details.
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
    </div>
  );
}
