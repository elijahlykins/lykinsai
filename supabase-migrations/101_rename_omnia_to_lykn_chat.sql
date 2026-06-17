-- ============================================================================
-- Rename legacy "omnia"/"board" workspace tables to the LYKNChat naming
-- Migration: 101_rename_omnia_to_lykn_chat.sql
-- ============================================================================
--
-- The main chat workspace was historically called "omnia" / "board" / "grid".
-- It is now uniformly "LYKNChat". This migration renames the tables, the
-- board_id -> chat_id column, the orphaned share RPC, and the per-grid cap
-- functions/trigger to match.
--
-- COORDINATION: apply this BEFORE (or together with) deploying the code that
-- references the new names. Renames are OID-stable, so RLS policies, foreign
-- keys, triggers and indexes follow their table/column automatically; only
-- plpgsql function *bodies* that hardcode a table name are recreated below.
--
-- Idempotent + re-runnable: every step is guarded so re-applying is a no-op.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Tables
-- ----------------------------------------------------------------------------
ALTER TABLE IF EXISTS public.omnia_boards        RENAME TO lykn_chats;
ALTER TABLE IF EXISTS public.omnia_board_states  RENAME TO lykn_chat_states;
ALTER TABLE IF EXISTS public.omnia_projects      RENAME TO lykn_chat_projects;
ALTER TABLE IF EXISTS public.omnia_shared_boards RENAME TO lykn_chat_shares;

-- ----------------------------------------------------------------------------
-- 2) Column: board_id -> chat_id
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='lykn_chat_states' AND column_name='board_id') THEN
    ALTER TABLE public.lykn_chat_states RENAME COLUMN board_id TO chat_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='lykn_chat_shares' AND column_name='board_id') THEN
    ALTER TABLE public.lykn_chat_shares RENAME COLUMN board_id TO chat_id;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 3) Constraints + indexes (cosmetic — keep names aligned with new tables)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='omnia_board_states_board_id_unique') THEN
    ALTER TABLE public.lykn_chat_states RENAME CONSTRAINT omnia_board_states_board_id_unique TO lykn_chat_states_chat_id_unique;
  END IF;
END $$;

ALTER INDEX IF EXISTS public.idx_omnia_boards_user_id        RENAME TO idx_lykn_chats_user_id;
ALTER INDEX IF EXISTS public.idx_omnia_board_states_board_id RENAME TO idx_lykn_chat_states_chat_id;
ALTER INDEX IF EXISTS public.idx_omnia_projects_user_id      RENAME TO idx_lykn_chat_projects_user_id;
ALTER INDEX IF EXISTS public.idx_omnia_boards_project_id     RENAME TO idx_lykn_chats_project_id;
ALTER INDEX IF EXISTS public.idx_omnia_shared_boards_token   RENAME TO idx_lykn_chat_shares_token;
ALTER INDEX IF EXISTS public.idx_omnia_shared_boards_board   RENAME TO idx_lykn_chat_shares_chat;
ALTER INDEX IF EXISTS public.idx_omnia_shared_boards_owner   RENAME TO idx_lykn_chat_shares_owner;

-- ----------------------------------------------------------------------------
-- 4) Per-grid cap functions + trigger -> per-chat (identifiers only).
--    The RAISE EXCEPTION message ('blocks_per_grid_cap_reached') is left
--    unchanged because the client parses that exact string.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='blocks_per_grid_cap') THEN
    ALTER FUNCTION public.blocks_per_grid_cap(text) RENAME TO blocks_per_chat_cap;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='enforce_blocks_per_grid_cap') THEN
    ALTER FUNCTION public.enforce_blocks_per_grid_cap() RENAME TO enforce_blocks_per_chat_cap;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_board_states_blocks_cap') THEN
    ALTER TRIGGER trg_board_states_blocks_cap ON public.lykn_chat_states RENAME TO trg_chat_states_blocks_cap;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 5) Shared-chat view-counter RPC: recreate under the new name (its body
--    hardcodes the table name) and drop the old one.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lykn_chat_share_record_view(p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.lykn_chat_shares
     SET view_count     = view_count + 1,
         last_viewed_at = NOW()
   WHERE token          = p_token
     AND revoked_at     IS NULL
     AND (expires_at IS NULL OR expires_at > NOW());
END;
$$;

REVOKE ALL ON FUNCTION public.lykn_chat_share_record_view(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lykn_chat_share_record_view(TEXT) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.omnia_shared_board_record_view(TEXT);

NOTIFY pgrst, 'reload schema';

COMMIT;
