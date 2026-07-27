import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { useAuth } from "@/lib/SupabaseAuth";
import { supabase } from "@/lib/supabase";
import { canUseWebApp, resolvePostAuthPath } from "@/lib/webAppAccess";

// Legacy landing for old Supabase recovery links. New resets use a 6-digit
// code emailed via Resend and complete on /login. Kept so in-flight links
// still work: detectSessionInUrl exchanges ?code into a recovery session,
// then updateUser sets the password.

const LANDING_FONT =
  '"Inter", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';

const INPUT_CLS =
  "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all duration-200";
const SUBMIT_CLS =
  "w-full rounded-xl px-4 py-3 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 mt-1 bg-gradient-to-b from-[#6ea8ff] to-[#2563eb] shadow-[0_12px_26px_-10px_rgba(37,99,235,0.65),inset_0_1px_0_rgba(255,255,255,0.45)] hover:from-[#5b9bff] hover:to-[#1e40af]";

const Shell = ({ children }) => (
  <div
    className="fixed inset-0 z-50 overflow-y-auto bg-white"
    style={{ fontFamily: LANDING_FONT }}
  >
    <div className="min-h-full flex items-center justify-center px-5 py-8">
      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[440px] rounded-[28px] border border-slate-200 bg-white p-7 sm:p-9 shadow-[0_32px_80px_-32px_rgba(15,23,42,0.35)]"
      >
        {children}
      </motion.div>
    </div>
  </div>
);

export default function ResetPassword() {
  const nav = useNavigate();
  const { user, loading } = useAuth();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e) => {
    e?.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      const { error: updateErr } = await supabase.auth.updateUser({ password });
      if (updateErr) throw updateErr;
      setDone(true);
      // Recovery leaves the user signed in. On desktop/web-enabled clients
      // open the product; on the public website land on /download (session
      // is already saved for the Mac app).
      const dest = resolvePostAuthPath("/app");
      setTimeout(() => nav(dest, { replace: true }), 1200);
    } catch (err) {
      if (import.meta.env.DEV) console.error("[ResetPassword]", err);
      const msg = String(err?.message || "").toLowerCase();
      if (msg.includes("should be different")) {
        setError("New password must be different from your current one.");
      } else if (msg.includes("at least")) {
        setError("Password must be at least 6 characters.");
      } else {
        setError("Couldn't update your password. The reset link may have expired — request a new one.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <Shell>
        <p className="text-sm text-slate-500">Checking your reset link…</p>
      </Shell>
    );
  }

  // No recovery session: the link expired, was already used, or was opened in
  // a different browser than expected. Send them back to request a fresh one.
  if (!user) {
    return (
      <Shell>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 mb-2">
          Reset link expired
        </h1>
        <p className="text-sm text-slate-500 mb-6 leading-relaxed">
          This password-reset link is no longer valid. Request a new reset
          from login — we’ll email you a 6-digit code instead.
        </p>
        <Link
          to="/login"
          className="text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors"
        >
          Request a new reset
        </Link>
      </Shell>
    );
  }

  if (done) {
    const webOk = canUseWebApp();
    return (
      <Shell>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 mb-2">
          Password updated
        </h1>
        <p className="text-sm text-slate-500">
          {webOk
            ? "Taking you into LYKN…"
            : "Open the LYKN desktop app to continue — you're signed in."}
        </p>
        {!webOk && (
          <Link
            to="/download"
            className="mt-6 inline-flex text-sm font-semibold text-blue-600 hover:text-blue-700"
          >
            Get the desktop app
          </Link>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900 mb-2">
        Choose a new password
      </h1>
      <p className="text-sm text-slate-500 mb-7">
        for <span className="font-medium text-slate-700">{user.email}</span>
      </p>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="New password"
          autoComplete="new-password"
          autoFocus
          className={INPUT_CLS}
        />
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="Confirm new password"
          autoComplete="new-password"
          className={INPUT_CLS}
        />
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2.5">
            <span className="text-xs text-red-700">{error}</span>
          </div>
        )}
        <button type="submit" disabled={submitting} className={SUBMIT_CLS}>
          {submitting ? "Updating…" : "Update password"}
        </button>
      </form>
    </Shell>
  );
}
