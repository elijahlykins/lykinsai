-- ============================================================================
-- 092 — Admin-callable semantic match over the synthesis index
-- ============================================================================
-- `match_lykn_synthesis_chunks` (migration 023) filters on `auth.uid()`, which
-- only resolves when the caller presents a user JWT. The agent-facing MCP
-- tools (lykn_searchVault, voice search_vault, external MCP clients) run with
-- the SERVICE-ROLE client and NO user JWT, so `auth.uid()` is NULL there and
-- the original function always returns zero rows for them.
--
-- That gap is exactly why `lykn_searchVault` was substring-only: it had no way
-- to reach the vector index on behalf of a resolved user. This function takes
-- the target user_id explicitly so the service role can run the same cosine
-- search the chat layer already uses. RLS is bypassed by the service role, but
-- the WHERE clause pins results to the requested user, so one user can never
-- read another's chunks through this path.
--
-- Shape mirrors match_lykn_synthesis_chunks exactly so callers can swap freely.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION match_lykn_synthesis_chunks_for_user(
  query_embedding vector(1536),
  p_user_id UUID,
  match_count INT DEFAULT 8,
  match_threshold FLOAT DEFAULT 0.55
)
RETURNS TABLE (
  id UUID,
  source_type TEXT,
  source_id TEXT,
  chunk_index INT,
  content TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    c.id,
    c.source_type,
    c.source_id,
    c.chunk_index,
    c.content,
    c.metadata,
    (1 - (c.embedding <=> query_embedding))::FLOAT AS similarity
  FROM lykn_synthesis_chunks c
  WHERE
    c.user_id = p_user_id
    AND (1 - (c.embedding <=> query_embedding)) >= match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 32);
$$;

-- Only the server (service_role) may call this — never the browser. The
-- per-user variant in 023 stays the one granted to `authenticated`.
REVOKE ALL ON FUNCTION match_lykn_synthesis_chunks_for_user(vector(1536), UUID, INT, FLOAT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_lykn_synthesis_chunks_for_user(vector(1536), UUID, INT, FLOAT) TO service_role;
