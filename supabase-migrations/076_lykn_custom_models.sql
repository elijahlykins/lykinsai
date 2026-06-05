-- ============================================================================
-- 076 — lykn_custom_models: persisted Model Builder configurations
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.lykn_custom_models (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published')),

  base_kind TEXT NOT NULL DEFAULT 'standard'
    CHECK (base_kind IN ('standard', 'open_source')),
  base_model_id TEXT NOT NULL,

  system_prompt TEXT NOT NULL DEFAULT '',
  beliefs JSONB NOT NULL DEFAULT '[]'::jsonb,
  rules JSONB NOT NULL DEFAULT '[]'::jsonb,

  vault_source TEXT NOT NULL DEFAULT 'synthesis',
  training_mode TEXT NOT NULL DEFAULT 'prompt_only'
    CHECK (training_mode IN ('prompt_only', 'lora', 'full')),
  training_epochs INTEGER NOT NULL DEFAULT 3
    CHECK (training_epochs BETWEEN 1 AND 20),
  include_chats BOOLEAN NOT NULL DEFAULT false,
  placed_blocks JSONB NOT NULL DEFAULT '[]'::jsonb,

  training_set_id UUID REFERENCES public.lykn_training_sets(id) ON DELETE SET NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lykn_custom_models_user_updated_idx
  ON public.lykn_custom_models (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS lykn_custom_models_user_status_idx
  ON public.lykn_custom_models (user_id, status);

ALTER TABLE public.lykn_custom_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_custom_models_select_own ON public.lykn_custom_models;
CREATE POLICY lykn_custom_models_select_own
  ON public.lykn_custom_models FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_custom_models_insert_own ON public.lykn_custom_models;
CREATE POLICY lykn_custom_models_insert_own
  ON public.lykn_custom_models FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_custom_models_update_own ON public.lykn_custom_models;
CREATE POLICY lykn_custom_models_update_own
  ON public.lykn_custom_models FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_custom_models_delete_own ON public.lykn_custom_models;
CREATE POLICY lykn_custom_models_delete_own
  ON public.lykn_custom_models FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_custom_models IS
  'User-assembled custom models from Model Builder (prompt stack + optional training set link).';
