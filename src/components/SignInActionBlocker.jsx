import React from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useAuth } from "@/lib/SupabaseAuth";

export default function SignInActionBlocker({
  open = false,
  onClose,
  title = "Improve your LYKN experience",
  subtitle = "Sign in or sign up to continue",
}) {
  const nav = useNavigate();
  const { signInWithOAuth } = useAuth();

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[320] bg-[#f8f7f3] dark:bg-[#0f0f0f] overflow-y-auto">
      <button
        type="button"
        onClick={() => onClose?.()}
        className="absolute top-3 right-3 w-7 h-7 rounded-md inline-flex items-center justify-center text-black/45 dark:text-white/45 hover:text-black/70 dark:hover:text-white/75 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        aria-label="Close sign-in blocker"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="min-h-full w-full flex items-center justify-center px-6 py-10">
        <div className="w-full max-w-xs text-center">
          <p className="mb-2 text-[1.75rem] leading-tight font-medium text-black/90 dark:text-white/90">
            {title}
          </p>
          <h2 className="text-xs font-semibold tracking-[0.03em] text-black/45 dark:text-white/45">
            {subtitle}
          </h2>

          <div className="mt-5 space-y-2">
            <button
              type="button"
              onClick={() => signInWithOAuth("google")}
              className="w-full rounded-lg bg-[#1f1f1d] text-white px-4 py-2.5 text-sm font-semibold hover:bg-[#292926] transition-colors"
            >
              Continue with Google
            </button>
            <button
              type="button"
              onClick={() => nav("/login")}
              className="w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/70 dark:bg-white/5 text-black/70 dark:text-white/70 px-4 py-2.5 text-sm font-medium hover:bg-white dark:hover:bg-white/10 transition-colors"
            >
              Continue with email
            </button>
          </div>

          <button
            type="button"
            onClick={() => onClose?.()}
            className="mt-6 w-full rounded-lg px-4 py-2 text-sm text-black/55 dark:text-white/55 hover:bg-black/[0.03] dark:hover:bg-white/5 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
