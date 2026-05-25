import { useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { clearPrototypeState } from '@/lib/prototypeHandoff';
import { AuthContext } from '@/lib/authContext';

export function SupabaseAuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);
  const signOutTimerRef = useRef(null);
  const recoveryInFlightRef = useRef(false);

  useEffect(() => {
    let isMounted = true;

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
      if (isMounted && loading) {
        if (import.meta.env.DEV) console.warn('[Auth] Safety timeout — forcing loading=false');
        setLoading(false);
      }
    }, 10_000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!isMounted) return;

        if (import.meta.env.DEV) {
          console.log('[Auth]', event, session?.user?.email ?? '(no user)');
        }

        // INITIAL_SESSION fires once when the listener is registered.
        // With detectSessionInUrl:true the client will have already exchanged
        // any ?code= from an OAuth return, so the session is ready here.
        if (event === 'INITIAL_SESSION') {
          setUser(session?.user ?? null);
          setLoading(false);
          return;
        }

        if (session?.user) {
          if (signOutTimerRef.current) {
            clearTimeout(signOutTimerRef.current);
            signOutTimerRef.current = null;
          }
          setUser(session.user);
          return;
        }

        // Explicit sign-out should update UI immediately.
        if (event === 'SIGNED_OUT') {
          if (signOutTimerRef.current) {
            clearTimeout(signOutTimerRef.current);
            signOutTimerRef.current = null;
          }
          setUser(null);
          return;
        }

        // Debounce fallback for refresh edge-cases: wait 1.5s before
        // clearing the user to avoid cascading logouts from transient
        // token-refresh failures. If a valid session arrives in the meantime
        // the timer is cancelled above.
        if (event === 'TOKEN_REFRESHED') {
          if (recoveryInFlightRef.current) return;
          recoveryInFlightRef.current = true;

          try {
            const { data } = await supabase.auth.getSession();
            if (!isMounted) return;
            if (data?.session?.user) {
              setUser(data.session.user);
              return;
            }
          } catch { /* fall through to debounced sign-out */ }
          finally { recoveryInFlightRef.current = false; }

          if (!signOutTimerRef.current) {
            signOutTimerRef.current = setTimeout(() => {
              signOutTimerRef.current = null;
              if (isMounted) setUser(null);
            }, 1500);
          }
          return;
        }

        setUser(null);
      }
    );

    return () => {
      isMounted = false;
      clearTimeout(safetyTimeout);
      subscription.unsubscribe();
      if (signOutTimerRef.current) clearTimeout(signOutTimerRef.current);
    };
  }, []);

  const signInWithOAuth = async (provider, opts = {}) => {
    setAuthError(null);
    // Default redirect is the app root; callers (e.g. the OAuth consent
    // page) can override with `{ redirectTo: window.location.href }` to
    // preserve their query string across the Supabase OAuth round-trip.
    const redirectTo = opts.redirectTo || window.location.origin;
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo },
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

  const signUpWithEmail = async (email, password, { name } = {}) => {
    setAuthError(null);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
        ...(name ? { data: { full_name: name } } : {}),
      },
    });
    if (error) throw error;
    if (import.meta.env.DEV) {
      console.log('[signUp response]', JSON.stringify({
        hasUser: !!data?.user,
        hasSession: !!data?.session,
        identities: data?.user?.identities?.length ?? 'none',
        confirmed: data?.user?.email_confirmed_at || data?.user?.confirmed_at || null,
      }));
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
  const signOut = async ({ everywhere = false } = {}) => {
    if (signOutTimerRef.current) {
      clearTimeout(signOutTimerRef.current);
      signOutTimerRef.current = null;
    }
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

    // Hard reload to `/` so every store, query cache, and in-memory piece
    // of user state is dropped on the floor. The LandingPrototype route
    // is gated by `<GuestOnly>` so a logged-out visitor reliably lands
    // there. SSR / test guard: only call when window exists.
    if (typeof window !== 'undefined') {
      window.location.assign('/');
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      loading,
      authError,
      signInWithOAuth,
      signInWithEmail,
      signUpWithEmail,
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