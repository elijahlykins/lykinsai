-- ============================================================================
-- 080 — lykn_chat_agents: per-agent external app connections
-- ============================================================================

ALTER TABLE public.lykn_chat_agents
  ADD COLUMN IF NOT EXISTS connected_integration_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.lykn_chat_agents.connected_integration_ids IS
  'App ids from Agent Builder catalog (e.g. ai:cursor, input:notion) this agent is wired to use.';
