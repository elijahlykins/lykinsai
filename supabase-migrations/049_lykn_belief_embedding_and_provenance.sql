-- =====================================================================
-- 049 — Belief embeddings + machine-readable provenance
-- =====================================================================
-- Two columns on `lykn_beliefs` that the nightly synthesis job needs:
--
-- (1) embedding vector(1536)
--     The synthesis pipeline proposes a belief from a cluster of
--     facts. Before writing it, the job needs to skip duplicates
--     ("we already have a near-identical belief"). The cheap, robust
--     check is cosine similarity against existing beliefs' belief_text
--     embeddings — same text-embedding-3-small @ 1536d we use for
--     facts (migration 047). Threshold: > 0.85 → skip.
--     Pre-existing rows stay NULL; the dedup gracefully skips NULL
--     comparisons, so no backfill is required for the job to run.
--     A backfill script can populate historical rows opportunistically.
--
-- (2) provenance JSONB
--     The job-proposed beliefs need to carry enough machine-readable
--     metadata to power a "this belief came from these N facts in
--     cluster X on date Y" UI. The existing rationale TEXT column is
--     user-facing copy and shouldn't be dual-purposed (see 046's
--     rationale-as-string lessons learned). JSONB lets us iterate the
--     payload shape without further migrations. Suggested keys:
--       { source: 'synthesis_job',
--         cluster_id: int,
--         fact_ids: [uuid…],
--         run_id: uuid,            // future: link to lykn_synthesis_runs
--         distinct_clients: int,
--         distinct_projects: int }
--     Manually-authored / per-client-MCP-proposed beliefs leave it as
--     the default `{}` and continue to use `source` + `proposed_by_clients`.

ALTER TABLE lykn_beliefs
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Vector index for the synthesis job's dedup query. Same shape as the
-- index in 047 on lykn_user_model_facts; cosine ops match the embedding
-- model. lists=50 instead of 100 because beliefs are an order of
-- magnitude fewer rows than facts.
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_lykn_beliefs_embedding
  ON lykn_beliefs
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- Backfill helper: "beliefs that still need an embedding."
CREATE INDEX IF NOT EXISTS idx_lykn_beliefs_needs_embedding
  ON lykn_beliefs (user_id, created_at)
  WHERE embedding IS NULL;

-- "Beliefs proposed by the synthesis job" — for the digest UI to show
-- nightly synthesis output separately from user-authored / per-client
-- MCP proposals.
CREATE INDEX IF NOT EXISTS idx_lykn_beliefs_synthesis_provenance
  ON lykn_beliefs ((provenance ->> 'source'))
  WHERE provenance ->> 'source' IS NOT NULL;

COMMENT ON COLUMN lykn_beliefs.embedding IS
  'text-embedding-3-small @ 1536d of belief_text. Populated on synthesis-job insert and on user-authored insert via embed-on-write; NULL for pre-049 rows until backfilled.';
COMMENT ON COLUMN lykn_beliefs.provenance IS
  'Machine-readable provenance payload. Synthesis-job-proposed beliefs carry { source, cluster_id, fact_ids, … }; manually-authored beliefs carry {}. Add fields freely without migrating; UI reads defensively.';
COMMENT ON COLUMN lykn_beliefs.embedded_at IS
  'Timestamp when `embedding` was last (re)computed. NULL while still pending; embed-on-write and backfill both stamp this.';
