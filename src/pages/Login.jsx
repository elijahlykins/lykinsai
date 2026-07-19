import { useEffect, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import { isConnectOnboardingDone } from "@/lib/landingHandoff";
import { motion, AnimatePresence } from "framer-motion";
import lyknWordmark from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-BLUE-web.png";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

// The same Inter stack the Glass landing uses (.glass-land), so type renders
// identically across the two pages.
const LANDING_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

// Full-bleed backdrop: the landing's blue burst anchored to the right edge
// with frosted glass panels running edge to edge across the whole viewport.
// Pure decoration.
const PANEL_COUNT = 12;
const PanelArt = () => (
  <div className="pointer-events-none absolute inset-0" aria-hidden>
    <div
      className="absolute"
      style={{
        top: "-12%",
        bottom: "-12%",
        right: 0,
        left: 0,
        /* A full-width blue sweep (pale at the left, deep brand blue at the
           right) so the frosted panels are visible across the WHOLE screen,
           not just where the old right-edge burst sat. */
        background:
          "linear-gradient(90deg, #dfe9fb 0%, #b7cdf6 30%, #6d9bf3 62%, #0e6fff 100%)",
        filter: "blur(18px)",
      }}
    />
    <div className="absolute inset-0 flex">
      {Array.from({ length: PANEL_COUNT }).map((_, i) => (
        <span
          key={i}
          className="flex-1"
          style={{
            borderLeft: i === 0 ? "none" : "1px solid rgba(255,255,255,0.5)",
            background: "rgba(255,255,255,0.04)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
          }}
        />
      ))}
    </div>
  </div>
);

// Shared styling for every text input and primary submit button in the form,
// tuned for the plain white stage (crisp borders instead of glass).
const INPUT_CLS =
  "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all duration-200";
const SUBMIT_CLS =
  "w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 mt-1 bg-gradient-to-b from-[#6ea8ff] to-[#2563eb] shadow-[0_12px_26px_-10px_rgba(37,99,235,0.65),inset_0_1px_0_rgba(255,255,255,0.45)] hover:from-[#5b9bff] hover:to-[#1e40af]";
const SECONDARY_BTN_CLS =
  "w-full flex items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-all duration-200 shadow-sm";

const Spinner = () => (
  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

const ErrorBanner = ({ message }) => (
  <AnimatePresence>
    {message && (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2.5"
      >
        <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <span className="text-xs text-red-700">{message}</span>
      </motion.div>
    )}
  </AnimatePresence>
);

const SubmitButton = ({ submitting, label, busyLabel }) => (
  <motion.button
    type="submit"
    disabled={submitting}
    whileHover={{ y: -1 }}
    whileTap={{ scale: 0.99 }}
    className={SUBMIT_CLS}
  >
    {submitting ? (
      <span className="flex items-center justify-center gap-2">
        <Spinner />
        {busyLabel}
      </span>
    ) : (
      label
    )}
  </motion.button>
);

function friendlyError(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("code verifier") || lower.includes("auth code") || lower.includes("invalid request"))
    return "Something went wrong. Please sign in with Google or enter your email and password to get started.";
  if (lower.includes("invalid login") || lower.includes("invalid credentials"))
    return "Incorrect email or password. Please try again.";
  if (lower.includes("email not confirmed"))
    return "Please check your inbox and confirm your email before signing in.";
  if (lower.includes("user already registered") || lower.includes("already been registered"))
    return "An account with this email already exists. Try signing in instead.";
  if (lower.includes("rate limit") || lower.includes("too many requests"))
    return "Too many attempts. Please wait a moment and try again.";
  if (lower.includes("network") || lower.includes("fetch"))
    return "Connection error. Please check your internet and try again.";
  if (lower.includes("password") && lower.includes("characters"))
    return "Password must be at least 6 characters.";
  return "Something went wrong. Please try again.";
}

// 10-minute window — long enough to cover a slow email-confirmation
// click (open the inbox tab, find the email, click the link) but
// short enough that returning users a day later don't accidentally
// get re-routed through onboarding. Both Supabase email signups and
// Google-OAuth signups populate user.created_at the moment the
// account is provisioned, so a single check covers both paths.
const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

function isFreshlyCreatedUser(user) {
  if (!user?.created_at) return false;
  const createdMs = Date.parse(user.created_at);
  if (!Number.isFinite(createdMs)) return false;
  return Date.now() - createdMs < NEW_USER_WINDOW_MS;
}

// The page shell shared by the form and the "check your email" state: the
// full-bleed panel backdrop with a single centered card holding the content.
const PageShell = ({ children }) => (
  <div
    className="fixed inset-0 z-50 overflow-hidden bg-white"
    style={{ fontFamily: LANDING_FONT }}
  >
    <PanelArt />
    <div className="relative h-full flex flex-col px-5 py-4">
      {/* The card centers via m-auto (not items-center) so that on windows
          shorter than the card the top edge stays reachable when scrolling. */}
      <div className="flex-1 flex overflow-y-auto">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
          className="m-auto w-full max-w-[440px] rounded-[28px] border border-slate-200 bg-white p-7 sm:p-9 shadow-[0_32px_80px_-32px_rgba(15,23,42,0.35)]"
        >
          {children}
        </motion.div>
      </div>
    </div>
  </div>
);

export default function Login() {
  const nav = useNavigate();
  const location = useLocation();
  const {
    user,
    loading,
    authError,
    signInWithOAuth,
    signInWithEmail,
    signUpWithEmail,
    resetPasswordForEmail,
    resendSignupEmail,
  } = useAuth();
  // "login" | "signup" | "forgot" (password-reset email request)
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // null | "confirm" (signup confirmation sent) | "reset" (recovery link sent)
  const [successKind, setSuccessKind] = useState(null);
  // idle | sending | sent | error — the "Resend email" button on the
  // check-your-email screen.
  const [resendState, setResendState] = useState("idle");

  // Default post-login destination is the app, NOT the landing page.
  // `/` now renders the synthetic-intelligence onboarding prototype which
  // is a guest-only experience; signed-in users should land directly in
  // their grid. `from` is still honored so deep links into a specific
  // route (e.g. `/vault`, `/chat/<id>`) keep working through the auth gate.
  // Search + hash are preserved too — dropping them breaks any deep link that
  // carries state in the query string (worst case: /share?url=… lost its URL).
  const fromLocation = location.state?.from;
  const from = fromLocation?.pathname
    ? `${fromLocation.pathname}${fromLocation.search || ""}${fromLocation.hash || ""}`
    : "/app";
  const prefilledEmail = location.state?.email;

  useEffect(() => {
    if (prefilledEmail) setEmail(prefilledEmail);
  }, [prefilledEmail]);

  // Post-auth routing. NEW users (signup auto-confirmed OR landing here right
  // after clicking the email-confirmation link) hit /onboarding/connect so
  // they see the AI-tool cards; everyone else goes to `from` (default /app).
  // The subscription gate in App.jsx then routes anyone without trial/paid
  // access to /start-trial. The "new user" signal is user.created_at within
  // the last 10 minutes, which covers both email and Google OAuth signups
  // without a server migration. An explicit `from` (set by ProtectedRoute on
  // a deep link) always wins so we don't hijack their intent.
  useEffect(() => {
    if (loading || !user) return;
    const hasExplicitFrom = !!location.state?.from?.pathname;
    if (hasExplicitFrom) {
      nav(from, { replace: true });
      return;
    }
    if (isFreshlyCreatedUser(user) && !isConnectOnboardingDone()) {
      nav("/onboarding/connect", { replace: true });
      return;
    }
    nav(from, { replace: true });
  }, [loading, nav, user, from, location.state]);

  // `error` state is set with already-humanized copy (validation + the catch
  // below run it through friendlyError once). Only `authError` — the raw
  // Supabase error surfaced by the auth context — still needs mapping here.
  // Running `error` through friendlyError a second time used to collapse
  // every specific message into the generic "Something went wrong" fallback.
  const displayError = error || friendlyError(authError);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setError(null);
    if (!email.trim()) {
      setError("Email is required.");
      return;
    }
    if (mode !== "forgot" && !password.trim()) {
      setError("Email and password are required.");
      return;
    }
    if (mode === "signup" && password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "login") {
        await signInWithEmail(email.trim(), password);
      } else if (mode === "forgot") {
        await resetPasswordForEmail(email.trim());
        setResendState("idle");
        setSuccessKind("reset");
      } else {
        const data = await signUpWithEmail(email.trim(), password, { name: name.trim() });
        const u = data?.user;
        const emptyIdentities = !u?.identities || u.identities.length === 0;
        const alreadyConfirmed = !!(u?.email_confirmed_at || u?.confirmed_at);
        const noSession = !data?.session;

        if (u && emptyIdentities) {
          setError("An account with this email already exists. Try signing in instead.");
        } else if (u && noSession && alreadyConfirmed) {
          setError("An account with this email already exists. Try signing in instead.");
        } else if (!u) {
          setError("Something went wrong. Please try again.");
        } else if (data?.session) {
          // Email confirmation is disabled / auto-confirm: the user is signed
          // in right now. Skip the "check your email" screen — the post-auth
          // useEffect above handles the redirect into the app.
        } else {
          setResendState("idle");
          setSuccessKind("confirm");
        }
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('Auth error:', err);
      setError(friendlyError(err?.message) || "Authentication failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !submitting) handleSubmit(e);
  };

  // "Resend email" on the check-your-email screen. Covers both the signup
  // confirmation and the password-recovery link; Supabase rate-limits
  // resends per address, so surface that case honestly.
  const handleResend = async () => {
    if (resendState === "sending") return;
    setResendState("sending");
    try {
      if (successKind === "reset") {
        await resetPasswordForEmail(email.trim());
      } else {
        await resendSignupEmail(email.trim());
      }
      setResendState("sent");
    } catch (err) {
      if (import.meta.env.DEV) console.error("Resend failed:", err);
      setResendState("error");
    }
  };

  if (successKind) {
    return (
      <PageShell>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", delay: 0.15 }}
            className="w-16 h-16 mb-6 rounded-2xl bg-blue-500/15 ring-1 ring-blue-300/50 flex items-center justify-center"
          >
            <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </motion.div>
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">
            Check your email
          </h2>
          <p className="text-slate-600 mb-8">
            {successKind === "reset" ? (
              <>
                We sent a password-reset link to{" "}
                <span className="font-medium text-slate-800">{email}</span>.
                Click it to choose a new password.
              </>
            ) : (
              <>
                We sent a confirmation link to{" "}
                <span className="font-medium text-slate-800">{email}</span>.
                Click the link to activate your account.
              </>
            )}
          </p>
          <div className="flex items-center gap-5">
            <button
              onClick={() => { setSuccessKind(null); setMode("login"); }}
              className="text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors"
            >
              Back to login
            </button>
            <button
              onClick={handleResend}
              disabled={resendState === "sending" || resendState === "sent"}
              className="text-sm font-medium text-slate-500 hover:text-slate-700 transition-colors disabled:opacity-60"
            >
              {resendState === "sending"
                ? "Sending…"
                : resendState === "sent"
                  ? "Email sent again"
                  : "Resend email"}
            </button>
          </div>
          {resendState === "error" && (
            <p className="mt-3 text-xs text-red-600">
              Couldn't resend just now — wait a minute and try again, and check
              your spam folder.
            </p>
          )}
        </motion.div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <AnimatePresence mode="wait">
        <motion.div
          key={mode}
          initial={{ opacity: 0, x: mode === "login" ? -10 : 10 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: mode === "login" ? 10 : -10 }}
          transition={{ duration: 0.2 }}
        >
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 leading-tight mb-2">
            {mode === "login" ? (
              <span className="inline-flex items-center">
                Login to
                <img
                  src={lyknWordmark}
                  alt="LYKN"
                  className="h-[1.3em] w-auto ml-1 -mb-0.5"
                  draggable={false}
                />
              </span>
            ) : mode === "forgot" ? (
              "Reset your password"
            ) : (
              "Create your account"
            )}
          </h1>
          <p className="text-sm text-slate-500 mb-8">
            {mode === "login"
              ? "Sign in to your intelligence layer"
              : mode === "forgot"
                ? "Enter your email and we'll send you a reset link"
                : "Build an AI that actually knows you"}
          </p>

          {mode !== "forgot" && (
            <>
              <button
                type="button"
                onClick={() => signInWithOAuth("google")}
                className={SECONDARY_BTN_CLS}
              >
                <GoogleIcon />
                Continue with Google
              </button>

              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-white px-3 py-0.5 text-slate-500 font-medium">or</span>
                </div>
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            {mode === "signup" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
              >
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Full name"
                  autoComplete="name"
                  className={INPUT_CLS}
                />
              </motion.div>
            )}
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Email address"
              autoComplete="email"
              className={INPUT_CLS}
            />
            {mode !== "forgot" && (
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                className={INPUT_CLS}
              />
            )}
            {mode === "login" && (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => { setMode("forgot"); setError(null); }}
                  className="text-xs font-medium text-slate-500 hover:text-blue-600 transition-colors"
                >
                  Forgot password?
                </button>
              </div>
            )}

            <ErrorBanner message={displayError} />

            <SubmitButton
              submitting={submitting}
              label={
                mode === "login"
                  ? "Sign in"
                  : mode === "forgot"
                    ? "Send reset link"
                    : "Create account"
              }
              busyLabel={
                mode === "login"
                  ? "Signing in..."
                  : mode === "forgot"
                    ? "Sending..."
                    : "Creating account..."
              }
            />
          </form>
        </motion.div>
      </AnimatePresence>

      <div className="mt-6 text-sm text-slate-600">
        {mode === "login"
          ? "Don't have an account?"
          : mode === "forgot"
            ? "Remembered it?"
            : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => { setMode(mode === "login" ? "signup" : "login"); setError(null); setSuccessKind(null); }}
          className="font-semibold text-blue-600 hover:text-blue-700 transition-colors"
        >
          {mode === "login" ? "Sign up" : "Sign in"}
        </button>
      </div>

      <p className="mt-6 pt-5 border-t border-slate-200 text-[11px] leading-relaxed text-slate-500">
        By continuing, you agree to LYKN's{" "}
        <Link to="/terms" className="text-slate-600 underline underline-offset-2 hover:text-blue-600">
          Terms of Service
        </Link>
        ,{" "}
        <Link to="/privacy" className="text-slate-600 underline underline-offset-2 hover:text-blue-600">
          Privacy Policy
        </Link>
        , and{" "}
        <Link to="/cookies" className="text-slate-600 underline underline-offset-2 hover:text-blue-600">
          Cookie Policy
        </Link>
        .
      </p>
    </PageShell>
  );
}
