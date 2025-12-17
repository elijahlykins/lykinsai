import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

const AuthContext = createContext();

export function SupabaseAuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Get initial session
    const getSession = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) {
          console.warn('Supabase session error:', error);
          setUser(null);
        } else {
          setUser(session?.user || null);
        }
      } catch (error) {
        console.warn('Failed to get Supabase session:', error);
        setUser(null);
      } finally {
        setLoading(false);
      }
    };
    getSession();

    // Listen for auth changes
    let subscription;
    try {
      // Check if we're using the placeholder client (won't have proper auth)
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      if (!supabaseUrl || supabaseUrl.includes('placeholder')) {
        // Skip auth state listener for placeholder client
        console.warn('⚠️ Using placeholder Supabase client, skipping auth state listener');
      } else {
        const result = supabase.auth.onAuthStateChange(
          (_event, session) => {
            setUser(session?.user || null);
          }
        );
        
        // Handle different return structures from Supabase
        // Some versions return { data: { subscription } }, others return the subscription directly
        if (result && typeof result === 'object') {
          if (result.data && result.data.subscription) {
            subscription = result.data.subscription;
          } else if (result.subscription) {
            subscription = result.subscription;
          } else if (typeof result.unsubscribe === 'function') {
            subscription = result;
          }
        }
      }
    } catch (error) {
      console.warn('Failed to set up auth state listener:', error);
    }

    return () => {
      if (subscription && typeof subscription.unsubscribe === 'function') {
        try {
          subscription.unsubscribe();
        } catch (error) {
          console.warn('Error unsubscribing from auth state:', error);
        }
      }
    };
  }, []);

  const signInWithOAuth = (provider) => {
    return supabase.auth.signInWithOAuth({ 
      provider,
      options: { redirectTo: window.location.origin }
    });
  };

  const signInWithEmail = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signUpWithEmail = async (email, password) => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  };

  const signOut = () => supabase.auth.signOut();

  return (
    <AuthContext.Provider value={{ 
      user, 
      loading, 
      signInWithOAuth, 
      signInWithEmail, 
      signUpWithEmail, 
      signOut 
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