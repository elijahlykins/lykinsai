-- =====================================================================
-- 056 — lykn_concepts: first-class concept/topic layer
-- =====================================================================
-- Stage 2 of the "make the synthesis layer feel less segregated" arc.
-- Stage 1 (migration 055) walked the existing belief→fact→source
-- chain and surfaced it across three UIs. The remaining gap was that
-- "topics" themselves were never first-class entities — they lived
-- as bare strings in three different stores:
--
--   • lykn_user_synthesis_profile.themes (TEXT[])
--   • notes.tags                          (TEXT[]) and notes.ai_signals.themes
--   • lykn_user_model_facts WHERE fact_kind = 'theme'
--
-- Nothing could attach to them, so the 3D graph rendered them as
-- leaf `neuron_theme_*` nodes and the briefing had no concept-level
-- rollup. This migration promotes concepts to their own row type
-- with hybrid AI/user authorship — modelled directly on the
-- lykn_beliefs shape (046 + 049) so the application layer (catalog,
-- promotion, dedup) can reuse the same patterns we already know.
--
-- Concepts vs beliefs:
--   • A belief is a normative principle ("Legacy tools are friction")
--     promoted from a cluster of facts and ratified by the user.
--   • A concept is a descriptive label for something the user cares
--     about ("fundraising", "tooling", "calm") that organises
--     everything around it. Concepts have no normative force; they
--     just give us a stable handle to join notes/facts/beliefs/chats.
--
-- Authorship model (hybrid):
--   • ai_clustered        — nightly job clustered chunks and named one
--   • user_authored       — user created in UI (free-form text)
--   • promoted_from_tag   — backfilled from notes.tags w/ count ≥ N
--   • promoted_from_theme — backfilled from profile.themes
--
-- Lifecycle:
--   • proposed — AI clustered, awaiting user dismiss/accept
--   • active   — promoted from theme/tag, user_authored, or accepted
--   • dismissed — user hid it; stays in DB so cluster re-mints don't
--                 keep reproposing it (the embedding dedup pass below
--                 looks at all rows regardless of status)
--
-- Merging:
--   • merged_into_id points at the concept that absorbed this one.
--     All queries should ignore rows where merged_into_id IS NOT NULL
--     OR follow the redirect (handled by the merge_concepts RPC in
--     058). Indexes are partial on (merged_into_id IS NULL) for the
--     hot path.

-- ---------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_concepts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Display name. Capped on insert by application; DB enforces a
  -- defensive max so a runaway client can't stuff a paragraph.
  label TEXT NOT NULL,

  -- Normalised dedup key. Application computes as
  -- lower(trim(unaccent(label))) but a plain lower(trim(...)) is fine
  -- for now; we don't require unaccent on the DB side.
  slug TEXT NOT NULL,

  -- 'theme' | 'topic' | 'entity'. theme = broad recurring motif
  -- (calm, design), topic = narrower subject matter (fundraising,
  -- climbing gym), entity = a specific noun (LYKN, Notion, Linear).
  -- Loose categorization for UI grouping; the application is free
  -- to add kinds later without migrating.
  kind TEXT NOT NULL DEFAULT 'topic'
    CHECK (kind IN ('theme', 'topic', 'entity')),

  -- Who wrote this row. See header for the four legitimate values.
  -- TEXT (not enum) so we can extend later without migrating, same
  -- as the lykn_beliefs.source choice in 046.
  source TEXT NOT NULL DEFAULT 'ai_clustered'
    CHECK (source IN (
      'ai_clustered',
      'user_authored',
      'promoted_from_tag',
      'promoted_from_theme'
    )),

  -- Lifecycle. See header for semantics.
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'active', 'dismissed')),

  -- 0.0–1.0 — same scale as lykn_beliefs.confidence. user_authored
  -- and promoted_from_* default to 1.0 (the user said this matters);
  -- ai_clustered defaults to 0.5 and is bumped by reinforcement.
  confidence REAL NOT NULL DEFAULT 0.5
    CHECK (confidence >= 0 AND confidence <= 1),

  -- text-embedding-3-small @ 1536d of the label, populated by
  -- lib/conceptEmbedding.js on insert/rename. Used for the
  -- "is this just another spelling of an existing concept?" dedup
  -- pass in the nightly job. Same dims / model as everything else
  -- (lykn_synthesis_chunks, lykn_user_model_facts, lykn_beliefs).
  embedding vector(1536),

  -- Machine-readable provenance payload. ai_clustered rows carry
  -- { source, cluster_id, chunk_count, model, run_id, generated_at };
  -- user_authored / promoted_from_* leave it as the default {}.
  -- JSONB so we can iterate freely without migrating.
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Merge redirect. Non-NULL means "this concept was merged into
  -- another"; queries should either follow the redirect or filter
  -- it out. The merge_concepts RPC (058) rewrites join rows and
  -- sets this in one transaction.
  merged_into_id UUID REFERENCES lykn_concepts(id) ON DELETE SET NULL,

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_touched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedded_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defensive width caps. Concept labels should stay tiny — a sentence
-- in a concept label is almost always a misuse.
ALTER TABLE lykn_concepts
  DROP CONSTRAINT IF EXISTS lykn_concepts_label_len_check;
ALTER TABLE lykn_concepts
  ADD CONSTRAINT lykn_concepts_label_len_check
  CHECK (length(label) > 0 AND length(label) <= 128);

ALTER TABLE lykn_concepts
  DROP CONSTRAINT IF EXISTS lykn_concepts_slug_len_check;
ALTER TABLE lykn_concepts
  ADD CONSTRAINT lykn_concepts_slug_len_check
  CHECK (length(slug) > 0 AND length(slug) <= 128);

-- ---------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------

-- Slug uniqueness scoped to the live (non-merged) rows for the user.
-- A merged-out concept keeps its row for audit but its slug is freed
-- so a future re-mint can reclaim it. Partial unique to avoid blocking
-- merge churn.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lykn_concepts_user_slug_live
  ON lykn_concepts (user_id, slug)
  WHERE merged_into_id IS NULL;

-- Hot path: list active/proposed concepts for the current user.
CREATE INDEX IF NOT EXISTS idx_lykn_concepts_user_status
  ON lykn_concepts (user_id, status, last_touched_at DESC)
  WHERE merged_into_id IS NULL;

-- Vector index for the synthesis job's dedup query and any future
-- "find concepts like this one" UI. Cosine ops match the embedding
-- model. lists=50 because concepts will be an order of magnitude
-- fewer rows than facts (same choice as lykn_beliefs in 049).
CREATE INDEX IF NOT EXISTS idx_lykn_concepts_embedding
  ON lykn_concepts
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 50);

-- Backfill helper: "concepts that still need an embedding."
CREATE INDEX IF NOT EXISTS idx_lykn_concepts_needs_embedding
  ON lykn_concepts (user_id, created_at)
  WHERE embedding IS NULL;

-- Merge audit lookup: "what was this concept merged into?"
CREATE INDEX IF NOT EXISTS idx_lykn_concepts_merged_into
  ON lykn_concepts (merged_into_id)
  WHERE merged_into_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
ALTER TABLE lykn_concepts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own concepts"
  ON lykn_concepts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own concepts"
  ON lykn_concepts FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own concepts"
  ON lykn_concepts FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own concepts"
  ON lykn_concepts FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 4. updated_at trigger
-- ---------------------------------------------------------------------
-- Keep updated_at honest without trusting application code. Same
-- pattern other lykn_* tables use (e.g. handled implicitly via
-- explicit set on update in catalog code; here we belt-and-suspender it).
CREATE OR REPLACE FUNCTION lykn_concepts_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lykn_concepts_updated_at ON lykn_concepts;
CREATE TRIGGER trg_lykn_concepts_updated_at
  BEFORE UPDATE ON lykn_concepts
  FOR EACH ROW
  EXECUTE FUNCTION lykn_concepts_touch_updated_at();

-- ---------------------------------------------------------------------
-- 5. Comments
-- ---------------------------------------------------------------------
COMMENT ON TABLE lykn_concepts IS
  'First-class concept/topic entities. Hybrid authorship — AI-clustered from chunk embeddings (source=ai_clustered), backfilled from profile.themes / notes.tags (source=promoted_from_*), or user-authored in UI. Joins to notes/facts/beliefs/chats via 057_concept_join_tables.';
COMMENT ON COLUMN lykn_concepts.slug IS
  'Normalised dedup key (lower(trim(label))). Unique per user across live (merged_into_id IS NULL) rows.';
COMMENT ON COLUMN lykn_concepts.source IS
  'ai_clustered (nightly job), user_authored (UI create), promoted_from_tag (backfilled from notes.tags), promoted_from_theme (backfilled from profile.themes).';
COMMENT ON COLUMN lykn_concepts.status IS
  'proposed (AI-named, awaiting user touch), active (in use), dismissed (user hid). Merges set merged_into_id rather than changing status.';
COMMENT ON COLUMN lykn_concepts.embedding IS
  'text-embedding-3-small @ 1536d of label. Populated by lib/conceptEmbedding.js; NULL until backfilled. Used for nightly dedup (cosine > 0.85 → attach to existing concept instead of minting new).';
COMMENT ON COLUMN lykn_concepts.provenance IS
  'Machine-readable provenance for ai_clustered rows: { source: "synthesis_job", cluster_id, chunk_count, model, run_id, generated_at }. user_authored / promoted_from_* leave as {}.';
COMMENT ON COLUMN lykn_concepts.merged_into_id IS
  'Pointer to the concept that absorbed this one. NULL = live concept. Application reads should filter or follow the redirect via the merge_concepts RPC in 058.';
