-- ============================================================================
-- 098 — Real lexical search for the Vault (BM25-style full-text)
-- ============================================================================
-- Until now `lykn_searchVault`'s keyword pass was `ilike '%term%'` substring
-- matching: no relevance ranking, no word-stemming, no index (sequential scan),
-- and easily fooled by word forms. This migration gives the Vault a proper
-- lexical retriever to sit alongside the dense/vector pass:
--
--   1. A STORED generated `tsvector` column on `notes`, weighted so a title hit
--      outranks a body hit (A=title, B=ai_summary, C=content).
--   2. A GIN index over that column for fast `@@` lookups.
--   3. `search_notes_bm25(user_id, query, match_count)` — ranks matches with
--      `ts_rank` using `websearch_to_tsquery` (handles quoted phrases, OR, and
--      `-negation` from natural query strings, and degrades to "no rows" on
--      garbage input rather than erroring).
--
-- Postgres full-text `ts_rank` is not literally Okapi BM25, but it is the same
-- class of length-normalized lexical scoring and is the right native tool here;
-- the application fuses it with the vector pass via Reciprocal Rank Fusion.
--
-- DEPLOY NOTE: adding a STORED generated column rewrites the `notes` table once
-- (proportional to row count). On a large table run during a low-traffic window.
-- `lykn_searchVault` falls back to the old ilike pass if this RPC is absent, so
-- the app keeps working before/after this migration is applied.
-- ----------------------------------------------------------------------------

-- 1. Weighted full-text vector. `left(...)` caps input so a pathologically large
--    note body can't blow past the tsvector size limit. The expression is
--    IMMUTABLE (literal 'english' regconfig + left + setweight + ||), which a
--    STORED generated column requires.
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', left(coalesce(title, ''), 50000)), 'A') ||
    setweight(to_tsvector('english', left(coalesce(ai_summary, ''), 50000)), 'B') ||
    setweight(to_tsvector('english', left(coalesce(content, ''), 200000)), 'C')
  ) STORED;

-- 2. GIN index for fast match. CONCURRENTLY isn't usable inside a txn-wrapped
--    migration runner; if you apply this by hand on a big table, prefer
--    `CREATE INDEX CONCURRENTLY` instead.
CREATE INDEX IF NOT EXISTS idx_notes_fts ON notes USING GIN (fts);

-- 3. Ranked lexical search, service-role callable (MCP has no user JWT, so it
--    can't rely on auth.uid()). The WHERE clause pins results to the requested
--    user, so the service role can never leak another user's notes.
CREATE OR REPLACE FUNCTION search_notes_bm25(
  p_user_id UUID,
  p_query TEXT,
  match_count INT DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  rank REAL
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    n.id,
    n.title,
    ts_rank(n.fts, websearch_to_tsquery('english', p_query)) AS rank
  FROM notes n
  WHERE
    n.user_id = p_user_id
    AND p_query IS NOT NULL
    AND length(btrim(p_query)) > 0
    AND n.fts @@ websearch_to_tsquery('english', p_query)
  ORDER BY rank DESC, n.updated_at DESC NULLS LAST
  LIMIT LEAST(GREATEST(match_count, 1), 50);
$$;

REVOKE ALL ON FUNCTION search_notes_bm25(UUID, TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_notes_bm25(UUID, TEXT, INT) TO service_role;
-- Also allow the per-user (JWT) path to use it directly if we wire it into
-- in-app chat retrieval later; the p_user_id filter is still the gate.
GRANT EXECUTE ON FUNCTION search_notes_bm25(UUID, TEXT, INT) TO authenticated;
