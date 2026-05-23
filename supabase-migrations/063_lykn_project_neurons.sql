-- =====================================================================
-- 063 — lykn_project_neurons
-- =====================================================================
-- User-authored "project clusters" — a project is a named bag of
-- synthesis-layer neurons the user explicitly grouped together. The
-- existing `lykn_projects` table (045) was originally an AI-driven
-- working-memory tier (Claude/Cursor pushing decisions via MCP). This
-- migration adds the *user-driven* dimension: from the synthesis
-- layer's "+" menu the user can lasso a handful of neurons and bind
-- them into a project the AI can then "see" in its context block.
--
-- Why a separate join table (instead of stuffing node_ids into
-- lykn_projects.description or a JSON column):
--   • Synthesis-layer node IDs are heterogeneous text (`belief_<uuid>`,
--     `tag_<text>`, `neuron_theme_<slug>`, `vault_source_<app>`, …).
--     They don't map to a single foreign-key target, but they ARE
--     stable across reloads — a TEXT column with a UNIQUE constraint
--     gives us idempotent membership without bookkeeping.
--   • We snapshot the node's `label` and `kind` at cluster time so
--     the MCP tools that ship project context to outside AI clients
--     don't have to resolve graph IDs back to the underlying tables.
--     The label on the underlying record may drift later (the user
--     renames a belief, a fact gets edited), but the cluster
--     membership stays meaningful: "the user grouped THIS thing
--     here on this date" is the durable fact.
--   • Per-row provenance + timestamp gives the "what was in this
--     project on Tuesday vs. Wednesday" audit trail for free.
--
-- The application layer (SynthesisLayer.tsx) creates the
-- `lykn_projects` row first (status='active', created_by_client=
-- 'lykn-synthesis') and then inserts one row per selected neuron
-- here. Removal is a hard delete by (project_id, node_id).

CREATE TABLE IF NOT EXISTS lykn_project_neurons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES lykn_projects(id) ON DELETE CASCADE,
  -- Synthesis-layer node ID, stored as TEXT for the same reasons
  -- lykn_user_links does it (062) — heterogeneous origins, but
  -- stable across reloads. See SynthesisLayer.tsx::buildGraph for
  -- the full ID conventions.
  node_id TEXT NOT NULL,
  -- Snapshot of the node's display label at cluster time. Lets
  -- read-side consumers (MCP tools, dashboards) render the cluster
  -- without having to resolve every node_id back to its source
  -- table. The label may be re-fetched live by the UI when the
  -- user opens the cluster, but for AI context the snapshot is
  -- both faster and more honest about "what the user thought they
  -- were grouping on this date."
  node_label TEXT,
  -- Snapshot of node kind ('belief' | 'concept' | 'vault' |
  -- 'perspective' | 'grid' | 'tag' | 'neuron' | …). Same rationale
  -- as `node_label` — frozen at cluster time so the AI sees the
  -- shape the user clustered, not whatever the graph mints today.
  node_kind TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotent membership: re-running the cluster save with the
  -- same selection doesn't double-insert.
  CONSTRAINT lykn_project_neurons_unique
    UNIQUE (user_id, project_id, node_id)
);

-- Hot path: fetch all members of a given project, ordered by when
-- the user added them (the cluster builds in selection order).
CREATE INDEX IF NOT EXISTS idx_lykn_project_neurons_project
  ON lykn_project_neurons (user_id, project_id, created_at);
-- Reverse lookup: "which projects does this neuron belong to?"
-- Used by the synthesis layer to badge neurons that are clustered.
CREATE INDEX IF NOT EXISTS idx_lykn_project_neurons_node
  ON lykn_project_neurons (user_id, node_id);

-- ---------------------------------------------------------------------
-- RLS — same shape as lykn_user_links (062). All writes are scoped to
-- auth.uid(); cross-user reads are forbidden.
-- ---------------------------------------------------------------------
ALTER TABLE lykn_project_neurons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own project neurons" ON lykn_project_neurons;
CREATE POLICY "Users read own project neurons" ON lykn_project_neurons
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users insert own project neurons" ON lykn_project_neurons;
CREATE POLICY "Users insert own project neurons" ON lykn_project_neurons
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own project neurons" ON lykn_project_neurons;
CREATE POLICY "Users update own project neurons" ON lykn_project_neurons
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users delete own project neurons" ON lykn_project_neurons;
CREATE POLICY "Users delete own project neurons" ON lykn_project_neurons
  FOR DELETE
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------
COMMENT ON TABLE lykn_project_neurons IS
  'Membership rows binding synthesis-layer neurons to a lykn_projects row. Created by the user via the synthesis "+" menu → "Create project" cluster flow. Snapshots label+kind at cluster time so MCP context surfaces stay consistent even when the underlying node mutates.';
COMMENT ON COLUMN lykn_project_neurons.node_id IS
  'Synthesis-layer node ID (text, heterogeneous origins). See SynthesisLayer.tsx::buildGraph for ID conventions; same approach as lykn_user_links.from_node_id.';
COMMENT ON COLUMN lykn_project_neurons.node_label IS
  'Display label snapshot at cluster time. Frozen — the underlying record may be renamed later without touching this row.';
COMMENT ON COLUMN lykn_project_neurons.node_kind IS
  'Node kind snapshot at cluster time (belief | concept | vault | perspective | grid | tag | neuron | …).';
