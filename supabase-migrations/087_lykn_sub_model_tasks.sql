-- ============================================================================
-- 087 — Background sub-model delegation tasks (main agent orchestration)
-- ============================================================================
-- Main agents delegate work to sub-models asynchronously. Tasks run in the
-- background so the user can keep chatting while sub-agents work in parallel.

CREATE TABLE IF NOT EXISTS public.lykn_sub_model_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  main_model_id UUID NOT NULL REFERENCES public.lykn_custom_models(id) ON DELETE CASCADE,
  sub_model_id UUID NOT NULL REFERENCES public.lykn_custom_models(id) ON DELETE CASCADE,
  board_id UUID REFERENCES public.omnia_boards(id) ON DELETE SET NULL,

  sub_model_name TEXT NOT NULL DEFAULT '',
  task_instruction TEXT NOT NULL CHECK (length(trim(task_instruction)) >= 1),
  context TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  report TEXT,
  error_message TEXT,

  main_notified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lykn_sub_model_tasks_user_status_idx
  ON public.lykn_sub_model_tasks (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS lykn_sub_model_tasks_board_idx
  ON public.lykn_sub_model_tasks (board_id, created_at DESC)
  WHERE board_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lykn_sub_model_tasks_main_pending_idx
  ON public.lykn_sub_model_tasks (user_id, main_model_id, created_at DESC)
  WHERE status IN ('pending', 'running');

ALTER TABLE public.lykn_sub_model_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_sub_model_tasks_select_own ON public.lykn_sub_model_tasks;
CREATE POLICY lykn_sub_model_tasks_select_own
  ON public.lykn_sub_model_tasks FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_sub_model_tasks_insert_own ON public.lykn_sub_model_tasks;
CREATE POLICY lykn_sub_model_tasks_insert_own
  ON public.lykn_sub_model_tasks FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_sub_model_tasks_update_own ON public.lykn_sub_model_tasks;
CREATE POLICY lykn_sub_model_tasks_update_own
  ON public.lykn_sub_model_tasks FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_sub_model_tasks_delete_own ON public.lykn_sub_model_tasks;
CREATE POLICY lykn_sub_model_tasks_delete_own
  ON public.lykn_sub_model_tasks FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_sub_model_tasks IS
  'Async sub-model work delegated by a main agent. Realtime-enabled for live status in chat.';

-- Realtime (mirror 048 / 086)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_sub_model_tasks'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_sub_model_tasks';
  END IF;
END $$;

ALTER TABLE public.lykn_sub_model_tasks REPLICA IDENTITY FULL;
