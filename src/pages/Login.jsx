import React, { useEffect, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import { isConnectOnboardingDone } from "@/lib/landingHandoff";
import { motion, AnimatePresence } from "framer-motion";
import lyknLogoWhite from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";
import lyknWordmark from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-BLUE-web.png";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

// The same blended blue → white vertical gradient the landing hero uses, so
// the sign-in page reads as part of the same world.
const HERO_GRADIENT =
  "linear-gradient(180deg, #1d4ed8 0%, #2f6bf0 22%, #5b93f5 45%, #93bdfa 68%, #cfe0fc 86%, #f6f8fc 100%)";

// Soft, slowly drifting blurred orbs that give the gradient depth and gentle
// motion behind the glass cards. Purely decorative.
const ORBS = [
  { cls: "w-[28rem] h-[28rem] -top-28 -left-24 bg-white/30", dur: 15, dx: 36, dy: 26 },
  { cls: "w-[24rem] h-[24rem] top-1/3 -right-28 bg-sky-200/40", dur: 18, dx: -30, dy: 34 },
  { cls: "w-[22rem] h-[22rem] bottom-[-7rem] left-1/4 bg-indigo-300/30", dur: 22, dx: 26, dy: -22 },
];

const FloatingOrbs = () => (
  <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
    {ORBS.map((o, i) => (
      <motion.div
        key={i}
        className={`absolute rounded-full blur-3xl ${o.cls}`}
        animate={{ x: [0, o.dx, 0], y: [0, o.dy, 0] }}
        transition={{ duration: o.dur, repeat: Infinity, ease: "easeInOut" }}
      />
    ))}
  </div>
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

export default function Login() {
  const nav = useNavigate();
  const location = useLocation();
  const { user, loading, authError, signInWithOAuth, signInWithEmail, signUpWithEmail } = useAuth();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  // Default post-login destination is the app, NOT the landing page.
  // `/` now renders the synthetic-intelligence onboarding prototype which
  // is a guest-only experience; signed-in users should land directly in
  // their grid. `from` is still honored so deep links into a specific
  // route (e.g. `/vault`, `/chat/<id>`) keep working through the auth gate.
  const from = location.state?.from?.pathname || "/app";
  const prefilledEmail = location.state?.email;

  useEffect(() => {
    if (prefilledEmail) setEmail(prefilledEmail);
  }, [prefilledEmail]);

  // Post-auth routing. With the free tier there's no checkout gate — every
  // authenticated user can use the app. NEW users (signup auto-confirmed OR
  // landing here right after clicking the email-confirmation link) hit
  // /onboarding/connect so they see the AI-tool cards; everyone else goes to
  // `from` (default /app). The "new user" signal is user.created_at within the
  // last 10 minutes, which covers both email and Google OAuth signups without a
  // server migration. An explicit `from` (set by ProtectedRoute on a deep link)
  // always wins so we don't hijack their intent.
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

  const displayError = friendlyError(error || authError);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setError(null);
    if (!email.trim() || !password.trim()) {
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
        } else {
          setShowSuccess(true);
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

  const switchMode = () => {
    setMode(mode === "login" ? "signup" : "login");
    setError(null);
    setShowSuccess(false);
  };

  if (showSuccess) {
    return (
      <div className="fixed inset-0 z-50 overflow-y-auto" style={{ background: HERO_GRADIENT }}>
        <FloatingOrbs />
        <div className="relative min-h-full flex items-center justify-center px-5 py-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="w-full max-w-[420px] rounded-[28px] border border-white/50 bg-white/70 backdrop-blur-2xl shadow-[0_30px_80px_-30px_rgba(15,23,42,0.55)] p-8 sm:p-10 text-center"
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", delay: 0.15 }}
              className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-blue-500/15 ring-1 ring-blue-300/50 flex items-center justify-center"
            >
              <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </motion.div>
            <h2 className="text-2xl font-semibold text-[#0a0c12] mb-2">Check your email</h2>
            <p className="text-slate-600 mb-8">
              We sent a confirmation link to <span className="font-medium text-slate-800">{email}</span>. Click the link to activate your account.
            </p>
            <button
              onClick={() => { setShowSuccess(false); setMode("login"); }}
              className="text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors"
            >
              Back to login
            </button>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" style={{ background: HERO_GRADIENT }}>
      <FloatingOrbs />

      <div className="relative min-h-full flex flex-col items-center justify-center px-5 py-12">
        {/* White logo sits over the blue top of the gradient, mirroring the hero */}
        <motion.img
          src={lyknLogoWhite}
          alt="LYKN"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="h-12 w-auto mb-7 drop-shadow-[0_6px_22px_rgba(15,23,42,0.28)]"
        />

        {/* Glass auth card */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[440px] rounded-[28px] border border-white/50 bg-white/70 backdrop-blur-2xl shadow-[0_30px_80px_-30px_rgba(15,23,42,0.55)] p-7 sm:p-9"
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={mode}
              initial={{ opacity: 0, x: mode === "login" ? -10 : 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: mode === "login" ? 10 : -10 }}
              transition={{ duration: 0.2 }}
            >
              <h2 className="text-2xl font-semibold text-[#0a0c12] mb-1">
                {mode === "login" ? (
                  <span className="inline-flex items-center gap-2 leading-none">
                    Welcome to
                    <img src={lyknWordmark} alt="LYKN" className="h-9 w-auto -ml-2.5" />
                  </span>
                ) : (
                  "Create your account"
                )}
              </h2>
              <p className="text-sm text-slate-600 mb-7">
                {mode === "login"
                  ? "Sign in to your intelligence layer"
                  : "Build an AI that actually knows you"}
              </p>

              <button
                type="button"
                onClick={() => signInWithOAuth("google")}
                className="w-full flex items-center justify-center gap-3 rounded-xl border border-white/70 bg-white/80 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-white hover:border-white transition-all duration-200 shadow-sm"
              >
                <GoogleIcon />
                Continue with Google
              </button>

              <div className="relative my-6">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-300/50" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="rounded-full bg-white/70 backdrop-blur-sm px-3 py-0.5 text-slate-500 font-medium">or</span>
                </div>
              </div>

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
                      className="w-full rounded-xl border border-white/70 bg-white/55 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:bg-white/90 focus:ring-2 focus:ring-blue-200/60 transition-all duration-200"
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
                  className="w-full rounded-xl border border-white/70 bg-white/55 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:bg-white/90 focus:ring-2 focus:ring-blue-200/60 transition-all duration-200"
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  className="w-full rounded-xl border border-white/70 bg-white/55 px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:bg-white/90 focus:ring-2 focus:ring-blue-200/60 transition-all duration-200"
                />

                <AnimatePresence>
                  {displayError && (
                    <motion.div
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      className="flex items-center gap-2 rounded-lg bg-red-50/90 border border-red-200/70 px-3 py-2.5"
                    >
                      <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                      </svg>
                      <span className="text-xs text-red-700">{displayError}</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                <motion.button
                  type="submit"
                  disabled={submitting}
                  whileHover={{ y: -1 }}
                  whileTap={{ scale: 0.99 }}
                  className="w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 mt-1 bg-gradient-to-b from-[#6ea8ff] to-[#2563eb] shadow-[0_12px_26px_-10px_rgba(37,99,235,0.65),inset_0_1px_0_rgba(255,255,255,0.45)] hover:from-[#5b9bff] hover:to-[#1e40af]"
                >
                  {submitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      {mode === "login" ? "Signing in..." : "Creating account..."}
                    </span>
                  ) : (
                    mode === "login" ? "Sign in" : "Create account"
                  )}
                </motion.button>
              </form>
            </motion.div>
          </AnimatePresence>

          <div className="mt-6 text-center text-sm text-slate-600">
            {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={switchMode}
              className="font-semibold text-blue-600 hover:text-blue-700 transition-colors"
            >
              {mode === "login" ? "Sign up" : "Sign in"}
            </button>
          </div>

          <p className="mt-6 pt-5 border-t border-slate-300/40 text-center text-[11px] leading-relaxed text-slate-500">
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
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-6 flex items-center gap-2 text-sm text-white/85"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
          Free to start · no credit card · upgrade anytime
        </motion.p>
      </div>
    </div>
  );
}
