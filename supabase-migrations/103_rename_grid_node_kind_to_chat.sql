-- ============================================================================
-- Rename the "grid" synthesis node-kind -> "chat"
-- Migration: 103_rename_grid_node_kind_to_chat.sql
-- ============================================================================
--
-- Final leg of the Omnia/grid/board -> LYKNChat rename. The synthesis graph
-- tags each chat node with kind "grid". When a user clusters a chat node into
-- a named project, that kind is persisted to lykn_project_neurons.node_kind
-- (free TEXT, no CHECK — see 063). The client now produces / reads "chat", so
-- this backfills the persisted rows to match.
--
-- The only "grid" producer for node_kind was the chat-node builder; "vault",
-- "belief", "project", etc. are untouched. node_kind has no CHECK constraint,
-- so there is nothing to ALTER — a plain UPDATE is sufficient and safe.
--
-- COORDINATION: harmless to apply before or after the client deploy. Pre-deploy
-- old clients would re-introduce stray 'grid' values, but node_kind is free
-- text and consumers simply ignore unknown kinds, so there is no breakage —
-- re-run this after deploy if you want the backfill to be exhaustive.
-- Idempotent + re-runnable.
-- ============================================================================

BEGIN;

UPDATE public.lykn_project_neurons
   SET node_kind = 'chat'
 WHERE node_kind = 'grid';

COMMENT ON COLUMN public.lykn_project_neurons.node_kind IS
  'Synthesis graph node kind snapshot (chat | vault | belief | concept | fact | perspective | project). "chat" was historically "grid".';

NOTIFY pgrst, 'reload schema';

COMMIT;
