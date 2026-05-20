-- ============================================
-- Belief / fact / source provenance RPCs
-- Migration: 055_belief_source_provenance_rpcs.sql
-- ============================================
--
-- Background
-- ----------
-- The data model already knows how everything is connected:
--   * lykn_user_model_facts.evidence[] is a JSONB array of
--     { source_type, source_id, snippet, observed_at } pointing at the
--     vault note / board / chat that produced the fact.
--   * lykn_beliefs.promoted_from_facts UUID[] knows which facts seeded
--     each belief.
--   * Every connector adapter (Notion, Gmail, Slack, ...) saves items
--     into `notes` with a `source` slug via connectors/_save.js, so a
--     vault note's `source` directly identifies the upstream connector.
--
-- Three UIs need to walk this chain:
--   1. ConnectionsAppGrid -- per-tile "12 notes / 4 facts / 1 belief"
--      footer so /connections stops feeling like a wiring panel and
--      starts showing how much each app has shaped the synthesis layer.
--   2. SynthesisLayer 3D graph -- cross-edges belief->fact->note so the
--      mind map actually looks like a web instead of four clusters.
--   3. Load-in chat briefing -- "Grounded in <X, Y, Z>" chips under
--      each proposed belief so the user can see the receipts at a
--      glance every morning.
--
-- Doing the walk once on the server keeps the three UIs consistent and
-- avoids three different N+1 patterns through the JS client.
--
-- Both functions are SECURITY DEFINER + hard-scoped to auth.uid() (the
-- same pattern as vault_tag_counts in 053_vault_tag_counts_rpc.sql).
-- Anonymous callers cannot invoke them; service-role callers see zero
-- rows because auth.uid() is NULL in that context, which is the safe
-- failure mode for these read-only aggregates.

-- ---------------------------------------------------------------------------
-- 1. get_belief_provenance(belief_ids)
-- ---------------------------------------------------------------------------
-- For each (currently authenticated user's) belief in the given id list,
-- returns one row per (belief, fact, evidence entry). When the evidence
-- entry's source_type='vault_note' and we can find the matching note,
-- the row carries `source_label` (note title) and `source_connector`
-- (notes.source slug -- e.g. 'notion_page', 'gmail_starred') so the
-- briefing chips and graph edges can render the right brand.
--
-- For non-vault evidence (source_type='board', 'conversation', 'intake')
-- we still emit a row with source_label NULL so the caller can render
-- a generic chip without re-querying.
--
-- Shape per row:
--   belief_id        -- one of the requested ids
--   fact_id          -- a lykn_user_model_facts.id in promoted_from_facts
--   fact_text        -- short claim for display
--   source_type      -- 'vault_note' | 'board' | 'conversation' | 'intake'
--   source_id        -- the note id / board id / etc.
--   source_label     -- note title when source_type='vault_note', else NULL
--   source_connector -- notes.source slug, NULL for non-vault sources
--   observed_at      -- when the evidence was first stamped (for ordering)
CREATE OR REPLACE FUNCTION public.get_belief_provenance(belief_ids uuid[])
RETURNS TABLE(
  belief_id uuid,
  fact_id uuid,
  fact_text text,
  source_type text,
  source_id text,
  source_label text,
  source_connector text,
  observed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH my_beliefs AS (
    SELECT b.id AS belief_id, b.promoted_from_facts
    FROM public.lykn_beliefs b
    WHERE b.user_id = auth.uid()
      AND b.id = ANY(COALESCE(belief_ids, ARRAY[]::uuid[]))
  ),
  expanded_facts AS (
    SELECT
      mb.belief_id,
      f.id AS fact_id,
      f.fact_text,
      f.evidence
    FROM my_beliefs mb
    CROSS JOIN LATERAL unnest(mb.promoted_from_facts) AS bf(fact_id)
    JOIN public.lykn_user_model_facts f
      ON f.id = bf.fact_id
     AND f.user_id = auth.uid()
  ),
  expanded_evidence AS (
    SELECT
      ef.belief_id,
      ef.fact_id,
      ef.fact_text,
      (ev->>'source_type')::text AS source_type,
      (ev->>'source_id')::text   AS source_id,
      -- Pre-cast guard. Conversation / intake evidence carries
      -- non-uuid source ids ("session_abc", "intake_q3"); a bare
      -- `(ev->>'source_id')::uuid` in the JOIN below would raise
      -- 22P02 because Postgres doesn't guarantee short-circuit
      -- evaluation of join-on predicates -- the regex guard and
      -- the cast can be reordered, blowing up the whole query
      -- with a 400. Materialising the safe cast here (NULL when
      -- the string isn't shaped like a uuid) eliminates that
      -- race and lets the JOIN run cleanly across mixed evidence.
      CASE
        WHEN (ev->>'source_id') ~ '^[0-9a-fA-F-]{36}$'
        THEN (ev->>'source_id')::uuid
        ELSE NULL
      END AS source_id_uuid,
      NULLIF(ev->>'observed_at','')::timestamptz AS observed_at
    FROM expanded_facts ef
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ef.evidence, '[]'::jsonb)) AS ev
    WHERE COALESCE(ev->>'source_id','') <> ''
  )
  SELECT
    ee.belief_id,
    ee.fact_id,
    ee.fact_text,
    ee.source_type,
    ee.source_id,
    CASE
      WHEN ee.source_type = 'vault_note' THEN n.title
      ELSE NULL
    END AS source_label,
    CASE
      WHEN ee.source_type = 'vault_note' THEN n.source
      ELSE NULL
    END AS source_connector,
    ee.observed_at
  FROM expanded_evidence ee
  LEFT JOIN public.notes n
    ON ee.source_type = 'vault_note'
   AND ee.source_id_uuid IS NOT NULL
   AND n.user_id = auth.uid()
   AND n.id = ee.source_id_uuid
  ORDER BY ee.belief_id, ee.observed_at DESC NULLS LAST;
$$;

REVOKE ALL ON FUNCTION public.get_belief_provenance(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_belief_provenance(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_belief_provenance(uuid[]) IS
  'Walks belief.promoted_from_facts -> fact.evidence[].source_id -> notes for the calling user. Powers belief grounding chips, 3D-graph cross-edges, and any UI that wants to show "this belief came from these things."';


-- ---------------------------------------------------------------------------
-- 2. get_connector_synthesis_counts()
-- ---------------------------------------------------------------------------
-- For every distinct `notes.source` slug the calling user has, returns:
--   note_count   -- rows in `notes` with this source
--   fact_count   -- distinct facts whose evidence cites any of those notes
--   belief_count -- distinct beliefs whose promoted_from_facts includes any
--                   of those facts
--
-- The fact_count / belief_count joins are intentionally one-direction
-- (notes -> facts -> beliefs) because the connector tile needs to
-- answer "how much of my synthesis traces back to this app?" -- not
-- the inverse. Facts with no vault-note evidence (e.g. stated in chat,
-- intake-derived) simply don't surface against any connector tile,
-- which is the desired behavior: those rows aren't *about* a connector.
--
-- Performance: notes is already indexed on (user_id, source) by the
-- catalog filter queries; the JSONB containment lookup against
-- lykn_user_model_facts.evidence uses a sequential scan today, but the
-- per-user fact count is small (target O(100)) so this stays well
-- under a second even for power users. If we ever want a faster path,
-- a GIN index on `evidence` is the lever.
CREATE OR REPLACE FUNCTION public.get_connector_synthesis_counts()
RETURNS TABLE(
  connector_source text,
  note_count bigint,
  fact_count bigint,
  belief_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH my_notes AS (
    SELECT id, source
    FROM public.notes
    WHERE user_id = auth.uid()
      AND source IS NOT NULL
      AND source <> ''
  ),
  -- (note_id, source) pairs -- one per note. We'll group by source at
  -- the end so the same note can't double-count itself.
  per_source_notes AS (
    SELECT
      source AS connector_source,
      COUNT(*)::bigint AS note_count
    FROM my_notes
    GROUP BY source
  ),
  -- Expand each fact's evidence[] into rows, pre-casting the
  -- source_id to uuid in a guarded CASE so non-uuid evidence
  -- (conversation / intake) doesn't blow up the whole function.
  -- See the matching comment in get_belief_provenance for the
  -- full reasoning -- short version: a bare cast inside the JOIN
  -- on-clause can be reordered ahead of the regex guard and
  -- raises 22P02 at runtime.
  fact_evidence_pairs AS (
    SELECT
      f.id AS fact_id,
      (ev->>'source_type') AS source_type,
      CASE
        WHEN (ev->>'source_id') ~ '^[0-9a-fA-F-]{36}$'
        THEN (ev->>'source_id')::uuid
        ELSE NULL
      END AS source_id_uuid
    FROM public.lykn_user_model_facts f
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(f.evidence, '[]'::jsonb)) AS ev
    WHERE f.user_id = auth.uid()
  ),
  fact_source_pairs AS (
    SELECT DISTINCT
      fep.fact_id,
      n.source AS connector_source
    FROM fact_evidence_pairs fep
    JOIN public.notes n
      ON n.user_id = auth.uid()
     AND fep.source_type = 'vault_note'
     AND fep.source_id_uuid IS NOT NULL
     AND n.id = fep.source_id_uuid
     AND n.source IS NOT NULL
     AND n.source <> ''
  ),
  per_source_facts AS (
    SELECT
      connector_source,
      COUNT(DISTINCT fact_id)::bigint AS fact_count
    FROM fact_source_pairs
    GROUP BY connector_source
  ),
  -- Belief side: take the (fact, source) pairs above and join through
  -- promoted_from_facts so we can count distinct beliefs per source.
  belief_source_pairs AS (
    SELECT DISTINCT
      b.id AS belief_id,
      fsp.connector_source
    FROM fact_source_pairs fsp
    JOIN public.lykn_beliefs b
      ON b.user_id = auth.uid()
     AND b.promoted_from_facts @> ARRAY[fsp.fact_id]::uuid[]
  ),
  per_source_beliefs AS (
    SELECT
      connector_source,
      COUNT(DISTINCT belief_id)::bigint AS belief_count
    FROM belief_source_pairs
    GROUP BY connector_source
  )
  SELECT
    psn.connector_source,
    psn.note_count,
    COALESCE(psf.fact_count, 0)::bigint AS fact_count,
    COALESCE(psb.belief_count, 0)::bigint AS belief_count
  FROM per_source_notes psn
  LEFT JOIN per_source_facts psf USING (connector_source)
  LEFT JOIN per_source_beliefs psb USING (connector_source)
  ORDER BY psn.note_count DESC, psn.connector_source ASC;
$$;

REVOKE ALL ON FUNCTION public.get_connector_synthesis_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_connector_synthesis_counts() TO authenticated;

COMMENT ON FUNCTION public.get_connector_synthesis_counts() IS
  'Per-connector-source aggregate of (notes, facts citing those notes, beliefs promoted from those facts) for the calling user. Powers the synthesis-counts footer on connector tiles in /connections.';
