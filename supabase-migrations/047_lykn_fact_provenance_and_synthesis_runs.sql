-- ============================================
-- LYKN — fact provenance + nightly synthesis run audit
-- Migration: 047_lykn_fact_provenance_and_synthesis_runs.sql
-- ============================================
-- Foundation for the nightly belief-synthesis job. The job will pull all
-- facts, run UMAP + HDBSCAN, send qualifying clusters to a synthesis
-- LLM, and write proposed beliefs. Three things must be true before any
-- of that works, and 046 only solved the belief side. This is the fact
-- side.
--
-- This migration is FOUNDATION ONLY — it adds columns and tables, no
-- pipeline code. The pipeline is PR2.
--
-- (1) Facts need embeddings.
--     Today `lykn_user_model_facts` is pure text. UMAP needs a vector
--     space. We add `embedding vector(1536)` and an ivfflat index. The
--     application layer is responsible for fire-and-forget embed-on-write
--     (see userModelLearning.persistFacts). pgvector is already enabled
--     by migration 023 (lykn_synthesis_chunks).
--
-- (2) Facts need per-client provenance.
--     The cluster thresholds in the nightly spec depend on counting
--     distinct clients across a cluster:
--       single-client clusters require 4+ facts to promote
--       multi-client clusters (2+ distinct clients) only need 2+ facts
--     Today facts only carry `evidence` (jsonb) and `source_types`
--     (TEXT[] of source_type strings like 'vault_note' / 'conversation')
--     — none of which captures the AI client. We add:
--       source TEXT                — single client slug for THIS row
--       observed_by_clients TEXT[] — deduped set of every client that
--                                    has ever reinforced this fact_key,
--                                    capped at 8 in application code,
--                                    same shape as lykn_beliefs.proposed_by_clients
--
-- (3) Facts need to be linkable to a project.
--     The cross-project threshold (3+ facts spanning 2+ project_ids)
--     needs a way to know which project a fact "belongs to". Most facts
--     are project-agnostic identity facts (NULL); some are project-tied
--     (e.g. "designed the LYKN canvas component" — focused on a specific
--     project). We add an optional FK to lykn_projects.
--
-- And we add the audit table the spec calls for:
--
-- (4) lykn_synthesis_runs — one row per nightly run.
--     The spec's headline fields are clusters_found / candidates_evaluated
--     / proposals_written / skipped_*. We add a JSONB `details` column
--     for free-form per-run debug payload (cluster summaries, sample
--     facts, etc.) so the eventual "Last night's synthesis" UI has rich
--     data to render without us having to migrate again.

-- ---------------------------------------------------------------------------
-- 1. Fact provenance columns
-- ---------------------------------------------------------------------------
ALTER TABLE lykn_user_model_facts
  ADD COLUMN IF NOT EXISTS embedding vector(1536),
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS observed_by_clients TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES lykn_projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS proposed_in_conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS proposed_in_message_id TEXT,
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- Defensive width caps on the slug + id columns. Same shape as 046.
ALTER TABLE lykn_user_model_facts
  DROP CONSTRAINT IF EXISTS lykn_user_model_facts_source_len_check;
ALTER TABLE lykn_user_model_facts
  ADD CONSTRAINT lykn_user_model_facts_source_len_check
  CHECK (source IS NULL OR length(source) <= 64);

ALTER TABLE lykn_user_model_facts
  DROP CONSTRAINT IF EXISTS lykn_user_model_facts_conv_len_check;
ALTER TABLE lykn_user_model_facts
  ADD CONSTRAINT lykn_user_model_facts_conv_len_check
  CHECK (proposed_in_conversation_id IS NULL OR length(proposed_in_conversation_id) <= 128);

ALTER TABLE lykn_user_model_facts
  DROP CONSTRAINT IF EXISTS lykn_user_model_facts_msg_len_check;
ALTER TABLE lykn_user_model_facts
  ADD CONSTRAINT lykn_user_model_facts_msg_len_check
  CHECK (proposed_in_message_id IS NULL OR length(proposed_in_message_id) <= 128);

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
-- Vector index for the synthesis job's similarity-vs-existing-beliefs check
-- and any future "find facts like this one" UI. Cosine ops match the
-- text-embedding-3-small @ 1536d we use elsewhere. lists=100 is the same
-- value migration 023 chose for lykn_synthesis_chunks — kept identical so
-- recall behavior is consistent across both vector tables.
CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_embedding
  ON lykn_user_model_facts
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Cross-client convergence query (parallel to lykn_beliefs).
CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_observed_by_clients
  ON lykn_user_model_facts USING GIN (observed_by_clients);

-- Per-source debugging / "show me everything Cursor has noticed about me".
CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_user_source
  ON lykn_user_model_facts (user_id, source, last_seen_at DESC)
  WHERE source IS NOT NULL;

-- Cross-project clustering: cheap "facts in project X" lookup.
CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_user_project
  ON lykn_user_model_facts (user_id, project_id, last_seen_at DESC)
  WHERE project_id IS NOT NULL;

-- Backfill helper: "facts that still need an embedding."
CREATE INDEX IF NOT EXISTS idx_lykn_user_model_facts_needs_embedding
  ON lykn_user_model_facts (user_id, first_seen_at)
  WHERE embedding IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Synthesis run audit table
-- ---------------------------------------------------------------------------
-- One row per (user_id, run). Per-user because the cron will iterate users
-- and each user's run has its own metrics. The dashboard query is
-- "show me my last 30 nights" — (user_id, ran_at DESC) covers it.
CREATE TABLE IF NOT EXISTS lykn_synthesis_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- 'cron' (3am UTC scheduled), 'manual' (user clicked "Run synthesis now"
  -- in the UI for debugging), 'test' (CI / dev). Wide-open TEXT so we
  -- don't block adding new triggers.
  trigger TEXT NOT NULL DEFAULT 'cron',

  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  duration_ms INT NOT NULL DEFAULT 0,

  -- Per the spec — every funnel stage has a counter so the UI can render
  -- "47 clusters found, 12 hit threshold, 9 skipped (similarity > 0.85),
  --  3 skipped by model, 0 errors → 0 proposals written" without having
  -- to recompute anything from `details`.
  clusters_found INT NOT NULL DEFAULT 0,
  candidates_evaluated INT NOT NULL DEFAULT 0,
  proposals_written INT NOT NULL DEFAULT 0,
  skipped_duplicate INT NOT NULL DEFAULT 0,    -- cosine vs existing beliefs > 0.85
  skipped_threshold INT NOT NULL DEFAULT 0,    -- cluster did not meet min-fact rule
  skipped_model INT NOT NULL DEFAULT 0,        -- LLM said {"propose": false} or returned bad JSON
  error_count INT NOT NULL DEFAULT 0,

  -- Free-form debug payload. Loose schema by design — the rendering UI
  -- will key off whatever fields we choose to write, and we expect to
  -- add fields without migrating. Suggested shape:
  --   { umap_full_recompute: bool,
  --     facts_in: int,
  --     facts_with_embeddings: int,
  --     clusters: [ { id, fact_count, distinct_clients, distinct_projects, ... } ],
  --     proposals: [ { belief_text, serves_need, cluster_id } ],
  --     errors: [ { stage, message, cluster_id? } ] }
  details JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lykn_synthesis_runs_user_recent
  ON lykn_synthesis_runs (user_id, ran_at DESC);

ALTER TABLE lykn_synthesis_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own synthesis runs"
  ON lykn_synthesis_runs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- INSERT policy is intentionally NOT created — synthesis runs should only
-- be written by the service role (the cron job). Surfacing them to
-- authenticated INSERT would let any client fake run rows. The cron
-- worker uses the service-role key and bypasses RLS, which is correct.

-- ---------------------------------------------------------------------------
-- 4. Comments
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN lykn_user_model_facts.embedding IS
  'text-embedding-3-small @ 1536d of fact_text. Populated fire-and-forget by persistFacts after upsert; backfill script will fill historical NULLs.';
COMMENT ON COLUMN lykn_user_model_facts.source IS
  'Single client slug (claude-desktop, cursor, claude-code, chatgpt, lykn-chat, ...) that wrote the most recent reinforcement of this fact. Use observed_by_clients for the full set.';
COMMENT ON COLUMN lykn_user_model_facts.observed_by_clients IS
  'Append-only deduplicated set of every client that has ever reinforced this fact_key, capped at 8. Cardinality across a cluster is the multi-client signal in the synthesis job.';
COMMENT ON COLUMN lykn_user_model_facts.project_id IS
  'Optional pointer to the lykn_project this fact belongs to. NULL for project-agnostic identity facts; populated when the writing client has an active project at proposal time.';
COMMENT ON COLUMN lykn_user_model_facts.embedded_at IS
  'Timestamp when `embedding` was last (re)computed. NULL while still pending; backfill script and embed-on-write both stamp this.';

COMMENT ON TABLE lykn_synthesis_runs IS
  'One row per nightly synthesis job execution per user. Powers the "last night the AI noticed..." UI and lets us track funnel health (proposal rate, duplicate skip rate, model rejection rate) over time.';
