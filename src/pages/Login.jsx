import React, { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";
import { motion, AnimatePresence } from "framer-motion";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

const FloatingOrb = ({ className, delay = 0 }) => (
  <motion.div
    className={`absolute rounded-full blur-3xl opacity-30 ${className}`}
    animate={{
      y: [0, -20, 0],
      x: [0, 10, 0],
      scale: [1, 1.05, 1],
    }}
    transition={{
      duration: 8,
      repeat: Infinity,
      ease: "easeInOut",
      delay,
    }}
  />
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
  return raw;
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

  const from = location.state?.from?.pathname || "/";

  useEffect(() => {
    if (!loading && user) nav(from, { replace: true });
  }, [loading, nav, user, from]);

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
        await signUpWithEmail(email.trim(), password);
        setShowSuccess(true);
      }
    } catch (err) {
      setError(err?.message || "Authentication failed.");
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
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#fafafa]">
        <FloatingOrb className="w-96 h-96 bg-blue-400 -top-20 -left-20" />
        <FloatingOrb className="w-80 h-80 bg-violet-400 -bottom-10 -right-10" delay={2} />
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="relative z-10 text-center max-w-md px-8"
        >
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", delay: 0.2 }}
            className="w-16 h-16 mx-auto mb-6 rounded-full bg-green-100 flex items-center justify-center"
          >
            <svg className="w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </motion.div>
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Check your email</h2>
          <p className="text-gray-500 mb-8">
            We sent a confirmation link to <span className="font-medium text-gray-700">{email}</span>. Click the link to activate your account.
          </p>
          <button
            onClick={() => { setShowSuccess(false); setMode("login"); }}
            className="text-sm font-medium text-gray-900 underline underline-offset-4 hover:text-gray-600 transition-colors"
          >
            Back to login
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-[#fafafa] overflow-hidden">
      <FloatingOrb className="w-[500px] h-[500px] bg-blue-300 -top-32 -left-32" />
      <FloatingOrb className="w-[400px] h-[400px] bg-violet-300 top-1/2 -right-20" delay={2} />
      <FloatingOrb className="w-[300px] h-[300px] bg-amber-200 -bottom-16 left-1/3" delay={4} />

      {/* Left branding panel - hidden on mobile */}
      <div className="hidden lg:flex lg:w-[45%] relative items-center justify-center p-12">
        <div className="relative z-10 max-w-md">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <h1 className="text-5xl font-bold text-gray-900 tracking-tight leading-tight mb-4">
              LYKN
            </h1>
            <p className="text-2xl font-medium text-blue-500 leading-relaxed mb-6">
              Your AI interface.
            </p>
            <p className="text-base text-gray-500 leading-relaxed">
              LYKN is your AI-powered second brain that captures, organizes, and connects everything you need in one place. Stay on top of your thoughts, projects, and schedule with intelligent tools built to work the way you think.
            </p>
          </motion.div>
        </div>
      </div>

      {/* Right auth panel */}
      <div className="flex-1 flex items-center justify-center p-6 sm:p-12 relative">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="w-full max-w-[420px] relative z-10"
        >
          {/* Mobile branding */}
          <div className="lg:hidden mb-8 text-center">
            <span className="text-2xl font-bold text-gray-900 tracking-tight">LYKN</span>
          </div>

          <div className="bg-white/80 backdrop-blur-xl rounded-3xl border border-gray-200/80 shadow-xl shadow-gray-200/40 p-8 sm:p-10">
            <AnimatePresence mode="wait">
              <motion.div
                key={mode}
                initial={{ opacity: 0, x: mode === "login" ? -10 : 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: mode === "login" ? 10 : -10 }}
                transition={{ duration: 0.2 }}
              >
                <h2 className="text-2xl font-semibold text-gray-900 mb-1">
                  {mode === "login" ? "Welcome back" : "Create your account"}
                </h2>
                <p className="text-sm text-gray-500 mb-7">
                  {mode === "login"
                    ? "Sign in to continue to LYKN"
                    : "Get started with your second brain"}
                </p>

                <button
                  type="button"
                  onClick={() => signInWithOAuth("google")}
                  className="w-full flex items-center justify-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:border-gray-300 transition-all duration-200 shadow-sm"
                >
                  <GoogleIcon />
                  Continue with Google
                </button>

                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-200" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="bg-white px-3 text-gray-400 font-medium">or</span>
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
                        className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-400 focus:bg-white focus:ring-2 focus:ring-gray-100 transition-all duration-200"
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
                    className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-400 focus:bg-white focus:ring-2 focus:ring-gray-100 transition-all duration-200"
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50/50 px-4 py-3 text-sm text-gray-900 placeholder:text-gray-400 outline-none focus:border-gray-400 focus:bg-white focus:ring-2 focus:ring-gray-100 transition-all duration-200"
                  />

                  <AnimatePresence>
                    {displayError && (
                      <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        className="flex items-center gap-2 rounded-lg bg-red-50 border border-red-100 px-3 py-2.5"
                      >
                        <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                        </svg>
                        <span className="text-xs text-red-700">{displayError}</span>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <button
                    type="submit"
                    disabled={submitting}
                    className="w-full rounded-xl bg-gray-900 px-4 py-3 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-sm shadow-gray-900/20 mt-1"
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
                  </button>
                </form>
              </motion.div>
            </AnimatePresence>

            <div className="mt-6 text-center text-sm text-gray-500">
              {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
              <button
                type="button"
                onClick={switchMode}
                className="font-medium text-gray-900 hover:text-gray-700 transition-colors"
              >
                {mode === "login" ? "Sign up" : "Sign in"}
              </button>
            </div>
          </div>

          <p className="mt-6 text-center text-xs text-gray-400">
            By continuing, you agree to LYKN's Terms of Service and Privacy Policy.
          </p>
        </motion.div>
      </div>
    </div>
  );
}
