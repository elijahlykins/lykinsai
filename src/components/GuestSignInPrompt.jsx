import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";

const DISMISS_KEY = "lykn_guest_signin_dismissed";

const GoogleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4" />
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853" />
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05" />
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335" />
  </svg>
);

export default function GuestSignInPrompt() {
  const nav = useNavigate();
  const { user, loading, signInWithOAuth } = useAuth();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [email, setEmail] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!loading && !user && !dismissed) {
      const t = setTimeout(() => setVisible(true), 250);
      return () => clearTimeout(t);
    }
    setVisible(false);
    return undefined;
  }, [loading, user, dismissed]);

  const handleDismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch { /* ignore */ }
    setDismissed(true);
  };

  const handleEmailContinue = (e) => {
    e?.preventDefault();
    const trimmed = email.trim();
    nav("/login", { state: { email: trimmed || undefined } });
  };

  if (loading || user || dismissed) return null;

  return (
    <div
      className={`fixed bottom-4 right-4 z-[85] w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-blue-200/40 dark:border-white/8 bg-white/75 dark:bg-[#1e1e1e]/90 backdrop-blur-md shadow-lg shadow-blue-500/5 dark:shadow-black/40 p-5 transition-all duration-300 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-3 pointer-events-none"
      }`}
      role="dialog"
      aria-label="Sign in to save your data"
    >
      <button
        type="button"
        onClick={handleDismiss}
        className="absolute top-2.5 right-2.5 w-6 h-6 rounded-md flex items-center justify-center text-black/40 dark:text-white/40 hover:bg-black/5 dark:hover:bg-white/10 hover:text-black/70 dark:hover:text-white/80 transition-colors"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>

      <div className="pr-6">
        <h3 className="text-sm font-semibold text-black/90 dark:text-white/90">
          Sign in or create an account
        </h3>
        <p className="mt-1 text-xs text-black/55 dark:text-white/55 leading-relaxed">
          Save and sync your data across devices.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => signInWithOAuth("google")}
          className="w-full flex items-center justify-center gap-2.5 rounded-xl border border-black/10 dark:border-white/10 bg-white dark:bg-white/5 px-3 py-2.5 text-xs font-medium text-black/80 dark:text-white/85 hover:bg-black/[0.03] dark:hover:bg-white/10 transition-colors"
        >
          <GoogleIcon />
          Continue with Google
        </button>
      </div>

      <div className="relative my-4">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-black/8 dark:border-white/10" />
        </div>
        <div className="relative flex justify-center text-[0.625rem]">
          <span className="px-2 text-black/40 dark:text-white/40 font-medium uppercase tracking-wider bg-white/75 dark:bg-[#1e1e1e]/90 backdrop-blur-md">
            or
          </span>
        </div>
      </div>

      <form onSubmit={handleEmailContinue} className="flex flex-col gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your email"
          autoComplete="email"
          className="w-full rounded-xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/5 px-3 py-2.5 text-xs text-black/85 dark:text-white/90 placeholder:text-black/35 dark:placeholder:text-white/35 outline-none focus:border-blue-400/60 dark:focus:border-blue-400/40 focus:bg-white dark:focus:bg-white/10 transition-colors"
        />
        <button
          type="submit"
          className="w-full rounded-xl bg-blue-500/15 hover:bg-blue-500/25 dark:bg-blue-400/20 dark:hover:bg-blue-400/30 text-blue-600 dark:text-blue-400 px-3 py-2.5 text-xs font-semibold transition-colors"
        >
          Continue with email
        </button>
      </form>
    </div>
  );
}
