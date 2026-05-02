-- ============================================
-- Add `metadata` JSONB to oauth_states
-- Migration: 038_oauth_states_metadata.sql
-- ============================================
-- Per-instance OAuth providers (Mastodon, future Lemmy/Misskey, etc.)
-- need to persist context across the authorization round trip:
--
--   • The instance's base URL (e.g. "https://mastodon.social")
--   • The dynamically-registered client_id and client_secret for that
--     instance (Mastodon's POST /api/v1/apps issues fresh creds per app
--     per instance — they aren't part of process.env)
--
-- Stored on the oauth_states row that's created in the /start endpoint
-- and consumed (and deleted) in the /oauth/callback handler. Same TTL,
-- same RLS posture as the rest of the row.
--
-- Adapters that don't need per-flow context simply leave this NULL.

ALTER TABLE oauth_states
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
