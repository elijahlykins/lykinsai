-- =====================================================================
-- 060 — lykn_user_preferences: per-user app preferences
-- =====================================================================
-- Until now, app preferences (theme, appearance, AI model, etc.) lived
-- only in the browser's localStorage under `lykinsai_settings`. That
-- works for visual state, but doesn't fit anything that needs to be
-- honoured by the server (e.g. "pause memory extraction", "exclude
-- this user from model training", "auto-delete chats after N days").
--
-- This migration introduces a single per-user row keyed by auth.uid()
-- that holds *server-relevant* preferences. The shape is split into
-- discrete columns for the toggles the synthesis pipeline reads on
-- every run (cheap to check, no JSON parsing needed in hot path) plus
-- a `metadata` JSONB for forward-compatible additions that don't
-- warrant a column each.
--
-- Why not stuff everything into `auth.users.raw_user_meta_data`?
--   • raw_user_meta_data is user-writable from the client; we want
--     server-authoritative privacy state.
--   • Querying jsonb across all users (e.g. "find everyone who paused
--     memory") is awkward; columns + indexes are cleaner.
--   • The synthesis cron needs a fast `WHERE NOT memory_paused` filter.
--
-- The row is created lazily on first GET/PATCH from the client. The
-- `handle_new_user_preferences` trigger seeds defaults at signup so
-- the cron job can JOIN unconditionally without LEFT JOIN gymnastics.

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lykn_user_preferences (
  user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Pause memory extraction. When true, the nightly synthesis job and
  -- the on-demand learn-now path both skip this user. Honoured in
  -- server.js (`/api/synthesis/profile/learn-now`) and the cron entry
  -- (`jobs/synthesisJob.js`).
  memory_paused           boolean NOT NULL DEFAULT false,

  -- Opt out of having anonymised chats contribute to model improvement.
  -- Read by any future training export. Default false (opted in) to
  -- match the privacy policy + signup flow.
  training_opt_out        boolean NOT NULL DEFAULT false,

  -- Auto-delete chats older than N days. NULL = keep forever. The
  -- nightly job runs the purge with a 1-day grace window so a UI
  -- toggle off doesn't immediately destroy data.
  chat_retention_days     integer
    CHECK (chat_retention_days IS NULL OR chat_retention_days BETWEEN 1 AND 3650),

  -- Show belief/fact provenance citations by default in chat UI.
  show_provenance         boolean NOT NULL DEFAULT true,

  -- Send product update emails (security + billing are always sent
  -- regardless and aren't governed here).
  email_product_updates   boolean NOT NULL DEFAULT true,

  -- Send a summary email when a nightly synthesis run completes with
  -- substantial new facts or concepts.
  email_synthesis_digest  boolean NOT NULL DEFAULT false,

  -- Forward-compat bucket for less-critical preferences that don't
  -- justify a column (e.g. tutorial dismissals, beta flag opt-ins).
  metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.lykn_user_preferences IS
  'Per-user app preferences that must be honoured server-side (privacy, retention, notifications). Visual-only preferences (theme, density) remain in browser localStorage.';

-- ---------------------------------------------------------------------
-- 2. updated_at trigger
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_lykn_user_preferences_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lykn_user_preferences_touch ON public.lykn_user_preferences;
CREATE TRIGGER trg_lykn_user_preferences_touch
  BEFORE UPDATE ON public.lykn_user_preferences
  FOR EACH ROW EXECUTE FUNCTION public.touch_lykn_user_preferences_updated_at();

-- ---------------------------------------------------------------------
-- 3. Row-level security
-- ---------------------------------------------------------------------
-- Each user owns exactly one row keyed by their auth.uid(). The
-- service role (cron, admin endpoints) bypasses RLS as usual.
ALTER TABLE public.lykn_user_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own preferences" ON public.lykn_user_preferences;
CREATE POLICY "Users read own preferences"
  ON public.lykn_user_preferences
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own preferences" ON public.lykn_user_preferences;
CREATE POLICY "Users insert own preferences"
  ON public.lykn_user_preferences
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own preferences" ON public.lykn_user_preferences;
CREATE POLICY "Users update own preferences"
  ON public.lykn_user_preferences
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- No DELETE policy — preferences die with the user (FK ON DELETE CASCADE).

-- ---------------------------------------------------------------------
-- 4. Backfill: seed a default row for every existing user
-- ---------------------------------------------------------------------
-- Idempotent: the PRIMARY KEY conflict short-circuits re-inserts on
-- repeat migration runs.
INSERT INTO public.lykn_user_preferences (user_id)
SELECT id FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 5. New-user trigger — seed defaults on signup
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user_preferences()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.lykn_user_preferences (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auth_user_created_seed_preferences ON auth.users;
CREATE TRIGGER trg_auth_user_created_seed_preferences
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_preferences();
