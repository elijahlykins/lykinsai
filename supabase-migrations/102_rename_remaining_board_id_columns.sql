-- ============================================================================
-- Rename remaining board_id columns -> chat_id + recreate dependent functions
-- Migration: 102_rename_remaining_board_id_columns.sql
-- ============================================================================
--
-- Follow-up to 101. The chat surface (omnia_boards -> lykn_chats) is FK'd from
-- several other tables via a `board_id` column. This finishes the rename so the
-- whole schema uses `chat_id`:
--   • sessions.board_id              -> chat_id   (usage tracking)
--   • concept_chats.board_id         -> chat_id   (synthesis concept links)
--   • lykn_sub_model_tasks.board_id  -> chat_id   (sub-model task runs)
--   • message_feedback.board_id      -> chat_id   (per-message thumbs)
--
-- It then recreates the SQL/plpgsql functions whose *bodies* hardcoded the old
-- table/column names. Postgres stores function bodies as text and does NOT
-- rewrite them on RENAME, so without this they would error at call time:
--   • recompute_synthesis_neuron_count_from_tables  (referenced omnia_boards)
--   • concept_links                                 (omnia_boards + board_id)
--   • concept_links_for_user                        (concept_chats.board_id)
--   • merge_concepts                                (concept_chats.board_id)
--
-- COORDINATION: apply this AFTER 101 (it depends on lykn_chats existing).
-- Idempotent + re-runnable.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) Column renames: board_id -> chat_id
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='sessions' AND column_name='board_id') THEN
    ALTER TABLE public.sessions RENAME COLUMN board_id TO chat_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='concept_chats' AND column_name='board_id') THEN
    ALTER TABLE public.concept_chats RENAME COLUMN board_id TO chat_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='lykn_sub_model_tasks' AND column_name='board_id') THEN
    ALTER TABLE public.lykn_sub_model_tasks RENAME COLUMN board_id TO chat_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='message_feedback' AND column_name='board_id') THEN
    ALTER TABLE public.message_feedback RENAME COLUMN board_id TO chat_id;
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 2) Index renames (cosmetic — the unique constraint / partial predicate follow
--    the column automatically; only the object names lag).
-- ----------------------------------------------------------------------------
ALTER INDEX IF EXISTS public.idx_concept_chats_board        RENAME TO idx_concept_chats_chat;
ALTER INDEX IF EXISTS public.lykn_sub_model_tasks_board_idx RENAME TO lykn_sub_model_tasks_chat_idx;

-- ----------------------------------------------------------------------------
-- 3) Recreate functions whose bodies referenced the old names.
--    Bodies are otherwise identical to 058 / 061 / 072.
-- ----------------------------------------------------------------------------

-- 3a) recompute_synthesis_neuron_count_from_tables (072): omnia_boards -> lykn_chats
CREATE OR REPLACE FUNCTION public.recompute_synthesis_neuron_count_from_tables(p_user uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    COALESCE((SELECT count(*)::int FROM public.lykn_chats           WHERE user_id = p_user), 0)
  + COALESCE((SELECT count(*)::int FROM public.notes                WHERE user_id = p_user), 0)
  + COALESCE((SELECT count(*)::int FROM public.lykn_beliefs
                WHERE user_id = p_user AND status = 'active'), 0)
  + COALESCE((SELECT count(*)::int FROM public.lykn_user_model_facts
                WHERE user_id = p_user
                  AND status IN ('stated', 'confirmed', 'corrected')), 0);
$$;

-- 3b) concept_links (058): omnia_boards -> lykn_chats, cc.board_id -> cc.chat_id
CREATE OR REPLACE FUNCTION public.concept_links(p_concept_id uuid)
RETURNS TABLE(
  target_kind text,
  target_id uuid,
  target_label text,
  source text,
  weight real,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH owner_ok AS (
    SELECT 1
    FROM public.lykn_concepts
    WHERE id = p_concept_id AND user_id = auth.uid()
  )
  SELECT
    'note'::text AS target_kind,
    n.id AS target_id,
    COALESCE(NULLIF(n.title, ''), 'Untitled note') AS target_label,
    cn.source,
    cn.weight,
    cn.created_at
  FROM concept_notes cn
  JOIN public.notes n
    ON n.id = cn.note_id
   AND n.user_id = auth.uid()
  WHERE EXISTS (SELECT 1 FROM owner_ok)
    AND cn.concept_id = p_concept_id
    AND cn.user_id = auth.uid()

  UNION ALL

  SELECT
    'fact'::text AS target_kind,
    f.id AS target_id,
    f.fact_text AS target_label,
    cf.source,
    cf.weight,
    cf.created_at
  FROM concept_facts cf
  JOIN public.lykn_user_model_facts f
    ON f.id = cf.fact_id
   AND f.user_id = auth.uid()
  WHERE EXISTS (SELECT 1 FROM owner_ok)
    AND cf.concept_id = p_concept_id
    AND cf.user_id = auth.uid()

  UNION ALL

  SELECT
    'belief'::text AS target_kind,
    b.id AS target_id,
    b.belief_text AS target_label,
    cb.source,
    cb.weight,
    cb.created_at
  FROM concept_beliefs cb
  JOIN public.lykn_beliefs b
    ON b.id = cb.belief_id
   AND b.user_id = auth.uid()
  WHERE EXISTS (SELECT 1 FROM owner_ok)
    AND cb.concept_id = p_concept_id
    AND cb.user_id = auth.uid()

  UNION ALL

  SELECT
    'chat'::text AS target_kind,
    bd.id AS target_id,
    COALESCE(NULLIF(bd.title, ''), 'Untitled chat') AS target_label,
    cc.source,
    cc.weight,
    cc.created_at
  FROM concept_chats cc
  JOIN public.lykn_chats bd
    ON bd.id = cc.chat_id
   AND bd.user_id = auth.uid()
  WHERE EXISTS (SELECT 1 FROM owner_ok)
    AND cc.concept_id = p_concept_id
    AND cc.user_id = auth.uid()

  ORDER BY weight DESC, created_at DESC;
$$;

-- 3c) concept_links_for_user (061): cc.board_id -> cc.chat_id
CREATE OR REPLACE FUNCTION public.concept_links_for_user(p_limit int DEFAULT 30)
RETURNS TABLE(
  concept_id uuid,
  target_kind text,
  target_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH live_concepts AS (
    SELECT c.id
    FROM public.lykn_concepts c
    WHERE c.user_id = auth.uid()
      AND c.merged_into_id IS NULL
      AND c.status <> 'dismissed'
    ORDER BY c.last_touched_at DESC NULLS LAST, c.created_at DESC
    LIMIT GREATEST(COALESCE(p_limit, 30), 1)
  )
  SELECT cn.concept_id, 'note'::text AS target_kind, cn.note_id AS target_id
  FROM public.concept_notes cn
  WHERE cn.user_id = auth.uid()
    AND cn.concept_id IN (SELECT id FROM live_concepts)

  UNION ALL

  SELECT cf.concept_id, 'fact'::text AS target_kind, cf.fact_id AS target_id
  FROM public.concept_facts cf
  WHERE cf.user_id = auth.uid()
    AND cf.concept_id IN (SELECT id FROM live_concepts)

  UNION ALL

  SELECT cb.concept_id, 'belief'::text AS target_kind, cb.belief_id AS target_id
  FROM public.concept_beliefs cb
  WHERE cb.user_id = auth.uid()
    AND cb.concept_id IN (SELECT id FROM live_concepts)

  UNION ALL

  SELECT cc.concept_id, 'chat'::text AS target_kind, cc.chat_id AS target_id
  FROM public.concept_chats cc
  WHERE cc.user_id = auth.uid()
    AND cc.concept_id IN (SELECT id FROM live_concepts);
$$;

-- 3d) merge_concepts (058): concept_chats board_id -> chat_id (column list,
--     SELECT, and ON CONFLICT target). All other join tables unchanged.
CREATE OR REPLACE FUNCTION public.merge_concepts(from_id uuid, into_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  merged_count int := 0;
  from_user uuid;
  into_user uuid;
  from_merged uuid;
  into_merged uuid;
BEGIN
  IF from_id = into_id THEN
    RAISE EXCEPTION 'cannot merge a concept into itself';
  END IF;

  SELECT user_id, merged_into_id INTO from_user, from_merged
  FROM lykn_concepts WHERE id = from_id;
  SELECT user_id, merged_into_id INTO into_user, into_merged
  FROM lykn_concepts WHERE id = into_id;

  IF from_user IS NULL OR into_user IS NULL THEN
    RAISE EXCEPTION 'concept not found';
  END IF;
  IF from_user <> auth.uid() OR into_user <> auth.uid() THEN
    RAISE EXCEPTION 'not authorized';
  END IF;
  IF from_merged IS NOT NULL OR into_merged IS NOT NULL THEN
    RAISE EXCEPTION 'cannot merge an already-merged concept';
  END IF;

  -- ---- concept_notes -------------------------------------------------
  WITH moved AS (
    INSERT INTO concept_notes (user_id, concept_id, note_id, weight, source, created_at)
    SELECT user_id, into_id, note_id, weight, source, created_at
    FROM concept_notes
    WHERE concept_id = from_id AND user_id = auth.uid()
    ON CONFLICT (user_id, concept_id, note_id)
      DO UPDATE SET weight = GREATEST(concept_notes.weight, EXCLUDED.weight)
    RETURNING 1
  )
  SELECT COUNT(*) INTO merged_count FROM moved;

  DELETE FROM concept_notes
  WHERE concept_id = from_id AND user_id = auth.uid();

  -- ---- concept_facts ------------------------------------------------
  WITH moved AS (
    INSERT INTO concept_facts (user_id, concept_id, fact_id, weight, source, created_at)
    SELECT user_id, into_id, fact_id, weight, source, created_at
    FROM concept_facts
    WHERE concept_id = from_id AND user_id = auth.uid()
    ON CONFLICT (user_id, concept_id, fact_id)
      DO UPDATE SET weight = GREATEST(concept_facts.weight, EXCLUDED.weight)
    RETURNING 1
  )
  SELECT merged_count + COUNT(*) INTO merged_count FROM moved;

  DELETE FROM concept_facts
  WHERE concept_id = from_id AND user_id = auth.uid();

  -- ---- concept_beliefs ----------------------------------------------
  WITH moved AS (
    INSERT INTO concept_beliefs (user_id, concept_id, belief_id, weight, source, created_at)
    SELECT user_id, into_id, belief_id, weight, source, created_at
    FROM concept_beliefs
    WHERE concept_id = from_id AND user_id = auth.uid()
    ON CONFLICT (user_id, concept_id, belief_id)
      DO UPDATE SET weight = GREATEST(concept_beliefs.weight, EXCLUDED.weight)
    RETURNING 1
  )
  SELECT merged_count + COUNT(*) INTO merged_count FROM moved;

  DELETE FROM concept_beliefs
  WHERE concept_id = from_id AND user_id = auth.uid();

  -- ---- concept_chats ------------------------------------------------
  WITH moved AS (
    INSERT INTO concept_chats (user_id, concept_id, chat_id, weight, source, created_at)
    SELECT user_id, into_id, chat_id, weight, source, created_at
    FROM concept_chats
    WHERE concept_id = from_id AND user_id = auth.uid()
    ON CONFLICT (user_id, concept_id, chat_id)
      DO UPDATE SET weight = GREATEST(concept_chats.weight, EXCLUDED.weight)
    RETURNING 1
  )
  SELECT merged_count + COUNT(*) INTO merged_count FROM moved;

  DELETE FROM concept_chats
  WHERE concept_id = from_id AND user_id = auth.uid();

  -- ---- Soft-delete the merged-out row -------------------------------
  UPDATE lykn_concepts
     SET merged_into_id = into_id,
         updated_at = now()
   WHERE id = from_id AND user_id = auth.uid();

  UPDATE lykn_concepts
     SET last_touched_at = now(),
         updated_at = now()
   WHERE id = into_id AND user_id = auth.uid();

  RETURN merged_count;
END;
$$;

-- ----------------------------------------------------------------------------
-- 4) Cosmetic: drop "omnia_boards"/"boards" from the synthesis cap trigger and
--    function identifiers now that the table is lykn_chats. Triggers reference
--    their functions by OID, so renames don't break the wiring.
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_omnia_boards_synthesis_cap') THEN
    ALTER TRIGGER trg_omnia_boards_synthesis_cap ON public.lykn_chats RENAME TO trg_lykn_chats_synthesis_cap;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_omnia_boards_synthesis_count') THEN
    ALTER TRIGGER trg_omnia_boards_synthesis_count ON public.lykn_chats RENAME TO trg_lykn_chats_synthesis_count;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='enforce_synthesis_neuron_cap_boards') THEN
    ALTER FUNCTION public.enforce_synthesis_neuron_cap_boards() RENAME TO enforce_synthesis_neuron_cap_chats;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname='maintain_synthesis_neuron_count_boards') THEN
    ALTER FUNCTION public.maintain_synthesis_neuron_count_boards() RENAME TO maintain_synthesis_neuron_count_chats;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
