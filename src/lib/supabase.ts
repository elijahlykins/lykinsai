// src/lib/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ✅ Vite uses import.meta.env (NOT process.env)
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// 🔥 Make this more graceful - don't throw, but create a dummy client
// This allows the app to load even if env vars are missing
let supabase: SupabaseClient<any>;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Missing Supabase env vars. Create .env file in project root with VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY');
  // Create a dummy client to prevent crashes
  supabase = createClient('https://placeholder.supabase.co', 'placeholder-key');
} else {
  supabase = createClient(supabaseUrl, supabaseAnonKey);
}

export { supabase };