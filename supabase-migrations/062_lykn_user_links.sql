-- =====================================================================
-- 062 — lykn_user_links
-- =====================================================================
-- User-authored manual connections between any two nodes in the
-- synthesis layer. The synthesis layer already grows a dense web of
-- inferred edges (concept_links, belief→fact provenance, tag→note,
-- theme→note), but a user often "knows" two specific things are
-- connected in a way the inference passes can't see — e.g. a
-- perspective story tied to a particular belief, or a vault note tied
-- to a concept the embedding cluster never linked. This table stores
-- those explicit cross-neuron edges.
--
-- Shape — fully generic, not tied to a particular target table. We
-- store the synthesis-layer NODE IDs as text (not foreign keys),
-- because the graph contains derived nodes (`neuron_theme_<slug>`,
-- `vault_source_<app>`, …) that don't map to a single row. The
-- application layer (SynthesisLayer.tsx) is the source of truth for
-- how node IDs are minted; this table just records the pairs the user
-- explicitly linked.
--
-- Pair normalization — to make "A↔B" idempotent regardless of which
-- direction the user clicked first, we always store the pair with
-- `from_node_id <= to_node_id` (lexicographic). The unique constraint
-- then prevents duplicates without the application having to remember
-- which direction it inserted last time. The render layer treats the
-- edge as undirected.

CREATE TABLE IF NOT EXISTS lykn_user_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Synthesis-layer node IDs. Stored as text because they're a mix
  -- of UUIDs (belief / fact / concept / perspective node IDs are
  -- `<kind>_<row_uuid>`), tag-text-derived IDs (`tag_<text>`),
  -- connector-rollup IDs (`vault_source_<app>`), and theme-slug-
  -- derived IDs (`neuron_theme_<slug>`). All are stable across page
  -- reloads as long as the underlying row / slug still exists.
  --
  -- Pair is stored with from_node_id <= to_node_id (see header).
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  -- Optional short label the user typed when creating the link
  -- ("supports", "contradicts", "reminds me of", …). Free text for
  -- now; future iterations may promote common labels to an enum.
  label TEXT,
  -- Provenance: where this link came from. Currently always 'user'
  -- since the only writer is the explicit link-mode UI; reserved so
  -- a future suggestion pipeline (e.g. AI proposes a link, user
  -- accepts) can mark its output without changing the schema.
  source TEXT NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The CHECK enforces the lexicographic ordering invariant so any
  -- direct INSERTs (psql, scripts) that forget to normalize the pair
  -- fail loudly instead of silently breaking the dedup constraint.
  -- Self-links are also forbidden — they'd render as a zero-length
  -- edge and offer no information.
  CONSTRAINT lykn_user_links_ordered_pair CHECK (from_node_id < to_node_id),
  CONSTRAINT lykn_user_links_unique_pair UNIQUE (user_id, from_node_id, to_node_id)
);

CREATE INDEX IF NOT EXISTS idx_lykn_user_links_user_recent
  ON lykn_user_links (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lykn_user_links_from
  ON lykn_user_links (user_id, from_node_id);
CREATE INDEX IF NOT EXISTS idx_lykn_user_links_to
  ON lykn_user_links (user_id, to_node_id);

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
ALTER TABLE lykn_user_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own links" ON lykn_user_links;
CREATE POLICY "Users can read own links" ON lykn_user_links
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own links" ON lykn_user_links;
CREATE POLICY "Users can insert own links" ON lykn_user_links
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own links" ON lykn_user_links;
CREATE POLICY "Users can update own links" ON lykn_user_links
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own links" ON lykn_user_links;
CREATE POLICY "Users can delete own links" ON lykn_user_links
  FOR DELETE
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------
COMMENT ON TABLE lykn_user_links IS
  'User-authored manual connections between any two synthesis-layer nodes. Pairs are stored with from_node_id < to_node_id to make the undirected dedup constraint work without bookkeeping.';
COMMENT ON COLUMN lykn_user_links.from_node_id IS
  'Synthesis-layer node ID, stored as text. See SynthesisLayer.tsx::buildGraph for the ID conventions. Always the lexicographically smaller of the pair.';
COMMENT ON COLUMN lykn_user_links.to_node_id IS
  'Synthesis-layer node ID, stored as text. Always the lexicographically larger of the pair.';
COMMENT ON COLUMN lykn_user_links.label IS
  'Optional free-text relationship label the user typed at link time. NULL when the user left the label blank.';
