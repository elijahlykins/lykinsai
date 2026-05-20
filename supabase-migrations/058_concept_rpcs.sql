-- =====================================================================
-- 058 — concept RPCs
-- =====================================================================
-- Four SECURITY DEFINER functions, all scoped to auth.uid(), that
-- power the concept UI surfaces:
--
--   concepts_overview()             — per-concept rollup card data
--   concept_links(concept_id)       — detail panel
--   concepts_moved_since(since)     — briefing "your <X> moved" section
--   merge_concepts(from_id, into_id) — rewrites join rows, sets
--                                       merged_into_id, dedupes pairs
--
-- All read functions follow the same safe-cast pattern from 055
-- (regex-guard UUID casts) where any JSON-string source ids are
-- involved. The merge function is the only mutating RPC in the set
-- and is wrapped in an explicit ownership check so it can't be
-- abused by passing another user's concept ids.

-- ---------------------------------------------------------------------
-- 1. concepts_overview()
-- ---------------------------------------------------------------------
-- Per-concept rollup for the current user. One row per LIVE concept
-- (merged_into_id IS NULL). The counts are computed against the
-- join tables — concepts with zero links still appear so the user
-- can see what was minted even if nothing has attached to it yet.
--
-- Used by:
--   • /api/v1/concepts (server.js list endpoint)
--   • the 3D graph's concept fetch
--   • the briefing "concepts touched" pre-filter
CREATE OR REPLACE FUNCTION public.concepts_overview()
RETURNS TABLE(
  concept_id uuid,
  label text,
  slug text,
  kind text,
  source text,
  status text,
  confidence real,
  note_count bigint,
  fact_count bigint,
  belief_count bigint,
  chat_count bigint,
  last_touched_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH live_concepts AS (
    SELECT
      c.id,
      c.label,
      c.slug,
      c.kind,
      c.source,
      c.status,
      c.confidence,
      c.last_touched_at,
      c.created_at
    FROM public.lykn_concepts c
    WHERE c.user_id = auth.uid()
      AND c.merged_into_id IS NULL
  ),
  note_counts AS (
    SELECT concept_id, COUNT(*)::bigint AS n
    FROM public.concept_notes
    WHERE user_id = auth.uid()
    GROUP BY concept_id
  ),
  fact_counts AS (
    SELECT concept_id, COUNT(*)::bigint AS n
    FROM public.concept_facts
    WHERE user_id = auth.uid()
    GROUP BY concept_id
  ),
  belief_counts AS (
    SELECT concept_id, COUNT(*)::bigint AS n
    FROM public.concept_beliefs
    WHERE user_id = auth.uid()
    GROUP BY concept_id
  ),
  chat_counts AS (
    SELECT concept_id, COUNT(*)::bigint AS n
    FROM public.concept_chats
    WHERE user_id = auth.uid()
    GROUP BY concept_id
  )
  SELECT
    lc.id AS concept_id,
    lc.label,
    lc.slug,
    lc.kind,
    lc.source,
    lc.status,
    lc.confidence,
    COALESCE(nc.n, 0) AS note_count,
    COALESCE(fc.n, 0) AS fact_count,
    COALESCE(bc.n, 0) AS belief_count,
    COALESCE(cc.n, 0) AS chat_count,
    lc.last_touched_at,
    lc.created_at
  FROM live_concepts lc
  LEFT JOIN note_counts nc   ON nc.concept_id = lc.id
  LEFT JOIN fact_counts fc   ON fc.concept_id = lc.id
  LEFT JOIN belief_counts bc ON bc.concept_id = lc.id
  LEFT JOIN chat_counts  cc  ON cc.concept_id = lc.id
  ORDER BY
    -- Active concepts that have stuff attached come first, then
    -- proposals that the user hasn't touched yet, then everything
    -- else by recency. Dismissed concepts sort last.
    CASE lc.status
      WHEN 'active' THEN 0
      WHEN 'proposed' THEN 1
      WHEN 'dismissed' THEN 2
      ELSE 3
    END,
    (COALESCE(nc.n, 0) + COALESCE(fc.n, 0) + COALESCE(bc.n, 0) + COALESCE(cc.n, 0)) DESC,
    lc.last_touched_at DESC;
$$;

REVOKE ALL ON FUNCTION public.concepts_overview() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.concepts_overview() TO authenticated;

COMMENT ON FUNCTION public.concepts_overview() IS
  'Per-concept rollup (note/fact/belief/chat counts) for the calling user. Powers /api/v1/concepts and the 3D graph concept fetch.';

-- ---------------------------------------------------------------------
-- 2. concept_links(concept_id)
-- ---------------------------------------------------------------------
-- Detail-panel payload: every link this concept has across the four
-- join tables, with the target's display label so the UI can render
-- without a second join. Returns a long table (one row per link);
-- caller groups by target_kind.
--
-- target_kind: 'note' | 'fact' | 'belief' | 'chat'
-- target_id:   the underlying note/fact/belief/board id
-- target_label: title (note/board), text (fact), belief_text (belief)
-- source: the join-row's source column (where the link came from)
-- weight: the join-row's weight
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
  -- Owner-check sub-query: only emit rows if the caller owns the
  -- concept. Phrased as a WHERE so the function returns zero rows
  -- (not raises) when the id is foreign — same defensive shape as
  -- the read RPCs in 055.
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
  JOIN public.omnia_boards bd
    ON bd.id = cc.board_id
   AND bd.user_id = auth.uid()
  WHERE EXISTS (SELECT 1 FROM owner_ok)
    AND cc.concept_id = p_concept_id
    AND cc.user_id = auth.uid()

  ORDER BY weight DESC, created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.concept_links(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.concept_links(uuid) TO authenticated;

COMMENT ON FUNCTION public.concept_links(uuid) IS
  'All links (note/fact/belief/chat) for a single concept owned by the calling user. Powers the concept detail panel on /synthesis-layer.';

-- ---------------------------------------------------------------------
-- 3. concepts_moved_since(since timestamptz)
-- ---------------------------------------------------------------------
-- "Which concepts had new links land in the [since, now] window?"
-- Returns one row per concept with a JSONB delta payload describing
-- what moved. Powers the briefing's "your <concept> moved" section.
--
-- The deltas JSONB shape:
--   { notes:   <int>,   -- new concept_notes rows in window
--     facts:   <int>,
--     beliefs: <int>,
--     chats:   <int>,
--     latest_at: <timestamptz>  -- most recent link's created_at
--   }
-- Only concepts with at least one new link in the window appear.
-- Dismissed concepts are filtered out (the user already said they
-- don't want to hear about them).
CREATE OR REPLACE FUNCTION public.concepts_moved_since(since timestamptz)
RETURNS TABLE(
  concept_id uuid,
  label text,
  kind text,
  status text,
  source text,
  deltas jsonb,
  latest_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH window_links AS (
    SELECT concept_id, 'note'::text AS kind, created_at
    FROM public.concept_notes
    WHERE user_id = auth.uid() AND created_at >= since

    UNION ALL

    SELECT concept_id, 'fact'::text AS kind, created_at
    FROM public.concept_facts
    WHERE user_id = auth.uid() AND created_at >= since

    UNION ALL

    SELECT concept_id, 'belief'::text AS kind, created_at
    FROM public.concept_beliefs
    WHERE user_id = auth.uid() AND created_at >= since

    UNION ALL

    SELECT concept_id, 'chat'::text AS kind, created_at
    FROM public.concept_chats
    WHERE user_id = auth.uid() AND created_at >= since
  ),
  per_concept AS (
    SELECT
      wl.concept_id,
      SUM(CASE WHEN wl.kind = 'note'   THEN 1 ELSE 0 END)::int AS notes_delta,
      SUM(CASE WHEN wl.kind = 'fact'   THEN 1 ELSE 0 END)::int AS facts_delta,
      SUM(CASE WHEN wl.kind = 'belief' THEN 1 ELSE 0 END)::int AS beliefs_delta,
      SUM(CASE WHEN wl.kind = 'chat'   THEN 1 ELSE 0 END)::int AS chats_delta,
      MAX(wl.created_at) AS latest_at
    FROM window_links wl
    GROUP BY wl.concept_id
  )
  SELECT
    c.id AS concept_id,
    c.label,
    c.kind,
    c.status,
    c.source,
    jsonb_build_object(
      'notes',     pc.notes_delta,
      'facts',     pc.facts_delta,
      'beliefs',   pc.beliefs_delta,
      'chats',     pc.chats_delta,
      'latest_at', pc.latest_at
    ) AS deltas,
    pc.latest_at
  FROM per_concept pc
  JOIN public.lykn_concepts c
    ON c.id = pc.concept_id
   AND c.user_id = auth.uid()
   AND c.merged_into_id IS NULL
   AND c.status <> 'dismissed'
  ORDER BY (pc.notes_delta + pc.facts_delta + pc.beliefs_delta + pc.chats_delta) DESC,
           pc.latest_at DESC;
$$;

REVOKE ALL ON FUNCTION public.concepts_moved_since(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.concepts_moved_since(timestamptz) TO authenticated;

COMMENT ON FUNCTION public.concepts_moved_since(timestamptz) IS
  'Concepts with new join-table rows since the given timestamp, for the calling user. Powers the "your <concept> moved" section of the chat briefing.';

-- ---------------------------------------------------------------------
-- 4. merge_concepts(from_id, into_id)
-- ---------------------------------------------------------------------
-- Merges `from_id` into `into_id`. All join rows pointing at from_id
-- are rewritten to point at into_id, dedupe by (concept_id, target_id)
-- with the surviving row keeping the higher weight. from_id is then
-- soft-deleted by setting merged_into_id; status stays as-is so the
-- merge audit shows what the row looked like at merge time.
--
-- Validates:
--   • Both ids belong to the calling user.
--   • Neither id is already merged out (would create a redirect chain).
--   • from_id != into_id.
--
-- Returns:
--   merged_rows int — total number of join rows rewritten (notes +
--                     facts + beliefs + chats), useful for the UI
--                     toast ("merged 8 links from X into Y").
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
  -- Upsert any rows from `from_id` into `into_id`, taking the max
  -- weight if a pair already exists; then delete the originals.
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
    INSERT INTO concept_chats (user_id, concept_id, board_id, weight, source, created_at)
    SELECT user_id, into_id, board_id, weight, source, created_at
    FROM concept_chats
    WHERE concept_id = from_id AND user_id = auth.uid()
    ON CONFLICT (user_id, concept_id, board_id)
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

  -- Touch the surviving concept so it bubbles up in recency-sorted
  -- views immediately after a merge.
  UPDATE lykn_concepts
     SET last_touched_at = now(),
         updated_at = now()
   WHERE id = into_id AND user_id = auth.uid();

  RETURN merged_count;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_concepts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_concepts(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.merge_concepts(uuid, uuid) IS
  'Merge from_id into into_id. Rewrites all four join tables (notes/facts/beliefs/chats) deduping by (user_id, concept_id, target_id) and taking the higher weight, then soft-deletes from_id by setting merged_into_id. Returns the count of rewritten join rows.';
