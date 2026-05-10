-- =====================================================================
-- 048 — Synthesis layer realtime: publication + replica identity
-- =====================================================================
-- Purpose: enable Supabase Realtime for the three tables the Synthesis
-- Layer's 3D graph reads (`lykn_user_model_facts`, `lykn_beliefs`,
-- `lykn_project_state`). Without this, Realtime subscriptions return
-- ok=true on the client but never emit `postgres_changes` events for
-- INSERT/UPDATE on these tables — silent failure mode that's painful
-- to debug after the fact.
--
-- Two changes per table:
--
--   1. ALTER PUBLICATION supabase_realtime ADD TABLE …
--      Adds the table to the publication that Postgres' logical
--      decoder streams to Supabase Realtime. Custom tables created
--      outside the Supabase dashboard are NOT auto-added; this is the
--      one-time opt-in.
--
--   2. ALTER TABLE … REPLICA IDENTITY FULL
--      Default REPLICA IDENTITY only ships the primary key on UPDATE/
--      DELETE events. Realtime filters like `user_id=eq.<uuid>` need
--      the full OLD row to evaluate against, so without FULL the
--      filtered UPDATE handlers silently drop every event from users
--      other than the row's owner — but since the filter compares
--      against a NULL user_id (the missing column), it ALSO drops the
--      legitimate ones. FULL fixes both.
--
-- All three statements are idempotent under the IF NOT EXISTS / NOT
-- already added guards — re-running this migration is safe.
--
-- RLS guarantee: SELECT policies on all three tables already key off
-- `auth.uid() = user_id`, which Realtime evaluates server-side before
-- delivery, so users still only receive events for rows they own.
-- See migrations 039, 043, 045 for the policy bodies.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Add tables to the supabase_realtime publication
-- ---------------------------------------------------------------------
-- ALTER PUBLICATION … ADD TABLE has no IF NOT EXISTS clause in
-- Postgres, so we wrap each in a DO block that checks
-- pg_publication_tables first. Lets the migration re-run cleanly
-- (or be skipped no-op if the dashboard already added one of these).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_user_model_facts'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_user_model_facts';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_beliefs'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_beliefs';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_project_state'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_project_state';
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2. REPLICA IDENTITY FULL — required for filtered UPDATE events
-- ---------------------------------------------------------------------
-- Idempotent at the SQL level: ALTER TABLE … REPLICA IDENTITY FULL
-- is a no-op if already FULL. We still re-issue it so a future
-- accidental "REPLICA IDENTITY DEFAULT" gets corrected on next deploy.

ALTER TABLE public.lykn_user_model_facts REPLICA IDENTITY FULL;
ALTER TABLE public.lykn_beliefs           REPLICA IDENTITY FULL;
ALTER TABLE public.lykn_project_state     REPLICA IDENTITY FULL;

-- ---------------------------------------------------------------------
-- 3. Sanity comment so other tools/agents see this is wired
-- ---------------------------------------------------------------------

COMMENT ON TABLE public.lykn_user_model_facts IS
  'User model atomic facts. Realtime-enabled (publication + REPLICA IDENTITY FULL) so the Synthesis Layer 3D graph re-fetches when any AI client writes a fact. See migration 048.';
COMMENT ON TABLE public.lykn_beliefs IS
  'User-ratified beliefs (promoted from facts). Realtime-enabled so the Synthesis Layer reflects new proposals + activations live. See migration 048.';
COMMENT ON TABLE public.lykn_project_state IS
  'Project working state — every state_key + value, append-only with supersession. Realtime-enabled so the updates panel reflects cross-AI-client pushes immediately. See migration 048.';
