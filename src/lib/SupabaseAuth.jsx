import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const AuthContext = createContext();

export function SupabaseAuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    let isMounted = true;

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!isMounted) return;

        if (session?.user) {
          setUser(session.user);
          return;
        }

        // On SIGNED_OUT or null-session events, attempt one recovery before
        // clearing the user — covers transient refresh failures and stale tabs.
        if (event === 'SIGNED_OUT' || event === 'TOKEN_REFRESHED') {
          try {
            const { data } = await supabase.auth.getSession();
            if (isMounted) setUser(data?.session?.user || null);
          } catch {
            if (isMounted) setUser(null);
          }
          return;
        }

        setUser(null);
      }
    );

    const initAuth = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const hash = window.location.hash;

        const errorParam = params.get('error');
        const errorDesc = params.get('error_description') || params.get('error_code');
        const hashParams = new URLSearchParams(hash.replace('#', ''));
        const hashError = hashParams.get('error');
        const hashErrorDesc = hashParams.get('error_description');

        if (errorParam || hashError) {
          const msg = errorDesc || hashErrorDesc || errorParam || hashError;
          if (isMounted) setAuthError(msg);
          window.history.replaceState({}, '', window.location.pathname);
        }

        const code = params.get('code');
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error && isMounted) {
            setAuthError("Sign-in failed. Please try again.");
          }
          window.history.replaceState({}, '', window.location.pathname);
        }

        if (hash && (hash.includes('access_token') || hash.includes('refresh_token'))) {
          await new Promise(r => setTimeout(r, 100));
        }

        let session = null;
        try {
          const { data } = await supabase.auth.getSession();
          session = data?.session;
        } catch {
          // Retry once after a short delay for transient network failures
          await new Promise(r => setTimeout(r, 500));
          try {
            const { data } = await supabase.auth.getSession();
            session = data?.session;
          } catch (retryErr) {
            console.error('Auth session recovery failed:', retryErr);
          }
        }

        if (isMounted) {
          setUser(session?.user || null);
        }
      } catch (err) {
        console.error('Auth initialization error:', err);
        if (isMounted) setUser(null);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    initAuth();

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signInWithOAuth = async (provider) => {
    setAuthError(null);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
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

  const signOut = () => supabase.auth.signOut({ scope: 'local' });

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