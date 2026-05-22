-- =====================================================================
-- 061 — concept_links_for_user
-- =====================================================================
-- One-shot batched fetch of every (concept_id, target_kind, target_id)
-- pair the user owns, optionally capped at the top-N most recently
-- touched concepts. Replaces the synthesis-layer's previous fan-out
-- that called `concept_links(concept_id)` in 5 sequential round-trips
-- of 6 RPCs each (30 calls per page mount).
--
-- Why a new function instead of looping inside `concept_links` —
-- `concept_links(concept_id uuid)` (058) is shaped for the concept
-- detail panel where the caller knows exactly one concept id and
-- wants the rich per-target metadata (label, source, weight,
-- created_at). The synthesis-layer graph only needs the (kind,
-- target_id) tuple to draw cross-edges, so we return a much slimmer
-- shape here and skip the join-to-target-table cost.
--
-- Ordering / capping is done server-side against `last_touched_at`
-- so a user with thousands of concepts still gets a bounded result
-- set; the same N cap the client used to apply (top 30) is moved
-- here as the default.

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
  -- Top-N (by last_touched_at desc) live, non-dismissed concepts the
  -- caller owns. Same filter the client used to apply over the
  -- `concepts_overview` results before fanning out to per-concept
  -- RPCs — moving it server-side keeps the cap honest even if a
  -- future caller forgets to pre-filter.
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

  SELECT cc.concept_id, 'chat'::text AS target_kind, cc.board_id AS target_id
  FROM public.concept_chats cc
  WHERE cc.user_id = auth.uid()
    AND cc.concept_id IN (SELECT id FROM live_concepts);
$$;

REVOKE ALL ON FUNCTION public.concept_links_for_user(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.concept_links_for_user(int) TO authenticated;

COMMENT ON FUNCTION public.concept_links_for_user(int) IS
  'Batched concept_links across the top-N (by last_touched_at) live concepts owned by the calling user. Replaces the 30-call per-mount fan-out in the synthesis-layer graph with a single round-trip.';
