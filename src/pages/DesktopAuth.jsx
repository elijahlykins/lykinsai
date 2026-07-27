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
//   2. Back from Google with a session → hand it to the app via the
//      lykn://auth deep link (tokens in the URL fragment, never in query/logs).
//   3. The app's main process forwards the tokens to the renderer, which calls
//      supabase.auth.setSession() — signed in, no embedded Google page ever.
//
// sessionStorage key `lykn:desktop-auth-boot` records that we already cleared
// + bounced to Google for this desktop_state, so the post-Google reload does
// NOT wipe the new session (that was the "works on the second try" bug).

const LANDING_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

const BOOT_KEY = "lykn:desktop-auth-boot";

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

function buildDeepLink(session) {
  const at = encodeURIComponent(session.access_token || "");
  const rt = encodeURIComponent(session.refresh_token || "");
  const state = encodeURIComponent(readDesktopState());
  return `lykn://auth#access_token=${at}&refresh_token=${rt}&state=${state}`;
}

/** Navigate to lykn:// with a real click target when possible (user gesture). */
function navigateToDeepLink(url) {
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
  window.location.href = url;
}

export default function DesktopAuth() {
  const { user, loading, signInWithOAuth } = useAuth();
  // 'boot' → auth still resolving; 'starting' → bouncing to Google;
  // 'handoff' → signed in, deep-linking into the app; 'error' → OAuth failed.
  const [phase, setPhase] = useState("boot");
  const [errorMsg, setErrorMsg] = useState(null);
  const startedRef = useRef(false);

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
    setPhase("starting");
    const desktopState = readDesktopState();
    const returnPath = desktopState
      ? `/desktop-auth?desktop_state=${encodeURIComponent(desktopState)}`
      : "/desktop-auth";
    window.history.replaceState({}, "", returnPath);
    if (desktopState) writeBootMarker(desktopState);
    const { error } = await signInWithOAuth("google", {
      redirectTo: `${window.location.origin}${returnPath}`,
      // Force Google's account chooser so Mac sign-out → different Google
      // account works on the first try (SSO otherwise reuses the last user).
      queryParams: { prompt: "select_account" },
    });
    if (error) {
      setErrorMsg("Couldn't start Google sign-in. Please try again.");
      setPhase("error");
    }
  };

  const openApp = async () => {
    setErrorMsg(null);
    const { data } = await supabase.auth.getSession();
    const session = data?.session;
    if (!session?.access_token || !session?.refresh_token) {
      setErrorMsg("Your session expired. Please sign in again.");
      setPhase("error");
      return;
    }
    if (!readDesktopState()) {
      setErrorMsg(
        "Open Google sign-in from the LYKN Mac app (Continue with Google there), then use Open LYKN here.",
      );
      setPhase("error");
      return;
    }
    // Must run from a real click — browsers block lykn:// without a user gesture,
    // which is why auto-handoff looked like "works the second time".
    navigateToDeepLink(buildDeepLink(session));
  };

  const switchAccount = async () => {
    startedRef.current = true;
    setPhase("starting");
    const desktopState = readDesktopState();
    // New boot marker so the post-Google return is treated as a fresh OAuth
    // completion, not a stale leftover session.
    if (desktopState) writeBootMarker(desktopState);
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* proceed */
    }
    await startOAuth();
  };

  useEffect(() => {
    if (loading) return;

    if (oauthError && !startedRef.current) {
      setErrorMsg("Google sign-in was cancelled or failed. Please try again.");
      setPhase("error");
      return;
    }

    if (startedRef.current) {
      // Effect re-ran after signOut cleared `user` mid-boot — wait for OAuth return.
      // Do NOT auto-open lykn:// here; wait for the Open LYKN click.
      if (user) setPhase("handoff");
      return;
    }
    startedRef.current = true;

    const desktopState = readDesktopState();
    const bootMarker = readBootMarker();
    const returningFromGoogle = Boolean(
      desktopState && bootMarker && bootMarker === desktopState,
    );

    (async () => {
      // Post-Google reload: we already cleared + started OAuth for this state.
      if (returningFromGoogle) {
        if (user) {
          setPhase("handoff");
          return;
        }
        // Session can lag a tick behind INITIAL_SESSION on some browsers —
        // confirm with getSession before declaring failure.
        try {
          const { data } = await supabase.auth.getSession();
          if (data?.session?.user) {
            setPhase("handoff");
            return;
          }
        } catch {
          /* fall through */
        }
        // Marker set but auth finished with no session — offer retry instead
        // of silently clearing again (that caused the "second try" loop).
        setErrorMsg("Google sign-in didn't complete. Please try again.");
        setPhase("error");
        return;
      }

      if (desktopState) {
        // Fresh mint from the Mac app. Drop any leftover browser session so we
        // don't auto-handoff the previous Google account after Mac sign-out.
        writeBootMarker(desktopState);
        try {
          await supabase.auth.signOut({ scope: "local" });
        } catch {
          /* ignore */
        }
        await startOAuth();
        return;
      }

      // No desktop_state (opened in a plain browser tab).
      if (user) {
        setPhase("handoff");
        return;
      }
      await startOAuth();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user]);

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
                  Redirecting to Google…
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                  Choose the Google account you want, then we&apos;ll send you
                  back to the LYKN Mac app.
                </p>
              </>
            )}

            {phase === "handoff" && (
              <>
                <h1 className="text-lg font-semibold text-slate-900">
                  You&apos;re signed in{user?.email ? ` as ${user.email}` : ""}
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                  Click <span className="font-medium text-slate-700">Open LYKN</span> to
                  return to the Mac app you signed in from. You can close this tab afterwards.
                </p>
                <button
                  type="button"
                  onClick={openApp}
                  className="mt-5 w-full rounded-xl px-4 py-3 text-sm font-semibold text-white transition-colors duration-200 bg-gradient-to-b from-[#6ea8ff] to-[#2563eb] shadow-[0_12px_26px_-10px_rgba(37,99,235,0.65),inset_0_1px_0_rgba(255,255,255,0.45)] hover:from-[#5b9bff] hover:to-[#1e40af]"
                >
                  Open LYKN
                </button>
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
                  onClick={startOAuth}
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
