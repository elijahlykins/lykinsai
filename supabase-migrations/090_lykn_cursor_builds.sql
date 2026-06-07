-- ============================================================================
-- 090 — Cursor cloud-agent builds dispatched by the LYKN agent
-- ============================================================================
-- The LYKN voice/text agent can hand a coding task to a Cursor CLOUD AGENT
-- (via lykn_build_with_cursor). The build runs async on a Cursor-hosted VM,
-- works against the allowlisted repo, and opens a PR. We track each build here
-- so the server poller can detect completion, the agent can report status
-- (lykn_check_cursor_build), and the next voice briefing can proactively tell
-- the user "Cursor finished X — ready for testing".
--
-- announced_at is the "the user has been told it finished" marker, mirroring how
-- reminders are surfaced pull-based: NULL = not yet announced in a briefing.

CREATE TABLE IF NOT EXISTS public.lykn_cursor_builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES public.lykn_projects(id) ON DELETE SET NULL,

  instruction TEXT NOT NULL CHECK (length(trim(instruction)) >= 1),
  repo TEXT NOT NULL,

  -- Cursor cloud-agent identifiers (bc-... agent, run-... run) + dashboard URL.
  agent_id TEXT,
  run_id TEXT,
  agent_url TEXT,

  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  pr_url TEXT,
  result_summary TEXT,
  error_message TEXT,

  -- NULL until a voice briefing / chat has told the user this build finished.
  announced_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lykn_cursor_builds_user_status_idx
  ON public.lykn_cursor_builds (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS lykn_cursor_builds_project_idx
  ON public.lykn_cursor_builds (project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

-- The completion poller scans only in-flight builds across all users.
CREATE INDEX IF NOT EXISTS lykn_cursor_builds_running_idx
  ON public.lykn_cursor_builds (status, updated_at)
  WHERE status = 'running';

-- Briefing surfacing: finished-but-not-yet-announced builds per user.
CREATE INDEX IF NOT EXISTS lykn_cursor_builds_unannounced_idx
  ON public.lykn_cursor_builds (user_id, completed_at DESC)
  WHERE status IN ('completed', 'failed') AND announced_at IS NULL;

ALTER TABLE public.lykn_cursor_builds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_cursor_builds_select_own ON public.lykn_cursor_builds;
CREATE POLICY lykn_cursor_builds_select_own
  ON public.lykn_cursor_builds FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_cursor_builds_insert_own ON public.lykn_cursor_builds;
CREATE POLICY lykn_cursor_builds_insert_own
  ON public.lykn_cursor_builds FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_cursor_builds_update_own ON public.lykn_cursor_builds;
CREATE POLICY lykn_cursor_builds_update_own
  ON public.lykn_cursor_builds FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_cursor_builds_delete_own ON public.lykn_cursor_builds;
CREATE POLICY lykn_cursor_builds_delete_own
  ON public.lykn_cursor_builds FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_cursor_builds IS
  'Async Cursor cloud-agent coding builds dispatched by the LYKN agent. Realtime-enabled for live status in chat.';

-- Realtime (mirror 087)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_cursor_builds'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_cursor_builds';
  END IF;
END $$;

ALTER TABLE public.lykn_cursor_builds REPLICA IDENTITY FULL;
