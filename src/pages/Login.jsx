import { useEffect, useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import { isConnectOnboardingDone } from "@/lib/landingHandoff";
import { resolvePostAuthPath } from "@/lib/webAppAccess";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, EyeOff } from "lucide-react";
import lyknWordmark from "@/assets/FINAL/LYKN-WORDMARK/PNGs/LYKN-Wordmark-BLUE-web.png";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

const LANDING_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

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

function PasswordField({
  value,
  onChange,
  onKeyDown = undefined,
  placeholder,
  autoComplete,
  show,
  onToggleShow,
}) {
  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={onChange}
        {...(onKeyDown ? { onKeyDown } : {})}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={`${INPUT_CLS} pr-11`}
      />
      <button
        type="button"
        onClick={onToggleShow}
        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-md text-slate-400 hover:text-slate-700 transition-colors"
        aria-label={show ? "Hide password" : "Show password"}
        tabIndex={0}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

function friendlyError(raw) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("code verifier") || lower.includes("auth code") || lower.includes("invalid request"))
    return "Something went wrong. Please sign in with Google or enter your email and password to get started.";
  if (lower.includes("invalid login") || lower.includes("invalid credentials"))
    return "Incorrect email or password. Please try again.";
  if (lower.includes("email not confirmed"))
    return "Please enter the confirmation code from your email before signing in.";
  if (lower.includes("user already registered") || lower.includes("already been registered") || lower.includes("already exists"))
    return "An account with this email already exists. Try signing in instead.";
  if (lower.includes("rate limit") || lower.includes("too many"))
    return "Too many attempts. Please wait a moment and try again.";
  if (lower.includes("network") || lower.includes("fetch"))
    return "Connection error. Please check your internet and try again.";
  if (lower.includes("password") && lower.includes("characters"))
    return "Password must be at least 6 characters.";
  if (lower.includes("expired"))
    return "Code expired. Request a new one.";
  if (lower.includes("incorrect code"))
    return "Incorrect code. Try again.";
  // Prefer the server's own humanized message when it's already clean.
  if (raw.length < 120 && !lower.includes("error:") && !lower.includes("exception")) return raw;
  return "Something went wrong. Please try again.";
}

const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

function isFreshlyCreatedUser(user) {
  if (!user?.created_at) return false;
  const createdMs = Date.parse(user.created_at);
  if (!Number.isFinite(createdMs)) return false;
  return Date.now() - createdMs < NEW_USER_WINDOW_MS;
}

function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const PageShell = ({ children }) => (
  <div
    className="fixed inset-0 z-50 overflow-hidden bg-white"
    style={{ fontFamily: LANDING_FONT }}
  >
    <PanelArt />
    <div className="relative h-full flex flex-col px-5 py-4">
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
    signingOut,
    authError,
    signInWithOAuth,
    signInWithEmail,
    signUpWithEmail,
    verifySignupEmailCode,
    resetPasswordForEmail,
    resendSignupEmail,
  } = useAuth();
  // "login" | "signup" | "forgot"
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // null | "verify" (signup code) | "reset" (recovery link sent)
  const [successKind, setSuccessKind] = useState(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [resendState, setResendState] = useState("idle");

  const fromLocation = location.state?.from;
  const from = fromLocation?.pathname
    ? `${fromLocation.pathname}${fromLocation.search || ""}${fromLocation.hash || ""}`
    : "/app";
  const prefilledEmail = location.state?.email;

  useEffect(() => {
    if (prefilledEmail) setEmail(prefilledEmail);
  }, [prefilledEmail]);

  // Resume code-verify after signup started from SignInPill (or similar).
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("lykn:pendingSignupVerify");
      if (!raw) return;
      sessionStorage.removeItem("lykn:pendingSignupVerify");
      const pending = JSON.parse(raw);
      if (!pending?.email || !pending?.password) return;
      setEmail(String(pending.email));
      setPassword(String(pending.password));
      setName(String(pending.name || ""));
      setExpiresAt(
        pending.expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      );
      setSuccessKind("verify");
      setMode("signup");
    } catch {
      /* ignore */
    }
  }, []);

  // Live countdown for the 5-minute signup code.
  useEffect(() => {
    if (successKind !== "verify" || !expiresAt) return undefined;
    const tick = () => {
      const left = Math.max(0, Date.parse(expiresAt) - Date.now());
      setRemainingMs(left);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [successKind, expiresAt]);

  useEffect(() => {
    if (loading || !user || signingOut) return;
    const fromPath = location.state?.from?.pathname || "";
    const hasExplicitFrom =
      !!fromPath && fromPath !== "/start-trial" && fromPath !== "/login";
    let pendingShareDest = "";
    try {
      const pending = String(sessionStorage.getItem("lykn:pendingShare") || "").trim();
      if (pending && /^https?:\/\//i.test(pending)) {
        pendingShareDest = `/share?url=${encodeURIComponent(pending)}`;
      }
    } catch {
      /* storage may be blocked */
    }
    let dest = "/app";
    if (hasExplicitFrom) {
      dest = from;
    } else if (pendingShareDest) {
      dest = pendingShareDest;
    } else if (isFreshlyCreatedUser(user) && !isConnectOnboardingDone()) {
      dest = "/onboarding/connect";
    }
    nav(resolvePostAuthPath(dest), { replace: true });
  }, [loading, signingOut, nav, user, from, location.state]);

  const displayError = error || friendlyError(authError);

  const resetToLogin = () => {
    setSuccessKind(null);
    setMode("login");
    setError(null);
    setPassword("");
    setConfirmPassword("");
    setVerifyCode("");
    setExpiresAt(null);
    setRemainingMs(0);
    setResendState("idle");
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

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
    if (mode === "signup" && password !== confirmPassword) {
      setError("Passwords don’t match.");
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
        setResendState("idle");
        setVerifyCode("");
        setExpiresAt(data?.expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString());
        setSuccessKind("verify");
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("Auth error:", err);
      setError(friendlyError(err?.message) || "Authentication failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async (e) => {
    e?.preventDefault();
    setError(null);
    if (remainingMs <= 0) {
      setError("Code expired. Request a new one.");
      return;
    }
    const code = verifyCode.replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit code from your email.");
      return;
    }
    setSubmitting(true);
    try {
      await verifySignupEmailCode(email.trim(), code);
      // Account is confirmed — sign in with the password from the signup form.
      await signInWithEmail(email.trim(), password);
      // Post-auth effect → paywall / onboarding as usual.
    } catch (err) {
      if (import.meta.env.DEV) console.error("Verify error:", err);
      setError(friendlyError(err?.message) || "Could not verify code.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resendState === "sending") return;
    setResendState("sending");
    setError(null);
    try {
      if (successKind === "reset") {
        await resetPasswordForEmail(email.trim());
        setResendState("sent");
      } else {
        const data = await resendSignupEmail(email.trim());
        setExpiresAt(data?.expiresAt || new Date(Date.now() + 5 * 60 * 1000).toISOString());
        setVerifyCode("");
        setResendState("sent");
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("Resend failed:", err);
      setResendState("error");
      setError(friendlyError(err?.message));
    }
  };

  if (successKind === "verify") {
    const expired = remainingMs <= 0;
    return (
      <PageShell>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
        >
          <div className="w-14 h-14 mb-5 rounded-2xl bg-blue-500/15 ring-1 ring-blue-300/50 flex items-center justify-center">
            <svg className="w-7 h-7 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">
            Enter confirmation code
          </h2>
          <p className="text-slate-600 mb-6 text-sm leading-relaxed">
            We sent a 6-digit code to{" "}
            <span className="font-medium text-slate-800">{email}</span>.
            Paste it below to activate your account.
          </p>

          <form onSubmit={handleVerify} className="space-y-3">
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value.replace(/[^\d\s]/g, "").slice(0, 8))}
              placeholder="6-digit code"
              className={`${INPUT_CLS} tracking-[0.35em] text-center text-base font-semibold`}
              autoFocus
            />
            <div className="flex items-center justify-between text-xs">
              <span className={expired ? "text-red-600 font-medium" : "text-slate-500"}>
                {expired ? "Code expired" : `Expires in ${formatCountdown(remainingMs)}`}
              </span>
              <button
                type="button"
                onClick={handleResend}
                disabled={resendState === "sending"}
                className="font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
              >
                {resendState === "sending"
                  ? "Sending…"
                  : resendState === "sent"
                    ? "Code sent again"
                    : "Resend code"}
              </button>
            </div>
            <ErrorBanner message={displayError} />
            <motion.button
              type="submit"
              disabled={submitting || expired}
              whileHover={expired ? undefined : { y: -1 }}
              whileTap={expired ? undefined : { scale: 0.99 }}
              className={SUBMIT_CLS}
            >
              {submitting ? (
                <span className="flex items-center justify-center gap-2">
                  <Spinner />
                  Verifying…
                </span>
              ) : expired ? (
                "Code expired — resend"
              ) : (
                "Verify and continue"
              )}
            </motion.button>
          </form>

          <button
            type="button"
            onClick={resetToLogin}
            className="mt-5 text-sm font-semibold text-slate-500 hover:text-slate-800 transition-colors"
          >
            Back to login
          </button>
        </motion.div>
      </PageShell>
    );
  }

  if (successKind === "reset") {
    return (
      <PageShell>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <div className="w-16 h-16 mb-6 rounded-2xl bg-blue-500/15 ring-1 ring-blue-300/50 flex items-center justify-center">
            <svg className="w-8 h-8 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-slate-900 mb-2">
            Check your email
          </h2>
          <p className="text-slate-600 mb-8">
            We sent a password-reset link to{" "}
            <span className="font-medium text-slate-800">{email}</span>.
            Click it to choose a new password.
          </p>
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={resetToLogin}
              className="text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors"
            >
              Back to login
            </button>
            <button
              type="button"
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
              placeholder="Email address"
              autoComplete="email"
              className={INPUT_CLS}
            />
            {mode !== "forgot" && (
              <PasswordField
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                show={showPassword}
                onToggleShow={() => setShowPassword((v) => !v)}
              />
            )}
            {mode === "signup" && (
              <PasswordField
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                autoComplete="new-password"
                show={showConfirmPassword}
                onToggleShow={() => setShowConfirmPassword((v) => !v)}
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
          onClick={() => {
            if (mode === "login") {
              setMode("signup");
              setError(null);
            } else {
              resetToLogin();
            }
          }}
          className="font-semibold text-blue-600 hover:text-blue-700 transition-colors"
        >
          {mode === "login" ? "Sign up" : "Sign in"}
        </button>
      </div>

      <p className="mt-6 pt-5 border-t border-slate-200 text-[11px] leading-relaxed text-slate-500">
        By continuing, you agree to LYKN&apos;s{" "}
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
