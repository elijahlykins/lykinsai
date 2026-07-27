import { useState } from "react";
import { useAuth } from "@/lib/SupabaseAuth";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

const EyeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
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

export default function SignInPill({ className = "", compact = false }) {
  const { user, signInWithOAuth, signInWithEmail, signUpWithEmail, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const resetForm = () => {
    setMode("login");
    setEmail("");
    setPassword("");
    setConfirmPassword("");
    setName("");
    setShowPassword(false);
    setShowConfirmPassword(false);
    setError(null);
    setSubmitting(false);
  };

  const handlePillClick = () => {
    if (user) {
      const ok = window.confirm("Sign out of your account?");
      if (ok) signOut();
      return;
    }
    resetForm();
    setOpen(true);
  };

  const switchMode = () => {
    setMode((m) => (m === "login" ? "signup" : "login"));
    setError(null);
    setConfirmPassword("");
    setShowPassword(false);
    setShowConfirmPassword(false);
  };

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
    if (mode === "signup" && password !== confirmPassword) {
      setError("Passwords don’t match.");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "login") {
        await signInWithEmail(email.trim(), password);
        // Auth state change drives routing (GuestOnly / subscription gate).
        setOpen(false);
      } else {
        // Password signup emails a 6-digit code — finish on /login verify screen.
        const data = await signUpWithEmail(email.trim(), password, { name: name.trim() });
        try {
          sessionStorage.setItem(
            "lykn:pendingSignupVerify",
            JSON.stringify({
              email: email.trim(),
              password,
              name: name.trim(),
              expiresAt: data?.expiresAt || null,
            }),
          );
        } catch {
          /* ignore */
        }
        setOpen(false);
        window.location.assign("/login");
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error("Auth error:", err);
      setError(friendlyError(err?.message) || "Authentication failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !submitting) handleSubmit(e);
  };

  return (
    <>
      <button
        type="button"
        onClick={handlePillClick}
        className={
          compact
            ? `flex items-center justify-center rounded-full p-0 hover:bg-blue-500/15 transition-colors ${className}`
            : `flex items-center gap-1.5 rounded-full bg-white/45 dark:bg-[rgba(60,60,60,0.14)] backdrop-blur-sm border border-black/6 dark:border-white/10 pl-1 pr-3 py-1 text-[0.6875rem] text-black/70 dark:text-white/70 hover:bg-white/60 dark:hover:bg-white/15 shadow-sm transition-colors ${className}`
        }
        title={user ? "Sign out" : "Sign in"}
        aria-label={user ? "Sign out" : "Sign in"}
      >
        <div className="h-6 w-6 rounded-full bg-blue-500/15 dark:bg-blue-400/20 text-[0.6875rem] font-semibold text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">
          {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
        </div>
        {!compact && <span>{user ? "Signed in" : "Sign in"}</span>}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[420px]">
          <>
              <DialogHeader>
                <DialogTitle>
                  {mode === "login" ? "Welcome to personal AI" : "Create your account"}
                </DialogTitle>
                <DialogDescription>
                  {mode === "login"
                    ? "Sign in to continue to LYKN"
                    : "Get started with your second brain"}
                </DialogDescription>
              </DialogHeader>

              <Button
                type="button"
                variant="outline"
                onClick={() => signInWithOAuth("google", { redirectTo: window.location.href })}
                className="w-full"
              >
                <GoogleIcon />
                Continue with Google
              </Button>

              <div className="relative my-1">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-white/10" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-background px-3 text-muted-foreground font-medium">or</span>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-3">
                {mode === "signup" && (
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Full name"
                    autoComplete="name"
                  />
                )}
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Email address"
                  autoComplete="email"
                />
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Password"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                </div>

                {mode === "signup" && (
                  <div className="relative">
                    <Input
                      type={showConfirmPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Confirm password"
                      autoComplete="new-password"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={showConfirmPassword ? "Hide password" : "Show password"}
                    >
                      {showConfirmPassword ? <EyeIcon /> : <EyeOffIcon />}
                    </button>
                  </div>
                )}

                {error && (
                  <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/25 px-3 py-2.5">
                    <span className="text-xs text-red-600 dark:text-red-300">{error}</span>
                  </div>
                )}

                <Button type="submit" disabled={submitting} className="w-full">
                  {submitting
                    ? mode === "login" ? "Signing in..." : "Creating account..."
                    : mode === "login" ? "Sign in" : "Create account"}
                </Button>
              </form>

              <div className="text-center text-sm text-muted-foreground">
                {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
                <button
                  type="button"
                  onClick={switchMode}
                  className="font-medium text-foreground hover:opacity-70 transition-opacity"
                >
                  {mode === "login" ? "Sign up" : "Sign in"}
                </button>
              </div>
          </>
        </DialogContent>
      </Dialog>
    </>
  );
}
