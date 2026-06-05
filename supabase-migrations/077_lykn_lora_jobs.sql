-- ============================================================================
-- 077 — lykn_lora_jobs: Together AI LoRA fine-tune jobs for custom models
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.lykn_lora_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  custom_model_id UUID NOT NULL REFERENCES public.lykn_custom_models(id) ON DELETE CASCADE,
  training_set_id UUID NOT NULL REFERENCES public.lykn_training_sets(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'uploading', 'running', 'ready', 'failed', 'cancelled')),

  provider TEXT NOT NULL DEFAULT 'together',
  external_job_id TEXT,
  together_file_id TEXT,
  output_model_id TEXT,

  base_together_model TEXT NOT NULL,
  epochs INTEGER NOT NULL DEFAULT 3 CHECK (epochs BETWEEN 1 AND 20),

  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lykn_lora_jobs_model_created_idx
  ON public.lykn_lora_jobs (custom_model_id, created_at DESC);

CREATE INDEX IF NOT EXISTS lykn_lora_jobs_user_status_idx
  ON public.lykn_lora_jobs (user_id, status);

ALTER TABLE public.lykn_lora_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_lora_jobs_select_own ON public.lykn_lora_jobs;
CREATE POLICY lykn_lora_jobs_select_own
  ON public.lykn_lora_jobs FOR SELECT TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_lora_jobs IS
  'Async LoRA fine-tune jobs (Together AI) for published Model Builder configs.';
