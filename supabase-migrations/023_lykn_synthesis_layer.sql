-- ============================================
-- LYKN synthesis layer (phased rollout)
-- Migration: 023_lykn_synthesis_layer.sql
-- ============================================
-- Phase 1 — Schema + single-call retrieval RPC (this file).
-- Phase 2 — Server batches embeds (debounced / low frequency); avoid per-keystroke writes.
-- Phase 3 — Profile row updated async; inject into prompt alongside retrieval.
--
-- Load discipline (application-side, not enforced here):
-- - At most one `match_lykn_synthesis_chunks` RPC per user message (retrieval).
-- - Batch INSERT chunks (e.g. 16–32 rows) instead of one insert per sentence.
-- - Debounce re-embedding the same board/note (e.g. 60s+) or run on save/session end.
-- - Prefer replacing chunks for a source in one transaction (delete by source + insert batch).

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- Chunk store: one row per embedded text segment + vector
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_synthesis_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- vault_note | grid_board | conversation_exchange | project_file | ...
  source_type TEXT NOT NULL,
  -- Stable id within that type: note id, board id, ai_conversation_memory.id, etc.
  source_id TEXT NOT NULL,
  chunk_index INT NOT NULL DEFAULT 0,

  content TEXT NOT NULL,
  embedding vector(1536) NOT NULL,

  -- source_type, tags, related ids, content dates, etc. (filtering in app or future RPC args)
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lykn_synthesis_chunks_source_chunk_unique
    UNIQUE (user_id, source_type, source_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_lykn_synthesis_chunks_user_source
  ON lykn_synthesis_chunks (user_id, source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_lykn_synthesis_chunks_user_updated
  ON lykn_synthesis_chunks (user_id, updated_at DESC);

-- IVFFLAT — rebuild after you have enough rows for meaningful lists (or switch to HNSW in dashboard)
CREATE INDEX IF NOT EXISTS idx_lykn_synthesis_chunks_embedding
  ON lykn_synthesis_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

ALTER TABLE lykn_synthesis_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own synthesis chunks"
  ON lykn_synthesis_chunks FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own synthesis chunks"
  ON lykn_synthesis_chunks FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own synthesis chunks"
  ON lykn_synthesis_chunks FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own synthesis chunks"
  ON lykn_synthesis_chunks FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Incremental user model (compact text + optional structured fields)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_user_synthesis_profile (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Short prose block injected into prompts; keep small (maintain in writer phase)
  narrative TEXT,
  themes TEXT[] DEFAULT ARRAY[]::TEXT[],
  signals JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE lykn_user_synthesis_profile ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own synthesis profile"
  ON lykn_user_synthesis_profile FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users upsert own synthesis profile"
  ON lykn_user_synthesis_profile FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own synthesis profile"
  ON lykn_user_synthesis_profile FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Semantic search: ONE round-trip per call; uses auth.uid() — no user_id param
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION match_lykn_synthesis_chunks(
  query_embedding vector(1536),
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
    c.user_id = auth.uid()
    AND (1 - (c.embedding <=> query_embedding)) >= match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT LEAST(GREATEST(match_count, 1), 32);
$$;

REVOKE ALL ON FUNCTION match_lykn_synthesis_chunks(vector(1536), INT, FLOAT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_lykn_synthesis_chunks(vector(1536), INT, FLOAT) TO authenticated;
