import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/SupabaseAuth";

export default function Login() {
  const nav = useNavigate();
  const { user, loading, signInWithOAuth, signInWithEmail, signUpWithEmail } = useAuth();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) nav("/", { replace: true });
  }, [loading, nav, user]);

  const handleSubmit = async () => {
    setError(null);
    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "login") {
        await signInWithEmail(email.trim(), password);
      } else {
        await signUpWithEmail(email.trim(), password);
      }
    } catch (err) {
      setError(err?.message || "Authentication failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f2f2f7]/80 text-black flex items-center justify-center px-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-blue-100/50 via-white/40 to-orange-100/40" />
      <div className="absolute -top-24 -right-24 h-64 w-64 rounded-full bg-white/40 blur-2xl" />
      <div className="absolute bottom-0 left-0 h-40 w-40 rounded-full bg-blue-100/60 blur-xl" />
      <div className="w-full max-w-md rounded-2xl border border-black/10 bg-[#f2f2f7]/70 backdrop-blur-md shadow-2xl p-8 relative">
        <div className="text-center">
          <div className="text-xl font-semibold">Omnia</div>
          <div className="mt-1 text-sm text-black/60">
            {mode === "login" ? "Welcome back" : "Create your account"}
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-black outline-none"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-black outline-none"
          />
          {error && <div className="text-xs text-red-600">{error}</div>}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full rounded-full border border-black/20 bg-white/80 px-4 py-2 text-sm font-medium hover:bg-black/5 disabled:opacity-60"
          >
            {mode === "login" ? "Log in" : "Create account"}
          </button>
          <button
            type="button"
            onClick={() => signInWithOAuth("google")}
            className="w-full rounded-full border border-black/10 bg-white/60 px-4 py-2 text-sm hover:bg-black/5"
          >
            Continue with Google
          </button>
          <div className="text-center text-xs text-black/60">
            {mode === "login" ? "New here?" : "Already have an account?"}{" "}
            <button
              type="button"
              onClick={() => setMode(mode === "login" ? "signup" : "login")}
              className="text-black underline"
            >
              {mode === "login" ? "Create account" : "Log in"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
