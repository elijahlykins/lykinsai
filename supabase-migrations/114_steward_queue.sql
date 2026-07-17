-- =====================================================================
-- 114 — Night Shift steward queue (Phase 1: triage + research)
-- =====================================================================
-- Kanban-style overnight work items per project. Night Shift cron triages
-- backlog → ready, executes scheduled items (vault + optional web research),
-- and writes overnight_progress / subtasks.

CREATE TABLE IF NOT EXISTS public.lykn_steward_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL DEFAULT 'cron',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  items_triaged INT NOT NULL DEFAULT 0,
  items_executed INT NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lykn_steward_runs_user_started_idx
  ON public.lykn_steward_runs (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS public.lykn_steward_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.lykn_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) >= 1 AND length(title) <= 280),
  spec TEXT CHECK (spec IS NULL OR length(spec) <= 4000),
  status TEXT NOT NULL DEFAULT 'backlog'
    CHECK (status IN ('backlog', 'ready', 'scheduled', 'running', 'done', 'blocked', 'cancelled')),
  result_summary TEXT CHECK (result_summary IS NULL OR length(result_summary) <= 4000),
  blocked_reason TEXT CHECK (blocked_reason IS NULL OR length(blocked_reason) <= 500),
  source TEXT,
  approved_at TIMESTAMPTZ,
  run_id UUID REFERENCES public.lykn_steward_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lykn_steward_items_project_status_idx
  ON public.lykn_steward_items (user_id, project_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS lykn_steward_items_scheduled_idx
  ON public.lykn_steward_items (user_id, status, updated_at DESC)
  WHERE status = 'scheduled';

ALTER TABLE public.lykn_steward_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_steward_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_steward_runs_select_own ON public.lykn_steward_runs;
CREATE POLICY lykn_steward_runs_select_own
  ON public.lykn_steward_runs FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_steward_items_select_own ON public.lykn_steward_items;
CREATE POLICY lykn_steward_items_select_own
  ON public.lykn_steward_items FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_steward_items_insert_own ON public.lykn_steward_items;
CREATE POLICY lykn_steward_items_insert_own
  ON public.lykn_steward_items FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_steward_items_update_own ON public.lykn_steward_items;
CREATE POLICY lykn_steward_items_update_own
  ON public.lykn_steward_items FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_steward_items_delete_own ON public.lykn_steward_items;
CREATE POLICY lykn_steward_items_delete_own
  ON public.lykn_steward_items FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.touch_lykn_steward_items_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lykn_steward_items_touch ON public.lykn_steward_items;
CREATE TRIGGER trg_lykn_steward_items_touch
  BEFORE UPDATE ON public.lykn_steward_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_lykn_steward_items_updated_at();

ALTER TABLE public.lykn_user_preferences
  ADD COLUMN IF NOT EXISTS night_shift_tier TEXT NOT NULL DEFAULT 'brief'
    CHECK (night_shift_tier IN ('brief', 'research'));

COMMENT ON COLUMN public.lykn_user_preferences.night_shift_tier IS
  'brief = morning handoff only; research = also triage steward queue + run scheduled items overnight.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_steward_items'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_steward_items';
  END IF;
END $$;

ALTER TABLE public.lykn_steward_items REPLICA IDENTITY FULL;

COMMENT ON TABLE public.lykn_steward_items IS
  'Night Shift Kanban queue — backlog ideas triaged overnight into ready specs, then executed when scheduled.';
