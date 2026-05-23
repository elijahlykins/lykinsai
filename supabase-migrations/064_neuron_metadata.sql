-- =====================================================================
-- 064 — neuron metadata jsonb
-- =====================================================================
-- The synthesis-layer "+" composer was refactored into a unified panel
-- that collects the same five fields for every neuron the user creates:
--
--     Title           → the existing primary text column per table
--                       (lykn_beliefs.belief_text, lykn_facts.fact_text,
--                        lykn_concepts.label)
--     Why             → for beliefs this lands in `rationale` (existing
--                       column); for facts + concepts it lands in
--                       metadata.why (no existing column)
--     Story           → long-form body the user can attach to ANY
--                       neuron kind; no existing column on any of the
--                       three tables → metadata.story
--     Connections     → handled by lykn_user_links (migration 062),
--                       NOT stored in metadata
--     Additional info → free-form notes textarea → metadata.notes
--
-- Rather than mint three more typed columns per table (and then a
-- fourth, fifth, … the next time we add a field), we attach a single
-- `metadata jsonb` blob to each of the three neuron tables. New shape:
--
--     metadata jsonb NOT NULL DEFAULT '{}'::jsonb
--
-- The application layer treats the blob as a free-form bag of optional
-- fields keyed by name. Today we read/write `story`, `notes`, and (on
-- facts + concepts) `why`. The composer never blocks on schema for
-- future additions — new fields just become new keys.
--
-- jsonb (not json) so we get the GIN-index option later if any field
-- ever needs to be queried at scale (e.g. "facts whose metadata.notes
-- contain X"). Default '{}'::jsonb means every existing row reads as
-- "no extra metadata" without a backfill — the column is logically a
-- shallow merge over the typed columns.
--
-- The `notes` table (which backs Perspective neurons) intentionally
-- does NOT get a metadata column in this migration. Perspectives
-- already store their full long-form body in `notes.content`, so the
-- new `story` field maps cleanly onto that existing column without a
-- schema change. If we later want `why` / additional `notes` on
-- perspective rows, a follow-up migration can add it; that table is
-- the largest of the four (user clips, connector syncs, etc.) so we
-- want a separate, dedicated migration with explicit review.

ALTER TABLE lykn_beliefs
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Facts live in `lykn_user_model_facts` (migration 039). The column
-- name is verbose but stable; renaming would cascade through the
-- chat reconciler + synthesis profile + every MCP client.
ALTER TABLE lykn_user_model_facts
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE lykn_concepts
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Documentation comments — surfaces in any schema browser so future
-- contributors don't have to grep the migration to know what the blob
-- carries. We intentionally enumerate the application-layer keys here
-- rather than committing to a CHECK constraint; the composer is still
-- evolving and locking the shape in SQL would slow that iteration.
COMMENT ON COLUMN lykn_beliefs.metadata IS
  'Composer-supplied extras: { story?: text long-form body, notes?: text free-form additional info }. Why is stored in the existing rationale column; story/notes have no typed column. Defaults to empty object.';

COMMENT ON COLUMN lykn_user_model_facts.metadata IS
  'Composer-supplied extras: { why?: text rationale, story?: text long-form body, notes?: text free-form additional info }. Defaults to empty object.';

COMMENT ON COLUMN lykn_concepts.metadata IS
  'Composer-supplied extras: { why?: text rationale, story?: text long-form body, notes?: text free-form additional info }. Defaults to empty object.';
