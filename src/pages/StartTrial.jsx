import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { hasAppAccess } from "@/lib/billingAccess";
import { toBillingCheckoutError } from "@/lib/billingCheckoutErrors";
import { isConnectOnboardingDone } from "@/lib/prototypeHandoff";
import { supabase } from "@/lib/supabase";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";

const NEW_USER_WINDOW_MS = 10 * 60 * 1000;
const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || "";

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

async function startTrialCheckout() {
  const headers = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
  };
  const res = await fetch(`${API_BASE_URL}/api/billing/trial-checkout`, {
    method: "POST",
    headers,
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

export default function StartTrial() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const checkoutResult = searchParams.get("checkout");
  const [phase, setPhase] = useState(() => {
    if (checkoutResult === "success") return "confirming";
    return "starting";
  });
  const [error, setError] = useState(null);
  const [trialDays, setTrialDays] = useState(7);
  const [clientSecret, setClientSecret] = useState(null);
  const startedRef = useRef(false);

  const stripePromise = useMemo(
    () => (STRIPE_PUBLISHABLE_KEY ? loadStripe(STRIPE_PUBLISHABLE_KEY) : null),
    [],
  );

  const pollUntilActive = useCallback(async () => {
    for (let i = 0; i < 20; i += 1) {
      const billing = await fetchBillingMe();
      if (hasAppAccess(billing)) return billing;
      await new Promise((r) => window.setTimeout(r, 1500));
    }
    return null;
  }, []);

  const beginCheckout = useCallback(async () => {
    setError(null);
    setPhase("starting");
    setClientSecret(null);

    if (!stripePromise) {
      setError(
        "Checkout is not available right now. Please try again in a few minutes.",
      );
      setPhase("error");
      return;
    }

    try {
      const billing = await fetchBillingMe();
      if (typeof billing?.trial_days === "number") {
        setTrialDays(billing.trial_days);
      }
      if (hasAppAccess(billing)) {
        navigate(postTrialDestination(user), { replace: true });
        return;
      }

      const payload = await startTrialCheckout();
      if (!payload?.client_secret) {
        throw new Error("Missing checkout session");
      }
      setClientSecret(payload.client_secret);
      if (typeof payload.trial_days === "number") {
        setTrialDays(payload.trial_days);
      }
      setPhase("checkout");
    } catch (err) {
      if (err?.code === "already_subscribed") {
        navigate(postTrialDestination(user), { replace: true });
        return;
      }
      setError(toBillingCheckoutError(err));
      setPhase("error");
    }
  }, [navigate, stripePromise, user]);

  useEffect(() => {
    if (authLoading || !user) return;

    (async () => {
      try {
        const billing = await fetchBillingMe();
        if (typeof billing?.trial_days === "number") {
          setTrialDays(billing.trial_days);
        }
      } catch {
        // Keep default trial length in UI.
      }
    })();

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

    if (startedRef.current) return;
    startedRef.current = true;
    beginCheckout();
  }, [authLoading, user, checkoutResult, navigate, pollUntilActive, beginCheckout]);

  if (!authLoading && !user) {
    return <Navigate to="/login" replace state={{ from: { pathname: "/start-trial" } }} />;
  }

  return (
    <div className="dark lykn-wake-stage relative w-screen min-h-screen overflow-hidden flex flex-col">
      <div className="lykn-wake-start-trial">
        <div
          className={`lykn-wake-start-trial-inner${
            phase === "checkout" ? " lykn-wake-start-trial-inner--checkout" : ""
          }`}
        >
          <img src={lyknLogo} alt="LYKN" className="lykn-wake-start-trial-logo" />
          <p className="lykn-wake-start-trial-tagline">Make it personal</p>

          {phase === "confirming" && (
            <>
              <h1 className="lykn-wake-start-trial-title">Activating your trial</h1>
              <p className="lykn-wake-start-trial-copy">
                Hang tight while we confirm your subscription.
              </p>
              <div className="lykn-wake-start-trial-spinner" aria-hidden />
            </>
          )}

          {phase === "starting" && (
            <>
              <h1 className="lykn-wake-start-trial-title">Add your card</h1>
              <p className="lykn-wake-start-trial-copy">
                Start with a {trialDays}-day Pro trial. Add a card to unlock LYKN on any
                device.
              </p>
              <p className="lykn-wake-start-trial-hint">
                You will not be charged until your trial ends. Loading secure checkout…
              </p>
              <div className="lykn-wake-start-trial-spinner" aria-hidden />
            </>
          )}

          {phase === "checkout" && clientSecret && stripePromise && (
            <>
              <h1 className="lykn-wake-start-trial-title">Add your card</h1>
              <p className="lykn-wake-start-trial-copy">
                Start with a {trialDays}-day Pro trial. Add a card to unlock LYKN on any
                device.
              </p>
              <p className="lykn-wake-start-trial-hint">
                You will not be charged until your {trialDays}-day trial ends.
              </p>
              <div className="lykn-wake-start-trial-checkout">
                <EmbeddedCheckoutProvider
                  stripe={stripePromise}
                  options={{ clientSecret }}
                >
                  <EmbeddedCheckout />
                </EmbeddedCheckoutProvider>
              </div>
            </>
          )}

          {phase === "error" && (
            <>
              <h1 className="lykn-wake-start-trial-title">Could not start checkout</h1>
              <p className="lykn-wake-start-trial-copy">{error}</p>
              <button
                type="button"
                className="lykn-wake-account-submit-btn lykn-wake-start-trial-retry"
                onClick={() => {
                  startedRef.current = false;
                  beginCheckout();
                }}
              >
                Try again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
