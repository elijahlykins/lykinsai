import { createContext } from 'react';

// Lives in its own module so Vite's React Fast Refresh treats it as
// data (not a component) and never re-evaluates it during HMR. If
// `createContext()` were called inline in SupabaseAuth.jsx alongside
// the `useAuth` hook export, every edit to that file would mint a
// brand-new context object — the already-mounted `SupabaseAuthProvider`
// would keep publishing into the OLD context while consumers would read
// from the NEW one, and every `useAuth()` call would throw
// "useAuth must be used within SupabaseAuthProvider" until a hard reload.
export const AuthContext = createContext(null);
