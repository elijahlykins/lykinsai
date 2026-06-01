import { FormEvent, useState } from "react";
import { useAuth } from "@/lib/SupabaseAuth";
import lyknLogo from "@/assets/FINAL/LYKN-LOGO-B-Open/PNGs/LYKN-Logo-Primary-B-Open-NEUTRAL-web.png";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
      />
    </svg>
  );
}

function friendlyError(raw: string | null | undefined) {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (
    lower.includes("invalid login") ||
    lower.includes("invalid credentials")
  ) {
    return "Incorrect email or password. Please try again.";
  }
  if (lower.includes("user already registered") || lower.includes("already been registered")) {
    return "An account with this email already exists. Try signing in instead.";
  }
  if (lower.includes("rate limit") || lower.includes("too many requests")) {
    return "Too many attempts. Please wait a moment and try again.";
  }
  if (lower.includes("password") && lower.includes("characters")) {
    return "Password must be at least 6 characters.";
  }
  return "Something went wrong. Please try again.";
}

export default function WakeCreateAccountSlide() {
  const { signInWithOAuth, signUpWithEmail, authError } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const displayError = friendlyError(error || authError);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password.trim()) {
      setError("Email and password are required.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const data = await signUpWithEmail(email.trim(), password, {
        name: name.trim(),
      });
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
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Authentication failed. Please try again.";
      setError(friendlyError(message) || "Authentication failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="lykn-wake-slide lykn-wake-slide--account">
      <div className="lykn-wake-account-layout">
        <aside className="lykn-wake-account-brand">
          <div className="lykn-wake-account-brand-inner">
            <img
              src={lyknLogo}
              alt="LYKN"
              className="lykn-wake-account-logo"
            />
            <p className="lykn-wake-account-tagline">Make it personal</p>
            <div className="lykn-wake-account-pitch">
              <p className="lykn-wake-account-pitch-title">
                Start building your personal AI today
              </p>
              <p className="lykn-wake-account-pitch-body">
                Your synthesis layer, vault, and chat in one place. One account
                keeps it all synced across every LLM you connect.
              </p>
            </div>
          </div>
        </aside>

        <div className="lykn-wake-account-panel">
          {showSuccess ? (
            <div className="lykn-wake-account-success">
              <div className="lykn-wake-account-success-icon" aria-hidden>
                <svg
                  className="w-7 h-7 text-green-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.25}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h2 className="lykn-wake-account-title">Check your email</h2>
              <p className="lykn-wake-account-lede">
                We sent a confirmation link to{" "}
                <span className="text-white/80">{email}</span>. Click the link to
                activate your account.
              </p>
            </div>
          ) : (
            <>
              <header className="lykn-wake-account-header">
                <h2 className="lykn-wake-account-title">Create your account</h2>
                <p className="lykn-wake-account-lede">
                  Sign up with Google or email to get started.
                </p>
              </header>

              <button
                type="button"
                onClick={() =>
                  signInWithOAuth("google", {
                    redirectTo: `${window.location.origin}/start-trial`,
                  })
                }
                className="lykn-wake-account-google-btn"
              >
                <GoogleIcon />
                Continue with Google
              </button>

              <div className="lykn-wake-account-divider" aria-hidden>
                <span>or</span>
              </div>

              <form className="lykn-wake-account-form" onSubmit={handleSubmit}>
                <label className="lykn-wake-account-field">
                  <span className="lykn-wake-account-label">Full name</span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    placeholder="Your name"
                    className="lykn-wake-account-input"
                  />
                </label>

                <label className="lykn-wake-account-field">
                  <span className="lykn-wake-account-label">Email</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    placeholder="you@example.com"
                    className="lykn-wake-account-input"
                    required
                  />
                </label>

                <label className="lykn-wake-account-field">
                  <span className="lykn-wake-account-label">Password</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    placeholder="At least 6 characters"
                    className="lykn-wake-account-input"
                    required
                    minLength={6}
                  />
                </label>

                {displayError && (
                  <p className="lykn-wake-account-error" role="alert">
                    {displayError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="lykn-wake-account-submit-btn"
                >
                  {submitting ? "Creating account…" : "Create account"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
