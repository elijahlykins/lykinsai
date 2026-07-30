import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import { motion } from "framer-motion";
import lyknWordmark from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-BLUE-web.png";

// Browser-side half of the desktop Google sign-in.
//
// Google blocks OAuth inside embedded browsers ("This browser or app may not
// be secure"), so the Mac app can't run the Google round-trip in its own
// window. Instead the app opens THIS page in the user's real browser:
//
//   1. Fresh desktop_state from the Mac app → clear any leftover browser
//      Supabase session (Mac sign-out does NOT clear the system browser),
//      then Google OAuth with prompt=select_account.
//   2. Back from Google with a session → hand it to the app via loopback POST
//      or lykn://auth (tokens in the URL fragment, never in query/logs).
//   3. The app's main process forwards the tokens to the renderer, which calls
//      supabase.auth.setSession() — signed in, no embedded Google page ever.
//   4. Immediately signOut({ scope: "local" }) in THIS browser tab so it stops
//      auto-refreshing. Supabase rotates refresh tokens; if the browser and
//      Electron both refresh the same family, one side gets revoked and the
//      Mac app mysteriously logs the user out later. Electron owns the session
//      after handoff; tokens stay in a memory cache so "Open LYKN" still works.
//
// Machine-specific "works on the second Try again" was usually:
//   • Double navigation (Supabase redirect + our backup assign) racing PKCE
//   • INITIAL_SESSION(null) before ?code= exchange finished
//   • Boot marker set but landing without ?code= treated as hard failure
// We now single-redirect, explicitly exchange the code, and auto-resume OAuth
// once when the return has no session yet.

const LANDING_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

const BOOT_KEY = "lykn:desktop-auth-boot";
const AUTORETRY_KEY = "lykn:desktop-auth-autoretry";
const SESSION_WAIT_MS = 10_000;
const SESSION_POLL_MS = 150;

const Spinner = () => (
  <svg className="w-5 h-5 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

function readDesktopState() {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get("desktop_state") || "";
  } catch {
    return "";
  }
}

function readBootMarker() {
  try {
    return sessionStorage.getItem(BOOT_KEY) || "";
  } catch {
    return "";
  }
}

function writeBootMarker(state) {
  try {
    if (state) sessionStorage.setItem(BOOT_KEY, state);
    else sessionStorage.removeItem(BOOT_KEY);
  } catch {
    /* ignore */
  }
}

function readAutoRetry() {
  try {
    return Number(sessionStorage.getItem(AUTORETRY_KEY) || "0") || 0;
  } catch {
    return 0;
  }
}

function bumpAutoRetry() {
  try {
    sessionStorage.setItem(AUTORETRY_KEY, String(readAutoRetry() + 1));
  } catch {
    /* ignore */
  }
}

function clearAutoRetry() {
  try {
    sessionStorage.removeItem(AUTORETRY_KEY);
  } catch {
    /* ignore */
  }
}

/** True when this load is the OAuth redirect back from Google/Supabase. */
function hasOAuthCallbackParams() {
  if (typeof window === "undefined") return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return Boolean(
      params.get("code") ||
        hash.get("access_token") ||
        params.get("access_token"),
    );
  } catch {
    return false;
  }
}

function readAuthCode() {
  try {
    return new URLSearchParams(window.location.search).get("code") || "";
  } catch {
    return "";
  }
}

async function waitForSession(timeoutMs = SESSION_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.access_token && data?.session?.refresh_token) {
        return data.session;
      }
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, SESSION_POLL_MS));
  }
  return null;
}

/** Prefer explicit PKCE exchange; fall back to polling getSession. */
async function establishSessionFromUrl() {
  const code = readAuthCode();
  if (code) {
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error && data?.session?.access_token) return data.session;
      // "Already used" / race with detectSessionInUrl — session may still land.
    } catch {
      /* fall through to poll */
    }
  }
  return waitForSession();
}

function readHandoffPort() {
  if (typeof window === "undefined") return "";
  try {
    return new URLSearchParams(window.location.search).get("handoff_port") || "";
  } catch {
    return "";
  }
}

function buildDeepLink(session) {
  const at = encodeURIComponent(session.access_token || "");
  const rt = encodeURIComponent(session.refresh_token || "");
  const state = encodeURIComponent(readDesktopState());
  return `lykn://auth#access_token=${at}&refresh_token=${rt}&state=${state}`;
}

/** Navigate to lykn:// with a real click target when possible (user gesture). */
function navigateToDeepLink(url, { soft = false } = {}) {
  try {
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch {
    /* fall through */
  }
  // Soft mode keeps the success page up (auto-handoff / pagehide) so the
  // Open LYKN button still works if the browser blocked the custom scheme.
  if (!soft) window.location.href = url;
}

/**
 * Prefer loopback POST when the Mac app minted `handoff_port` (works without a
 * click, and unpackaged shells can't safely own lykn://). Fall back to
 * lykn://auth if the local server isn't reachable.
 */
async function handoffSessionToApp(session, { softProtocol = false } = {}) {
  const port = readHandoffPort();
  if (port && /^\d+$/.test(port)) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/auth-handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          state: readDesktopState(),
        }),
      });
      if (res.ok) return { mode: "http" };
      const data = await res.json().catch(() => ({}));
      // Unpackaged/local shells must not fall through to lykn:// — that opens
      // the installed production app instead of the dev window.
      if (isLocalHandoffOnly()) {
        throw new Error(data?.error || `handoff_failed_${res.status}`);
      }
    } catch (err) {
      if (isLocalHandoffOnly()) throw err;
      // Packaged: browser may block private-network fetch; use deep link.
    }
  }
  navigateToDeepLink(buildDeepLink(session), { soft: softProtocol });
  return { mode: "protocol" };
}

function isLocalHandoffOnly() {
  try {
    const host = window.location.hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

export default function DesktopAuth() {
  const { user, loading, signInWithOAuth } = useAuth();
  // 'boot' → auth still resolving; 'starting' → bouncing to Google / finishing
  // exchange; 'handoff' → signed in; 'error' → OAuth failed.
  const [phase, setPhase] = useState("boot");
  const [errorMsg, setErrorMsg] = useState(null);
  const [finishing, setFinishing] = useState(false);
  const [httpHandoffDone, setHttpHandoffDone] = useState(false);
  const [autoHandoffStarted, setAutoHandoffStarted] = useState(false);
  // Survives browser local sign-out so the success UI can still show email.
  const [handoffEmail, setHandoffEmail] = useState("");
  const startedRef = useRef(false);
  const handoffAttemptedRef = useRef(false);
  const handoffTokensRef = useRef(null);
  const browserSessionReleasedRef = useRef(false);

  // Drop the browser's persisted Supabase session (local only — does NOT revoke
  // the refresh token Electron is using). Idempotent.
  const releaseBrowserSession = async () => {
    if (browserSessionReleasedRef.current) return;
    browserSessionReleasedRef.current = true;
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* cosmetic — Mac already has the tokens */
    }
  };

  const oauthError = (() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return (
      params.get("error_description") ||
      hashParams.get("error_description") ||
      params.get("error") ||
      hashParams.get("error")
    );
  })();

  const startOAuth = async () => {
    setErrorMsg(null);
    setFinishing(false);
    setPhase("starting");
    const desktopState = readDesktopState();
    const handoffPort = readHandoffPort();
    const returnParams = new URLSearchParams();
    if (desktopState) returnParams.set("desktop_state", desktopState);
    // Must survive the Google → Supabase → /desktop-auth round-trip or local
    // Electron falls back to lykn:// and opens the installed production app.
    if (handoffPort) returnParams.set("handoff_port", handoffPort);
    const qs = returnParams.toString();
    const returnPath = qs ? `/desktop-auth?${qs}` : "/desktop-auth";
    // Keep desktop_state / handoff_port; drop any leftover OAuth params.
    window.history.replaceState({}, "", returnPath);
    if (desktopState) writeBootMarker(desktopState);
    const { data, error } = await signInWithOAuth("google", {
      redirectTo: `${window.location.origin}${returnPath}`,
      queryParams: { prompt: "select_account" },
      // One navigation only — see SupabaseAuth comment on skipBrowserRedirect.
      skipBrowserRedirect: true,
    });
    if (error) {
      setErrorMsg("Couldn't start Google sign-in. Please try again.");
      setPhase("error");
      return;
    }
    if (data?.url) {
      window.location.assign(data.url);
      return;
    }
    setErrorMsg("Couldn't start Google sign-in. Please try again.");
    setPhase("error");
  };

  const openApp = async ({ silent = false } = {}) => {
    if (!silent) setErrorMsg(null);
    const { data } = await supabase.auth.getSession();
    // Prefer live session; fall back to in-memory tokens after we released the
    // browser session so "Open LYKN" / pagehide retries still work.
    const session = data?.session?.access_token
      ? data.session
      : handoffTokensRef.current;
    if (!session?.access_token || !session?.refresh_token) {
      if (!silent) {
        setErrorMsg("Your session expired. Please sign in again.");
        setPhase("error");
      }
      return false;
    }
    if (!readDesktopState()) {
      if (!silent) {
        setErrorMsg(
          "Open Google sign-in from the LYKN Mac app (Continue with Google there), then use Open LYKN here.",
        );
        setPhase("error");
      }
      return false;
    }
    handoffTokensRef.current = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    };
    const email =
      session.user?.email ||
      user?.email ||
      handoffEmail ||
      "";
    if (email) setHandoffEmail(email);
    clearAutoRetry();
    try {
      const result = await handoffSessionToApp(session, { softProtocol: silent });
      if (result.mode === "http") setHttpHandoffDone(true);
      // Electron now owns this refresh-token family — stop browser auto-refresh
      // before the next hourly rotation revokes the Mac session.
      void releaseBrowserSession();
      return true;
    } catch {
      if (!silent) {
        setErrorMsg(
          readHandoffPort()
            ? "Couldn't reach the LYKN Mac app automatically. Make sure LYKN is still open, then click Open LYKN."
            : "Couldn't open the LYKN Mac app. Click Open LYKN to try again.",
        );
      }
      return false;
    }
  };

  // Auto-handoff as soon as Google finishes — loopback POST when handoff_port
  // is present (packaged + local), otherwise lykn://auth. Keeps "Open LYKN" as
  // a fallback if the browser blocks the first navigation.
  useEffect(() => {
    if (phase !== "handoff") return;
    if (handoffAttemptedRef.current) return;
    handoffAttemptedRef.current = true;
    setAutoHandoffStarted(true);
    void openApp({ silent: true }).then((ok) => {
      if (ok) return;
      // One delayed retry — Chrome sometimes needs a beat after paint, and
      // the Mac app may still be raising its handoff listener.
      window.setTimeout(() => {
        void openApp({ silent: true });
      }, 1200);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Last chance: user closes/hides the tab after sign-in without clicking.
  useEffect(() => {
    if (phase !== "handoff") return;
    const onLeave = () => {
      void openApp({ silent: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onLeave();
    };
    window.addEventListener("pagehide", onLeave);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const switchAccount = async () => {
    startedRef.current = true;
    setFinishing(false);
    setPhase("starting");
    setHttpHandoffDone(false);
    setHandoffEmail("");
    handoffTokensRef.current = null;
    browserSessionReleasedRef.current = false;
    handoffAttemptedRef.current = false;
    setAutoHandoffStarted(false);
    clearAutoRetry();
    const desktopState = readDesktopState();
    if (desktopState) writeBootMarker(desktopState);
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* proceed */
    }
    await startOAuth();
  };

  // Late session arrival after a slow exchange → handoff (never stay on error).
  useEffect(() => {
    if (!user) return;
    if (user.email) setHandoffEmail(user.email);
    if (phase === "error" || finishing) {
      clearAutoRetry();
      setErrorMsg(null);
      setFinishing(false);
      setPhase("handoff");
    }
  }, [user, phase, finishing]);

  useEffect(() => {
    if (loading) return;

    if (oauthError && !startedRef.current) {
      setErrorMsg("Google sign-in was cancelled or failed. Please try again.");
      setPhase("error");
      return;
    }

    if (startedRef.current) {
      if (user) {
        clearAutoRetry();
        setErrorMsg(null);
        setFinishing(false);
        setPhase("handoff");
      }
      return;
    }
    startedRef.current = true;

    const desktopState = readDesktopState();
    const bootMarker = readBootMarker();
    const oauthCallback = hasOAuthCallbackParams();

    (async () => {
      // Ensure the auth client finished init before we signOut / exchange.
      try {
        await supabase.auth.getSession();
      } catch {
        /* continue */
      }

      // Real OAuth return (has ?code= or hash tokens).
      if (oauthCallback) {
        if (user) {
          clearAutoRetry();
          setPhase("handoff");
          return;
        }
        setFinishing(true);
        setPhase("starting");
        const session = await establishSessionFromUrl();
        if (session?.access_token) {
          clearAutoRetry();
          setFinishing(false);
          setErrorMsg(null);
          setPhase("handoff");
          return;
        }
        setFinishing(false);
        // One silent resume — same as the manual "Try again" that always worked
        // on the affected laptop.
        if (readAutoRetry() < 1) {
          bumpAutoRetry();
          await startOAuth();
          return;
        }
        setErrorMsg("Google sign-in didn't complete. Please try again.");
        setPhase("error");
        return;
      }

      // Boot marker matches but no callback params: mid-flight reload / cancelled
      // Google / stripped URL. Don't hard-fail — resume OAuth once.
      if (desktopState && bootMarker && bootMarker === desktopState) {
        const existing = await waitForSession(2_500);
        if (existing?.access_token) {
          clearAutoRetry();
          setPhase("handoff");
          return;
        }
        if (readAutoRetry() < 1) {
          bumpAutoRetry();
          await startOAuth();
          return;
        }
        setErrorMsg("Google sign-in didn't complete. Please try again.");
        setPhase("error");
        return;
      }

      if (desktopState) {
        // Fresh mint from the Mac app.
        clearAutoRetry();
        writeBootMarker(desktopState);
        try {
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          /* ignore */
        }
        await startOAuth();
        return;
      }

      if (user) {
        clearAutoRetry();
        setPhase("handoff");
        return;
      }
      await startOAuth();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user]);

  const waitingCopy = finishing || hasOAuthCallbackParams()
    ? {
        title: "Finishing sign-in…",
        body: "Confirming your Google account, then you can open the LYKN Mac app.",
      }
    : {
        title: "Redirecting to Google…",
        body: "Choose the Google account you want, then we'll send you back to the LYKN Mac app.",
      };

  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-white"
      style={{ fontFamily: LANDING_FONT }}
    >
      <div className="relative h-full flex flex-col px-5 py-4">
        <div className="flex-1 flex overflow-y-auto">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
            className="m-auto w-full max-w-[440px] rounded-[28px] border border-slate-200 bg-white p-7 sm:p-9 text-center shadow-[0_32px_80px_-32px_rgba(15,23,42,0.35)]"
          >
            <img src={lyknWordmark} alt="LYKN" className="mx-auto h-7 mb-6" />

            {(phase === "boot" || phase === "starting") && (
              <>
                <div className="flex justify-center mb-4"><Spinner /></div>
                <h1 className="text-lg font-semibold text-slate-900">
                  {waitingCopy.title}
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                  {waitingCopy.body}
                </p>
              </>
            )}

            {phase === "handoff" && (
              <>
                <h1 className="text-lg font-semibold text-slate-900">
                  You&apos;re signed in
                  {(handoffEmail || user?.email)
                    ? ` as ${handoffEmail || user?.email}`
                    : ""}
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                  {httpHandoffDone
                    ? "You're signed in to the LYKN Mac app. You can close this tab."
                    : autoHandoffStarted
                      ? "Opening LYKN… If the app didn’t update, click Open LYKN below."
                      : (
                        <>
                          Click <span className="font-medium text-slate-700">Open LYKN</span> to
                          return to the Mac app. You can close this tab afterwards.
                        </>
                      )}
                </p>
                {errorMsg && (
                  <p className="mt-2 text-sm text-red-600">{errorMsg}</p>
                )}
                {!httpHandoffDone && (
                  <button
                    type="button"
                    onClick={() => void openApp()}
                    className="mt-5 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-colors duration-200 bg-gradient-to-b from-[#6ea8ff] to-[#2563eb] shadow-[0_12px_26px_-10px_rgba(37,99,235,0.65),inset_0_1px_0_rgba(255,255,255,0.45)] hover:from-[#5b9bff] hover:to-[#1e40af]"
                  >
                    Open LYKN
                  </button>
                )}
                <button
                  type="button"
                  onClick={switchAccount}
                  className="mt-3 text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
                >
                  Not you? Sign in with a different account
                </button>
              </>
            )}

            {phase === "error" && (
              <>
                <h1 className="text-lg font-semibold text-slate-900">
                  Sign-in didn&apos;t finish
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                  {errorMsg || "Something went wrong. Please try again."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    clearAutoRetry();
                    startOAuth();
                  }}
                  className="mt-5 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-colors duration-200 bg-gradient-to-b from-[#6ea8ff] to-[#2563eb] shadow-[0_12px_26px_-10px_rgba(37,99,235,0.65),inset_0_1px_0_rgba(255,255,255,0.45)] hover:from-[#5b9bff] hover:to-[#1e40af]"
                >
                  Try again
                </button>
              </>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}
