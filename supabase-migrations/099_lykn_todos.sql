-- ============================================================================
-- 099 — To-dos: a native task list the AI manages in text or voice mode
-- ============================================================================
-- A to-do is a user-owned row the LYKN assistant creates when the user says
-- "add X to my todo list", "I need to Y", "remind me later to Z (no time)".
-- It is the sibling of lykn_reminders (089) and lykn_events (094):
--   • a REMINDER is a point-in-time nudge (must have remind_at);
--   • an EVENT has a start + (optional) end and renders on the calendar grid;
--   • a TO-DO is an open task on a checklist — a due date is OPTIONAL, and the
--     point is the open/done lifecycle, not the clock.
--
-- The AI adds / lists / completes / reorders / removes these via the
-- lykn_createTodo / listTodos / updateTodo / deleteTodo tools (text + voice),
-- and the user sees + checks them off in the to-do pop-up UI.
--
-- Realtime is enabled (mirrors 094) so the pop-up reflects AI/voice writes
-- live, without a manual refresh.

CREATE TABLE IF NOT EXISTS public.lykn_todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The task itself, phrased as the to-do ("Email Sam the contract").
  title TEXT NOT NULL CHECK (length(trim(title)) >= 1 AND length(title) <= 280),
  -- Optional longer detail / context / sub-steps.
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
  -- Lifecycle: open (default) → completed | cancelled. Completed/cancelled
  -- rows are hidden from the default list but kept for history / undo.
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'completed', 'cancelled')),
  -- Soft priority hint for ordering + UI emphasis.
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high')),
  -- OPTIONAL soft due date (stored UTC). Unlike a reminder, a to-do can have
  -- no due date at all; when present the AI resolves relative phrasing
  -- ("by Friday") to an absolute instant before insert.
  due_at TIMESTAMPTZ,
  -- The user's own phrasing of the due date, kept verbatim for natural
  -- read-back ("by end of week") so the UI/briefing doesn't reformat it.
  due_at_text TEXT CHECK (due_at_text IS NULL OR length(due_at_text) <= 200),
  -- Manual ordering within the list (lower = higher up). The UI sets this on
  -- drag; the AI generally leaves it null and relies on priority + due_at.
  position DOUBLE PRECISION,
  -- Optional link to the project the to-do came out of.
  project_id UUID REFERENCES public.lykn_projects(id) ON DELETE SET NULL,
  -- Attribution: which surface created it (lykn-chat-agent:lykn-chat,
  -- lykn-chat-agent:voice, mcp:claude-desktop, todos-ui, …).
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Primary access pattern: "this user's open to-dos" (list tool + UI). Partial
-- index keeps it tight as completed/cancelled rows accumulate.
CREATE INDEX IF NOT EXISTS lykn_todos_user_open_idx
  ON public.lykn_todos (user_id, position, created_at)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS lykn_todos_user_status_idx
  ON public.lykn_todos (user_id, status, created_at DESC);

ALTER TABLE public.lykn_todos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_todos_select_own ON public.lykn_todos;
CREATE POLICY lykn_todos_select_own
  ON public.lykn_todos FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_todos_insert_own ON public.lykn_todos;
CREATE POLICY lykn_todos_insert_own
  ON public.lykn_todos FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_todos_update_own ON public.lykn_todos;
CREATE POLICY lykn_todos_update_own
  ON public.lykn_todos FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_todos_delete_own ON public.lykn_todos;
CREATE POLICY lykn_todos_delete_own
  ON public.lykn_todos FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Realtime so the to-do pop-up reflects AI/voice writes live (mirrors 094).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_todos'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_todos';
  END IF;
END $$;

ALTER TABLE public.lykn_todos REPLICA IDENTITY FULL;

COMMENT ON TABLE public.lykn_todos IS
  'Native LYKN to-do list the AI manages in text or voice mode and the user checks off in the to-do pop-up. Realtime-enabled (see 094). Sibling of lykn_reminders (089) and lykn_events (094): tasks with an open/done lifecycle and an OPTIONAL due date.';
