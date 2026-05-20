-- =====================================================================
-- 057 — concept_* join tables
-- =====================================================================
-- The four cross-cutting joins that let concepts (056) become the
-- glue between everything else in the synthesis layer:
--
--   concept_notes   — concept ↔ notes
--   concept_facts   — concept ↔ lykn_user_model_facts
--   concept_beliefs — concept ↔ lykn_beliefs
--   concept_chats   — concept ↔ omnia_boards
--
-- All four follow the same shape so the application catalog and the
-- merge_concepts RPC (058) can iterate them with a single loop.
--
-- Shape:
--   (user_id, concept_id, <target>_id) unique — one row per pair.
--   weight  — 0.0–1.0; how strongly this concept covers this target.
--             For chunk_cluster links, weight = cosine similarity
--             of the chunk's embedding to the concept's embedding.
--             For tag/theme links, weight = 1.0 (explicit).
--   source  — provenance: where this link came from. Loose TEXT so
--             the catalog can add sources without migrating.
--             Conventional values:
--               'tag'                — link came from notes.tags
--               'ai_signal_theme'    — link came from notes.ai_signals.themes
--               'chunk_cluster'      — nightly clustering job
--               'embedding_similarity' — direct label↔text cosine
--               'inherited_from_fact'  — belief inherited via its
--                                        promoted_from_facts membership
--               'user'               — explicit user link in UI
--
-- ON CONFLICT semantics: an UPSERT bumps weight to the max of the
-- existing and incoming weight, and rewrites `source` to the newer
-- (typically stronger) signal. The application layer is responsible
-- for that — the constraint here just ensures the pair is unique.
--
-- All four cascade on concept_id delete (concept gone → links gone)
-- and on the target table's delete (note/fact/belief/board gone →
-- links gone). user_id is duplicated on the row for RLS and for
-- cheap "all my concept links" rollups without a join.

-- ---------------------------------------------------------------------
-- 1. concept_notes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS concept_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES lykn_concepts(id) ON DELETE CASCADE,
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  source TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT concept_notes_unique_pair UNIQUE (user_id, concept_id, note_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_notes_concept
  ON concept_notes (concept_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_concept_notes_note
  ON concept_notes (note_id);
CREATE INDEX IF NOT EXISTS idx_concept_notes_user_recent
  ON concept_notes (user_id, created_at DESC);

ALTER TABLE concept_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own concept_notes"
  ON concept_notes FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own concept_notes"
  ON concept_notes FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own concept_notes"
  ON concept_notes FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own concept_notes"
  ON concept_notes FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 2. concept_facts
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS concept_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES lykn_concepts(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES lykn_user_model_facts(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  source TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT concept_facts_unique_pair UNIQUE (user_id, concept_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_facts_concept
  ON concept_facts (concept_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_concept_facts_fact
  ON concept_facts (fact_id);
CREATE INDEX IF NOT EXISTS idx_concept_facts_user_recent
  ON concept_facts (user_id, created_at DESC);

ALTER TABLE concept_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own concept_facts"
  ON concept_facts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own concept_facts"
  ON concept_facts FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own concept_facts"
  ON concept_facts FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own concept_facts"
  ON concept_facts FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 3. concept_beliefs
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS concept_beliefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES lykn_concepts(id) ON DELETE CASCADE,
  belief_id UUID NOT NULL REFERENCES lykn_beliefs(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  source TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT concept_beliefs_unique_pair UNIQUE (user_id, concept_id, belief_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_beliefs_concept
  ON concept_beliefs (concept_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_concept_beliefs_belief
  ON concept_beliefs (belief_id);
CREATE INDEX IF NOT EXISTS idx_concept_beliefs_user_recent
  ON concept_beliefs (user_id, created_at DESC);

ALTER TABLE concept_beliefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own concept_beliefs"
  ON concept_beliefs FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own concept_beliefs"
  ON concept_beliefs FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own concept_beliefs"
  ON concept_beliefs FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own concept_beliefs"
  ON concept_beliefs FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 4. concept_chats — concept ↔ omnia_boards
-- ---------------------------------------------------------------------
-- omnia_boards is the chat surface; one row per board. There is no
-- per-message table (board content lives in omnia_board_states.state
-- JSONB), so concept_chats links at board granularity only.
CREATE TABLE IF NOT EXISTS concept_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES lykn_concepts(id) ON DELETE CASCADE,
  board_id UUID NOT NULL REFERENCES omnia_boards(id) ON DELETE CASCADE,
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight >= 0 AND weight <= 1),
  source TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT concept_chats_unique_pair UNIQUE (user_id, concept_id, board_id)
);

CREATE INDEX IF NOT EXISTS idx_concept_chats_concept
  ON concept_chats (concept_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_concept_chats_board
  ON concept_chats (board_id);
CREATE INDEX IF NOT EXISTS idx_concept_chats_user_recent
  ON concept_chats (user_id, created_at DESC);

ALTER TABLE concept_chats ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own concept_chats"
  ON concept_chats FOR SELECT TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users insert own concept_chats"
  ON concept_chats FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own concept_chats"
  ON concept_chats FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users delete own concept_chats"
  ON concept_chats FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- 5. Comments
-- ---------------------------------------------------------------------
COMMENT ON TABLE concept_notes IS
  'Concept ↔ note links. Sources: tag (notes.tags), ai_signal_theme (notes.ai_signals.themes), chunk_cluster (nightly job), embedding_similarity, user.';
COMMENT ON TABLE concept_facts IS
  'Concept ↔ fact links. Sources: chunk_cluster, embedding_similarity, user.';
COMMENT ON TABLE concept_beliefs IS
  'Concept ↔ belief links. Sources: inherited_from_fact (belief whose promoted_from_facts has a concept_facts row), embedding_similarity, user.';
COMMENT ON TABLE concept_chats IS
  'Concept ↔ omnia_board links. Sources: chunk_cluster (board chunks in cluster), embedding_similarity, user. Board granularity only — no per-message table.';
