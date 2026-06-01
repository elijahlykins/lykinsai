import { useAuth } from "@/lib/SupabaseAuth";

export default function SignInPill({ className = "" }) {
  const { user, signInWithOAuth, signOut } = useAuth();

  return (
    <button
      type="button"
      onClick={() => {
        if (user) {
          const ok = window.confirm("Sign out of your account?");
          if (ok) signOut();
        } else {
          signInWithOAuth("google", { redirectTo: window.location.href });
        }
      }}
      className={`flex items-center gap-1.5 rounded-full bg-white/45 dark:bg-[rgba(60,60,60,0.14)] backdrop-blur-sm border border-black/6 dark:border-white/10 pl-1 pr-3 py-1 text-[0.6875rem] text-black/70 dark:text-white/70 hover:bg-white/60 dark:hover:bg-white/15 shadow-sm transition-colors ${className}`}
      title={user ? "Sign out" : "Sign in"}
      aria-label={user ? "Sign out" : "Sign in"}
    >
      <div className="h-6 w-6 rounded-full bg-blue-500/15 dark:bg-blue-400/20 text-[0.6875rem] font-semibold text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">
        {user?.email ? user.email.charAt(0).toUpperCase() : "?"}
      </div>
      <span>{user ? "Signed in" : "Sign in"}</span>
    </button>
  );
}
