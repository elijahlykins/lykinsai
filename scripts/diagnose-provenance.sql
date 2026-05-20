-- ============================================
-- Belief-provenance data shape diagnostic
-- Run this in the Supabase SQL editor (logged in as yourself)
-- to see exactly why /synthesis-layer isn't drawing indigo
-- provenance edges yet.
-- ============================================
--
-- All five queries are read-only and auth.uid()-scoped, so they only
-- see your rows. Paste the whole file and run -- each result block is
-- labelled.

-- ---------------------------------------------------------------
-- 1. Belief breakdown -- which of your beliefs even have facts
--    attached?  Beliefs with promoted_from_facts = []  CANNOT
--    draw a belief->fact edge no matter what we do.
-- ---------------------------------------------------------------
SELECT
  '1. beliefs with vs without promoting facts'                 AS label,
  COUNT(*)                                                     AS total_beliefs,
  COUNT(*) FILTER (WHERE cardinality(promoted_from_facts) > 0) AS with_facts,
  COUNT(*) FILTER (WHERE cardinality(promoted_from_facts) = 0) AS user_authored_or_orphan
FROM lykn_beliefs
WHERE user_id = auth.uid()
  AND status IN ('active','proposed');

-- ---------------------------------------------------------------
-- 2. Which specific beliefs have promoting facts? (those are the
--    ones that can grow indigo edges)
-- ---------------------------------------------------------------
SELECT
  '2. beliefs that can draw edges' AS label,
  id,
  left(belief_text, 60) AS belief_text,
  cardinality(promoted_from_facts) AS fact_count,
  status
FROM lykn_beliefs
WHERE user_id = auth.uid()
  AND status IN ('active','proposed')
  AND cardinality(promoted_from_facts) > 0
ORDER BY cardinality(promoted_from_facts) DESC;

-- ---------------------------------------------------------------
-- 3. For the facts those beliefs cite, what kind of evidence do
--    they carry? Only 'vault_note' and 'board' types currently
--    draw edges in the 3D graph -- 'conversation' / 'intake' / etc.
--    are recorded in the DB but the graph doesn't visualise them.
-- ---------------------------------------------------------------
WITH cited_fact_ids AS (
  SELECT DISTINCT unnest(promoted_from_facts) AS fact_id
  FROM lykn_beliefs
  WHERE user_id = auth.uid()
    AND status IN ('active','proposed')
),
fact_evidence AS (
  SELECT
    f.id AS fact_id,
    jsonb_array_elements(COALESCE(f.evidence,'[]'::jsonb)) AS ev
  FROM lykn_user_model_facts f
  JOIN cited_fact_ids c ON c.fact_id = f.id
  WHERE f.user_id = auth.uid()
)
SELECT
  '3. evidence type breakdown for cited facts' AS label,
  COALESCE(ev->>'source_type','(missing source_type)') AS source_type,
  COUNT(*) AS evidence_rows
FROM fact_evidence
GROUP BY 1, 2
ORDER BY 3 DESC;

-- ---------------------------------------------------------------
-- 4. Direct RPC test -- what does get_belief_provenance actually
--    return for your beliefs RIGHT NOW? (If this is empty,
--    nothing the graph code does can help -- the upstream chain
--    has no rows.)
-- ---------------------------------------------------------------
WITH my_belief_ids AS (
  SELECT array_agg(id) AS ids
  FROM lykn_beliefs
  WHERE user_id = auth.uid()
    AND status IN ('active','proposed')
)
SELECT
  '4. rows returned by get_belief_provenance' AS label,
  source_type,
  source_connector,
  COUNT(*) AS rows_returned
FROM public.get_belief_provenance((SELECT ids FROM my_belief_ids))
GROUP BY 2, 3
ORDER BY 4 DESC;

-- ---------------------------------------------------------------
-- 5. Sample of the actual rows the graph would draw edges to,
--    if any. Empty = no provenance edges visible. Non-empty =
--    you should be seeing indigo lines from a belief node to
--    these source notes.
-- ---------------------------------------------------------------
WITH my_belief_ids AS (
  SELECT array_agg(id) AS ids
  FROM lykn_beliefs
  WHERE user_id = auth.uid()
    AND status IN ('active','proposed')
)
SELECT
  '5. sample of edges that should render' AS label,
  left(fact_text, 50) AS from_fact,
  source_type,
  COALESCE(source_label, '(unmatched note)') AS to_source,
  source_connector
FROM public.get_belief_provenance((SELECT ids FROM my_belief_ids))
LIMIT 10;
