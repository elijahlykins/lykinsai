-- ============================================================================
-- 094 — Calendar events: a native LYKN calendar the AI builds in text or voice
-- ============================================================================
-- An event is a user-owned row the LYKN assistant creates when the user says
-- "put lunch with Sarah on my calendar Thursday at noon" (text or voice), and
-- that the user can also see / drag / edit in the calendar pop-up UI. This is
-- the sibling of lykn_reminders (089): reminders are a point-in-time nudge;
-- events have a start + (optional) end, an all-day flag, and a location, so
-- they render on a month/week/day grid.
--
-- LYKN IS the calendar here (source of truth) — it does NOT two-way sync with
-- Google/Apple/Outlook. The read-only Google Calendar connector still pulls
-- external events into the Vault separately; those are not written here.
--
-- Realtime is enabled (mirrors 086) so the pop-up UI reflects AI/voice writes
-- live, without a manual refresh.

CREATE TABLE IF NOT EXISTS public.lykn_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- What the event is.
  title TEXT NOT NULL CHECK (length(trim(title)) >= 1 AND length(title) <= 280),
  -- Optional longer detail / agenda / notes.
  description TEXT CHECK (description IS NULL OR length(description) <= 4000),
  -- When it starts (stored UTC). The AI resolves relative phrasing
  -- ("Thursday at noon", "tomorrow") to an absolute instant before insert.
  starts_at TIMESTAMPTZ NOT NULL,
  -- When it ends (stored UTC). NULL for a point/all-day event with no
  -- explicit end. Must be >= starts_at when present.
  ends_at TIMESTAMPTZ CHECK (ends_at IS NULL OR ends_at >= starts_at),
  -- All-day events render on the date band rather than a time slot. When
  -- true, the time component of starts_at/ends_at is informational only.
  all_day BOOLEAN NOT NULL DEFAULT false,
  -- Optional place / meeting link / room.
  location TEXT CHECK (location IS NULL OR length(location) <= 300),
  -- IANA timezone the user meant ("America/Denver"), kept so the UI and
  -- read-back can render in the user's local wall-clock even though the
  -- instants are stored UTC.
  timezone TEXT CHECK (timezone IS NULL OR length(timezone) <= 64),
  -- Optional UI color hint (hex like "#34C759"); the pop-up falls back to a
  -- default when null.
  color TEXT CHECK (color IS NULL OR length(color) <= 16),
  -- Lifecycle: confirmed (default) | tentative | cancelled. Cancelled rows
  -- are hidden from the default calendar view but kept for undo/history.
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
  -- Optional link to the project the event came out of.
  project_id UUID REFERENCES public.lykn_projects(id) ON DELETE SET NULL,
  -- Attribution: which surface created it (lykn-chat-agent:lykn-chat,
  -- lykn-chat-agent:voice, mcp:claude-desktop, calendar-ui, …).
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary access pattern: "this user's events in [window], earliest first"
-- — the calendar grid loads a month range, the list tool a look-ahead window.
CREATE INDEX IF NOT EXISTS lykn_events_user_starts_idx
  ON public.lykn_events (user_id, starts_at);

CREATE INDEX IF NOT EXISTS lykn_events_user_status_starts_idx
  ON public.lykn_events (user_id, status, starts_at);

ALTER TABLE public.lykn_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_events_select_own ON public.lykn_events;
CREATE POLICY lykn_events_select_own
  ON public.lykn_events FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_events_insert_own ON public.lykn_events;
CREATE POLICY lykn_events_insert_own
  ON public.lykn_events FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_events_update_own ON public.lykn_events;
CREATE POLICY lykn_events_update_own
  ON public.lykn_events FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_events_delete_own ON public.lykn_events;
CREATE POLICY lykn_events_delete_own
  ON public.lykn_events FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Realtime so the calendar pop-up reflects AI/voice writes live (mirrors 086).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_events'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_events';
  END IF;
END $$;

ALTER TABLE public.lykn_events REPLICA IDENTITY FULL;

COMMENT ON TABLE public.lykn_events IS
  'Native LYKN calendar events the AI sets in text or voice mode and the user edits in the calendar pop-up. Realtime-enabled (see 086). LYKN is the source of truth; no two-way sync with external calendars. Sibling of lykn_reminders (089).';
