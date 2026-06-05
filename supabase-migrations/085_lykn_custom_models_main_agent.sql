-- ============================================================================
-- 085 — Main agent orchestration for custom models
-- ============================================================================
-- One main agent per user can delegate tasks to published sub-models and
-- receive structured reports back during in-app chat.

ALTER TABLE public.lykn_custom_models
  ADD COLUMN IF NOT EXISTS is_main_agent BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS lykn_custom_models_one_main_per_user
  ON public.lykn_custom_models (user_id)
  WHERE is_main_agent = true;

COMMENT ON COLUMN public.lykn_custom_models.is_main_agent IS
  'When true, this published model is the user''s main orchestrator — may delegate to sub_model_ids in metadata.';
