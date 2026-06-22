-- 108_voice_screen_context.sql
--
-- Voice Mode "sees your screen" support for the desktop overlay.
--
-- The Electron overlay captures + describes the user's current screen and pushes
-- that text to the server during a live voice session. The ElevenLabs custom-LLM
-- then injects it into each turn's grounding so voice can answer questions about
-- what's on screen — the same ability the typed overlay chat has.
--
-- Why a table (not just in-memory): the backend runs multiple instances on
-- Render, so the overlay's screen push and ElevenLabs' custom-LLM request often
-- land on different instances. An in-memory Map is per-instance and gets lost;
-- a single-row-per-user table is shared across all instances.
--
-- Only the server (service_role) reads/writes this; RLS is enabled with no
-- policies so it's inaccessible to anon/authenticated clients. Transient data —
-- the latest screen replaces the previous one and is only used within ~60s.
--
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS public.voice_screen_context (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  description text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.voice_screen_context ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.voice_screen_context TO service_role;

COMMENT ON TABLE public.voice_screen_context IS
  'Latest screen description pushed by the desktop overlay during a live voice session, one row per user. Server-only (service_role); read by the ElevenLabs custom-LLM to ground voice answers in the user''s current screen. Transient (~60s freshness).';

NOTIFY pgrst, 'reload schema';
