-- ============================================================================
-- 074 — lykn_training_sets: async training corpus generation jobs
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.lykn_training_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'ready', 'failed')),

  vault_source TEXT,
  model_used TEXT,
  error_message TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  jsonl_content TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lykn_training_sets_user_created_idx
  ON public.lykn_training_sets (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS lykn_training_sets_user_status_idx
  ON public.lykn_training_sets (user_id, status);

ALTER TABLE public.lykn_training_sets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_training_sets_select_own ON public.lykn_training_sets;
CREATE POLICY lykn_training_sets_select_own
  ON public.lykn_training_sets
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_training_sets IS
  'Async jobs that assemble prompt/response JSONL training corpora from synthesis + vault.';
