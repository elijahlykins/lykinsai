-- ============================================================================
-- 089 — Reminders: time-anchored prompts the AI can set in text or voice mode
-- ============================================================================
-- A reminder is a small, user-owned row the LYKN assistant creates when the
-- user says "remind me to X (at/in) Y". v1 is PULL-BASED: there is no push /
-- SMS / email delivery yet — due + upcoming reminders are surfaced when the
-- user next engages (read back in the voice briefing, listable via the AI
-- tools). The schema leaves room for a future delivery worker (`surfaced_at`,
-- status lifecycle) without a migration.

CREATE TABLE IF NOT EXISTS public.lykn_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- What to remind the user about.
  title TEXT NOT NULL CHECK (length(trim(title)) >= 1 AND length(title) <= 280),
  -- Optional longer detail / context.
  body TEXT CHECK (body IS NULL OR length(body) <= 4000),
  -- When it should fire (stored UTC). The AI resolves relative phrasing
  -- ("in an hour", "tomorrow at 3pm") to an absolute instant before insert.
  remind_at TIMESTAMPTZ NOT NULL,
  -- The original human phrasing, kept verbatim for natural read-back
  -- ("tomorrow at 3pm") so the briefing doesn't have to reformat a timestamp.
  remind_at_text TEXT CHECK (remind_at_text IS NULL OR length(remind_at_text) <= 200),
  -- Lifecycle: pending → completed | cancelled.
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'cancelled')),
  -- Optional link to the project the reminder came out of.
  project_id UUID REFERENCES public.lykn_projects(id) ON DELETE SET NULL,
  -- Attribution: which surface created it (lykn-chat-agent:lykn-chat,
  -- lykn-chat-agent:voice, mcp:claude-desktop, …).
  source TEXT,
  -- Last time this reminder was read back / shown to the user. Lets the
  -- briefing avoid re-announcing the same due item every reconnect, and is
  -- the hook a future delivery worker would stamp.
  surfaced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Primary access pattern: "this user's pending reminders, soonest first"
-- (briefing + list tool). Partial index keeps it tight as completed/cancelled
-- rows accumulate.
CREATE INDEX IF NOT EXISTS lykn_reminders_user_pending_idx
  ON public.lykn_reminders (user_id, remind_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS lykn_reminders_user_status_idx
  ON public.lykn_reminders (user_id, status, remind_at DESC);

ALTER TABLE public.lykn_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_reminders_select_own ON public.lykn_reminders;
CREATE POLICY lykn_reminders_select_own
  ON public.lykn_reminders FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_reminders_insert_own ON public.lykn_reminders;
CREATE POLICY lykn_reminders_insert_own
  ON public.lykn_reminders FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_reminders_update_own ON public.lykn_reminders;
CREATE POLICY lykn_reminders_update_own
  ON public.lykn_reminders FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_reminders_delete_own ON public.lykn_reminders;
CREATE POLICY lykn_reminders_delete_own
  ON public.lykn_reminders FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_reminders IS
  'Time-anchored reminders the LYKN AI sets in text or voice mode. Pull-based v1: surfaced in the voice briefing + AI list tool, no push/SMS/email delivery yet.';
