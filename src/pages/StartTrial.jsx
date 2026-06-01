import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import { API_BASE_URL } from "@/lib/api-config";
import { hasAppAccess } from "@/lib/billingAccess";
import { toBillingCheckoutError } from "@/lib/billingCheckoutErrors";
import { isConnectOnboardingDone } from "@/lib/prototypeHandoff";
import { supabase } from "@/lib/supabase";

const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

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
    body: JSON.stringify({ mode: "hosted" }),
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
  const [phase, setPhase] = useState(() => {
    if (checkoutResult === "success") return "confirming";
    if (checkoutResult === "canceled") return "returning";
    return "redirecting";
  });
  const [error, setError] = useState(null);
  const startedRef = useRef(false);
  const cancelHandledRef = useRef(false);

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
    setPhase("redirecting");

    try {
      const billing = await fetchBillingMe();
      if (hasAppAccess(billing)) {
        navigate(postTrialDestination(user), { replace: true });
        return;
      }

      const payload = await startTrialCheckout();
      if (!payload?.url) {
        throw new Error("Missing checkout session");
      }
      window.location.assign(payload.url);
    } catch (err) {
      if (err?.code === "already_subscribed") {
        navigate(postTrialDestination(user), { replace: true });
        return;
      }
      setError(toBillingCheckoutError(err));
      setPhase("error");
    }
  }, [navigate, user]);

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

    if (startedRef.current) return;
    startedRef.current = true;
    beginCheckout();
  }, [authLoading, user, checkoutResult, navigate, pollUntilActive, beginCheckout]);

  if (
    !authLoading &&
    !user &&
    checkoutResult !== "canceled" &&
    phase !== "returning"
  ) {
    return <Navigate to="/login" replace state={{ from: { pathname: "/start-trial" } }} />;
  }

  if (phase === "redirecting" || phase === "confirming" || phase === "returning") {
    return (
      <div className="dark lykn-wake-stage relative w-screen min-h-screen overflow-hidden flex items-center justify-center">
        <div className="lykn-wake-start-trial-spinner" aria-hidden aria-label="Loading" />
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
              onClick={() => {
                startedRef.current = false;
                beginCheckout();
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
