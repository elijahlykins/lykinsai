-- =====================================================================
-- 115 — Night Shift Phase 3: delegate to Cursor builds + sub-agents
-- =====================================================================
-- Steward items can be classified as research (sync overnight), code
-- (async Cursor cloud agent), or agent (async sub-model task).

ALTER TABLE public.lykn_steward_items
  ADD COLUMN IF NOT EXISTS execution_kind TEXT NOT NULL DEFAULT 'research'
    CHECK (execution_kind IN ('research', 'code', 'agent')),
  ADD COLUMN IF NOT EXISTS repo TEXT CHECK (repo IS NULL OR length(repo) <= 500),
  ADD COLUMN IF NOT EXISTS sub_model_id UUID,
  ADD COLUMN IF NOT EXISTS cursor_build_id UUID REFERENCES public.lykn_cursor_builds(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sub_model_task_id UUID REFERENCES public.lykn_sub_model_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lykn_steward_items_running_delegate_idx
  ON public.lykn_steward_items (user_id, status, updated_at DESC)
  WHERE status = 'running';

ALTER TABLE public.lykn_steward_runs
  ADD COLUMN IF NOT EXISTS items_delegated INT NOT NULL DEFAULT 0;

ALTER TABLE public.lykn_cursor_builds
  ADD COLUMN IF NOT EXISTS steward_item_id UUID REFERENCES public.lykn_steward_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lykn_cursor_builds_steward_item_idx
  ON public.lykn_cursor_builds (steward_item_id)
  WHERE steward_item_id IS NOT NULL;

ALTER TABLE public.lykn_sub_model_tasks
  ADD COLUMN IF NOT EXISTS steward_item_id UUID REFERENCES public.lykn_steward_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lykn_sub_model_tasks_steward_item_idx
  ON public.lykn_sub_model_tasks (steward_item_id)
  WHERE steward_item_id IS NOT NULL;

-- Extend night_shift_tier to include full delegate mode.
ALTER TABLE public.lykn_user_preferences
  DROP CONSTRAINT IF EXISTS lykn_user_preferences_night_shift_tier_check;

ALTER TABLE public.lykn_user_preferences
  ADD CONSTRAINT lykn_user_preferences_night_shift_tier_check
    CHECK (night_shift_tier IN ('brief', 'research', 'delegate'));

COMMENT ON COLUMN public.lykn_steward_items.execution_kind IS
  'research = vault/web overnight report; code = Cursor build; agent = sub-model task.';
COMMENT ON COLUMN public.lykn_user_preferences.night_shift_tier IS
  'brief = morning handoff; research = triage + sync research; delegate = also Cursor builds + sub-agents.';
