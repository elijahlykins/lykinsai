import { useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { clearPrototypeState } from '@/lib/landingHandoff';
import { AuthContext } from '@/lib/authContext';
import {
  startVaultDescriptionBackfill,
  resetVaultDescriptionBackfill,
} from '@/lib/vault/backfillDescriptions';
import { acceptProjectInvites } from '@/lib/projectMembers';
import { PROJECTS_CHANGED_EVENT } from '@/lib/synthesis/projectLiveSync';

// Lazily fill in missing vault descriptions once the user is signed in, so the
// assistant's vault search has a description on every item to match against.
// Deferred + self-throttled inside the driver; only runs once per session.
function kickoffVaultBackfill() {
  setTimeout(() => {
    try {
      startVaultDescriptionBackfill();
    } catch {
      /* fire-and-forget */
    }
  }, 8000);
}

// Claim any project invites sent to this user's email (lykn_project_members,
// 109). Runs once per fresh sign-in; if any pending invites convert to
// membership, nudge the projects views to refetch so the shared project shows.
function kickoffInviteAcceptance(userId) {
  if (!userId) return;
  setTimeout(async () => {
    try {
      const claimed = await acceptProjectInvites(userId);
      if (claimed > 0 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
      }
    } catch {
      /* fire-and-forget */
    }
  }, 2000);
}

export function SupabaseAuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  // True from the moment signOut() is invoked until the hard reload lands.
  // While this is set, ProtectedRoute renders blank instead of bouncing to
  // /login, so the legacy login page never flashes before the walkthrough.
  const [signingOut, setSigningOut] = useState(false);
  const signOutTimerRef = useRef(null);
  const userRef = useRef(null);

  useEffect(() => {
    let isMounted = true;
    /** @type {import('@supabase/supabase-js').Subscription | null} */
    let subscription = null;

    // Surface any OAuth error params from the redirect URL
    const params = new URLSearchParams(window.location.search);
    const hash = window.location.hash;
    const errorParam = params.get('error');
    const errorDesc = params.get('error_description') || params.get('error_code');
    const hashParams = new URLSearchParams(hash.replace('#', ''));
    const hashError = hashParams.get('error');
    const hashErrorDesc = hashParams.get('error_description');

    if (errorParam || hashError) {
      if (import.meta.env.DEV) console.error('[Auth] OAuth error:', errorDesc || hashErrorDesc || errorParam || hashError);
      setAuthError("Sign-in failed. Please try again.");
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Safety net: never let the loading screen persist indefinitely.
    // The Supabase client fires INITIAL_SESSION within a few seconds at most;
    // if it hasn't arrived by 10s something went wrong.
    const safetyTimeout = setTimeout(() => {
      if (isMounted) {
        if (import.meta.env.DEV) console.warn('[Auth] Safety timeout — forcing loading=false');
        setLoading(false);
      }
    }, 10_000);

    const cancelSignOutTimer = () => {
      if (signOutTimerRef.current) {
        clearTimeout(signOutTimerRef.current);
        signOutTimerRef.current = null;
      }
    };

    // Debounce-clear guest state only — never wipe an established session on
    // ambiguous null-session events (those caused login loops after sign-in).
    const scheduleGuestClear = () => {
      if (userRef.current || signOutTimerRef.current) return;
      signOutTimerRef.current = setTimeout(() => {
        signOutTimerRef.current = null;
        if (isMounted && !userRef.current) {
          setUser(null);
        }
      }, 1500);
    };

    const applySession = (session) => {
      if (session?.user) {
        cancelSignOutTimer();
        const wasSignedOut = !userRef.current;
        userRef.current = session.user;
        setUser(session.user);
        if (wasSignedOut) {
          kickoffVaultBackfill();
          kickoffInviteAcceptance(session.user.id);
        }
        return true;
      }
      return false;
    };

    // Sync handler only — never call supabase.auth.* inside this callback;
    // async auth calls here deadlock the client's session lock and can
    // trigger TOKEN_REFRESHED → SIGNED_OUT loops (supabase/auth-js#762).
    const handleAuthChange = (event, session) => {
      if (!isMounted) return;

      if (import.meta.env.DEV) {
        console.log('[Auth]', event, session?.user?.email ?? '(no user)');
      }

      // INITIAL_SESSION fires once when the listener is registered.
      // With detectSessionInUrl:true the client will have already exchanged
      // any ?code= from an OAuth return, so the session is ready here.
      if (event === 'INITIAL_SESSION') {
        const nextUser = session?.user ?? null;
        userRef.current = nextUser;
        setUser(nextUser);
        setLoading(false);
        if (nextUser) {
          kickoffVaultBackfill();
          kickoffInviteAcceptance(nextUser.id);
        }
        return;
      }

      if (applySession(session)) {
        return;
      }

      // Explicit sign-out should update UI immediately.
      if (event === 'SIGNED_OUT') {
        cancelSignOutTimer();
        userRef.current = null;
        setUser(null);
        resetVaultDescriptionBackfill();
        return;
      }

      // TOKEN_REFRESHED / other null-session events: keep an established
      // session in this tab; only debounce-clear when we never signed in.
      scheduleGuestClear();
    };

    // Let _initialize finish before subscribing so the listener can't race
    // token refresh on load (supabase/supabase-js#2344).
    void (async () => {
      try {
        await supabase.auth.getSession();
      } catch {
        /* init may still proceed */
      }
      if (!isMounted) return;

      const { data: { subscription: sub } } = supabase.auth.onAuthStateChange(handleAuthChange);
      subscription = sub;
    })();

    return () => {
      isMounted = false;
      clearTimeout(safetyTimeout);
      subscription?.unsubscribe();
      cancelSignOutTimer();
    };
  }, []);

  // Desktop-shell sign-in hand-off: Google OAuth runs in the user's real
  // browser (Google blocks embedded browsers) and the finished Supabase
  // session comes back through the lykn://auth deep link → main process →
  // preload bridge. setSession() persists it and fires SIGNED_IN, which the
  // regular onAuthStateChange handler above turns into UI state.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const bridge = window.lykn;
    if (!bridge?.desktop || typeof bridge.onAuthTokens !== 'function') return;
    bridge.onAuthTokens(async (tokens) => {
      const access_token = tokens?.access_token;
      const refresh_token = tokens?.refresh_token;
      if (!access_token || !refresh_token) return;
      try {
        const { error } = await supabase.auth.setSession({ access_token, refresh_token });
        if (error) throw error;
        setAuthError(null);
      } catch (err) {
        if (import.meta.env.DEV) console.error('[Auth] desktop token hand-off failed:', err);
        setAuthError('Sign-in failed. Please try again.');
      }
    });
  }, []);

  const signInWithOAuth = async (provider, opts = {}) => {
    setAuthError(null);
    // Inside the desktop shell, Google OAuth cannot run in-window — Google
    // rejects embedded browsers ("This browser or app may not be secure").
    // Hand the whole round-trip to the user's real browser via /desktop-auth,
    // which deep-links the finished session back into the app (lykn://auth →
    // main process → the onAuthTokens/setSession effect above).
    if (
      provider === 'google' &&
      typeof window !== 'undefined' &&
      window.lykn?.desktop &&
      typeof window.lykn.openExternal === 'function'
    ) {
      window.lykn.openExternal(`${window.location.origin}/desktop-auth`);
      return { data: null, error: null };
    }
    // Default redirect is the current URL so mid-walkthrough sign-in on
    // /vault or /connections returns to the same surface instead of `/`
    // (which used to bounce guests through GuestOnly → /app and strand
    // them off the vault/connections beat they were on). Callers can
    // still override — e.g. OAuth consent passes an explicit return URL.
    const redirectTo =
      opts.redirectTo ||
      (typeof window !== 'undefined' ? window.location.href : window.location?.origin ?? '');
    // Forward queryParams (e.g. prompt=select_account) so account-switch
    // flows actually reach Google — dropping them made SSO silently reuse
    // the previous Google account until a second attempt.
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        ...(opts.queryParams ? { queryParams: opts.queryParams } : {}),
        ...(opts.scopes ? { scopes: opts.scopes } : {}),
      },
    });
    if (error) {
      setAuthError("Sign-in failed. Please try again later.");
    }
    return { data, error };
  };

  const signInWithEmail = async (email, password) => {
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  // Password signup goes through our API so we can email a 6-digit code
  // (5-minute TTL) instead of Supabase's confirmation link. The user then
  // pastes the code on /login; verifySignupEmailCode confirms the auth user
  // and the client signs in with the password still held in form state.
  const signUpWithEmail = async (email, password, { name } = {}) => {
    setAuthError(null);
    const { API_BASE_URL } = await import("@/lib/api-config");
    const res = await fetch(`${API_BASE_URL}/api/auth/signup-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: String(email || "").trim(),
        password: String(password || ""),
        ...(name ? { name: String(name).trim() } : {}),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Could not create account.");
    }
    return data;
  };

  const verifySignupEmailCode = async (email, code) => {
    setAuthError(null);
    const { API_BASE_URL } = await import("@/lib/api-config");
    const res = await fetch(`${API_BASE_URL}/api/auth/signup-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: String(email || "").trim(),
        code: String(code || "").trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Could not verify code.");
    }
    return data;
  };

  // Password reset goes through our API so we can email a branded 6-digit
  // code via Resend instead of Supabase's generic recovery link (which Gmail
  // often flags). confirmPasswordReset updates the password server-side;
  // the client then signs in with the new password. Also works for
  // Google-only accounts — setting a password adds an email/password identity.
  const resetPasswordForEmail = async (email) => {
    setAuthError(null);
    const { API_BASE_URL } = await import("@/lib/api-config");
    const res = await fetch(`${API_BASE_URL}/api/auth/password-reset-start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(email || "").trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Could not start password reset.");
    }
    return data;
  };

  const confirmPasswordReset = async (email, code, password) => {
    setAuthError(null);
    const { API_BASE_URL } = await import("@/lib/api-config");
    const res = await fetch(`${API_BASE_URL}/api/auth/password-reset-confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: String(email || "").trim(),
        code: String(code || "").trim(),
        password: String(password || ""),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Could not reset password.");
    }
    return data;
  };

  // Re-send a fresh 5-minute signup code.
  const resendSignupEmail = async (email) => {
    setAuthError(null);
    const { API_BASE_URL } = await import("@/lib/api-config");
    const res = await fetch(`${API_BASE_URL}/api/auth/signup-resend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: String(email || "").trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error || "Could not resend code.");
    }
    return data;
  };

  // `everywhere: false` (default) — revoke just this device's refresh
  // token. The in-flight access token stays valid until its natural
  // ~1h TTL on Supabase. Matches the user's mental model of "sign out
  // on my phone shouldn't kill my desktop session".
  //
  // `everywhere: true` — pass scope:'global' so Supabase revokes every
  // refresh token tied to this user across all devices. Use this when
  // the user suspects their account is compromised. Future Settings UI
  // will surface a "Sign out everywhere" button that calls this with
  // `{ everywhere: true }`; that button is intentionally not added in
  // this pass — the capability is exposed first, the UI lands later.
  // `redirectTo` — where the hard reload lands after cleanup. Defaults to `/`
  // (the guest landing); pass '/login' for switch-account flows so callers
  // don't reimplement sign-out (and skip clearPrototypeState) just to change
  // the destination.
  const signOut = async ({ everywhere = false, redirectTo = '/' } = {}) => {
    if (signOutTimerRef.current) {
      clearTimeout(signOutTimerRef.current);
      signOutTimerRef.current = null;
    }
    // Mark the transition first so the SIGNED_OUT event below (and the manual
    // clear) don't cause ProtectedRoute to flash the legacy /login page while
    // we wait for the hard reload to `/`.
    setSigningOut(true);
    userRef.current = null;
    setUser(null);

    // Awaiting the supabase call ensures the auth tokens are cleared from
    // localStorage *before* the hard reload below — otherwise the new page
    // load can rehydrate the old session and momentarily look signed-in.
    try {
      await supabase.auth.signOut({ scope: everywhere ? 'global' : 'local' });
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[Auth] signOut error:', err);
    }

    // "Start from the beginning": wipe the prototype walkthrough storage
    // so the next page load is indistinguishable from a fresh visitor —
    // empty Synthesis Layer, no half-finished neuron list, walkthrough
    // step pointer reset.
    clearPrototypeState();

    // Hard reload so every store, query cache, and in-memory piece of user
    // state is dropped on the floor. The default `/` is gated by
    // `<GuestOnly>` so a logged-out visitor reliably lands on the guest
    // landing. SSR / test guard: only call when window exists.
    if (typeof window !== 'undefined') {
      window.location.assign(redirectTo);
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      signingOut,
      authError,
      signInWithOAuth,
      signInWithEmail,
      signUpWithEmail,
      verifySignupEmailCode,
      resetPasswordForEmail,
      confirmPasswordReset,
      resendSignupEmail,
      signOut,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within SupabaseAuthProvider');
  }
  return context;
};