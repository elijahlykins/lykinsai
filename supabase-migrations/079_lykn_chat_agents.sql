-- ============================================================================
-- 079 — lykn_chat_agents: user-defined LYKN chat agents (tools + mission)
-- ============================================================================
-- Separate from lykn_custom_models (persona/weights) and lykn_custom_agents
-- (outbound webhooks). Each row is an in-app agent profile: optional custom
-- model brain, tool whitelist, and instructions for /api/ai/stream.

CREATE TABLE IF NOT EXISTS public.lykn_chat_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  description TEXT,

  custom_model_id UUID REFERENCES public.lykn_custom_models(id) ON DELETE SET NULL,

  instructions TEXT NOT NULL DEFAULT '',

  chat_tools_enabled BOOLEAN NOT NULL DEFAULT true,
  chat_tool_names JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_chat_agents_user_updated_idx
  ON public.lykn_chat_agents (user_id, updated_at DESC);

ALTER TABLE public.lykn_chat_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_chat_agents_select_own ON public.lykn_chat_agents;
CREATE POLICY lykn_chat_agents_select_own
  ON public.lykn_chat_agents FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_chat_agents_insert_own ON public.lykn_chat_agents;
CREATE POLICY lykn_chat_agents_insert_own
  ON public.lykn_chat_agents FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_chat_agents_update_own ON public.lykn_chat_agents;
CREATE POLICY lykn_chat_agents_update_own
  ON public.lykn_chat_agents FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_chat_agents_delete_own ON public.lykn_chat_agents;
CREATE POLICY lykn_chat_agents_delete_own
  ON public.lykn_chat_agents FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_chat_agents IS
  'In-app LYKN chat agents: tool whitelist + mission, optional custom model brain.';
