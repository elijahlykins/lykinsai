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
      (_event, session) => {
        if (isMounted) {
          setUser(session?.user || null);
        }
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
            setAuthError(error.message);
          }
          window.history.replaceState({}, '', window.location.pathname);
        }

        if (hash && (hash.includes('access_token') || hash.includes('refresh_token'))) {
          await new Promise(r => setTimeout(r, 100));
        }

        const { data: { session } } = await supabase.auth.getSession();
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
      setAuthError(error.message);
    }
    return { data, error };
  };

  const signInWithEmail = async (email, password) => {
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signUpWithEmail = async (email, password) => {
    setAuthError(null);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });
    if (error) throw error;
    return data;
  };

  const signOut = () => supabase.auth.signOut();

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