-- ============================================================================
-- 075 — Main chat surface (replaces legacy "grid" label on conversation memory)
-- ============================================================================
-- /app chat is no longer the Omnia grid canvas; stored exchanges should use
-- surface = 'chat'. Existing grid-tagged rows are backfilled for training export.

ALTER TABLE ai_conversation_memory
  DROP CONSTRAINT IF EXISTS ai_conversation_memory_surface_check;

ALTER TABLE ai_conversation_memory
  ADD CONSTRAINT ai_conversation_memory_surface_check
  CHECK (surface IN ('chat', 'grid', 'project', 'vault'));

COMMENT ON COLUMN ai_conversation_memory.surface IS
  'chat = main /app chat; grid = legacy label (backfilled to chat); project; vault (deprecated UI)';

UPDATE ai_conversation_memory
SET surface = 'chat'
WHERE surface = 'grid';
