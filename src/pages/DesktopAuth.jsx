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
//   1. No session here yet → kick off the normal Supabase Google OAuth with
//      redirectTo back to /desktop-auth.
//   2. Back from Google with a session → hand it to the app via the
//      lykn://auth deep link (tokens in the URL fragment, never in query/logs).
//   3. The app's main process forwards the tokens to the renderer, which calls
//      supabase.auth.setSession() — signed in, no embedded Google page ever.
//
// This page is only ever *useful* when reached from the desktop app, but it's
// harmless in a plain browser — worst case it deep-links the user's own
// session into their own installed app.

const LANDING_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

const Spinner = () => (
  <svg className="w-5 h-5 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

function buildDeepLink(session) {
  const at = encodeURIComponent(session.access_token || "");
  const rt = encodeURIComponent(session.refresh_token || "");
  return `lykn://auth#access_token=${at}&refresh_token=${rt}`;
}

export default function DesktopAuth() {
  const { user, loading, signInWithOAuth } = useAuth();
  // 'boot' → auth still resolving; 'starting' → bouncing to Google;
  // 'handoff' → signed in, deep-linking into the app; 'error' → OAuth failed.
  const [phase, setPhase] = useState("boot");
  const [errorMsg, setErrorMsg] = useState(null);
  const startedRef = useRef(false);
  const handedOffRef = useRef(false);

  // Surface OAuth error params (user hit "cancel" on Google, expired code, …)
  // instead of looping straight back into another OAuth attempt.
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
    // Strip stale error params so a retry that fails again still shows fresh.
    window.history.replaceState({}, "", window.location.pathname);
    const { error } = await signInWithOAuth("google", {
      redirectTo: `${window.location.origin}/desktop-auth`,
    });
    if (error) {
      setErrorMsg("Couldn't start Google sign-in. Please try again.");
      setPhase("error");
    }
  };

  const openApp = async () => {
    const { data } = await supabase.auth.getSession();
    const session = data?.session;
    if (!session?.access_token || !session?.refresh_token) {
      setErrorMsg("Your session expired. Please sign in again.");
      setPhase("error");
      return;
    }
    window.location.href = buildDeepLink(session);
  };

  const switchAccount = async () => {
    startedRef.current = true; // don't let the effect auto-restart mid-signout
    try {
      await supabase.auth.signOut({ scope: "local" });
    } catch {
      /* proceed to a fresh OAuth attempt regardless */
    }
    startOAuth();
  };

  useEffect(() => {
    if (loading) return;

    if (oauthError && !startedRef.current) {
      setErrorMsg("Google sign-in was cancelled or failed. Please try again.");
      setPhase("error");
      return;
    }

    if (user) {
      setPhase("handoff");
      // Auto-fire the deep link once; the button stays as the fallback for
      // browsers that swallow custom-scheme navigations without a gesture.
      if (!handedOffRef.current) {
        handedOffRef.current = true;
        openApp();
      }
      return;
    }

    if (!startedRef.current) {
      startedRef.current = true;
      startOAuth();
    }
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
                  Sign in here in your browser, then we'll send you back to the
                  LYKN app.
                </p>
              </>
            )}

            {phase === "handoff" && (
              <>
                <h1 className="text-lg font-semibold text-slate-900">
                  You're signed in{user?.email ? ` as ${user.email}` : ""}
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                  If LYKN didn't open automatically, use the button below. You
                  can close this tab afterwards.
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
                  Sign-in didn't finish
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
