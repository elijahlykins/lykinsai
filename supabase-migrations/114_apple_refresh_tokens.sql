-- 114: Store Apple refresh tokens so account deletion can revoke Sign in
-- with Apple, as App Review requires (developer.apple.com/support/
-- offering-account-deletion-in-your-app/).
--
-- The iOS app performs native SIWA (signInWithIdToken → Supabase), which
-- never gives the server an Apple refresh token. POST /api/auth/apple/
-- token-exchange (server.js) exchanges the sign-in authorizationCode within
-- Apple's 10-minute window and upserts the refresh token here; DELETE
-- /api/account reads it back and calls appleid.apple.com/auth/revoke.
--
-- Revoking also resets Apple's "returning user" state, so a user who
-- deletes their account and signs up again is treated as new and re-shares
-- email/name — without this, AppleSignIn.swift receives nil for both and
-- the fresh Supabase identity is created blank.

CREATE TABLE IF NOT EXISTS public.lykn_apple_tokens (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  refresh_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Service-role only: RLS enabled with no policies means anon/authenticated
-- clients can never read these tokens; only server.js (service role) can.
ALTER TABLE public.lykn_apple_tokens ENABLE ROW LEVEL SECURITY;
