-- ============================================================================
-- 081 — lykn_chat_agents: per-agent runtime LLM selection
-- ============================================================================

ALTER TABLE public.lykn_chat_agents
  ADD COLUMN IF NOT EXISTS runtime_model_id TEXT NOT NULL DEFAULT 'lykn';

COMMENT ON COLUMN public.lykn_chat_agents.runtime_model_id IS
  'Model id for /api/ai/stream when running this agent (frontier or budget tier).';
