-- ============================================================================
-- 095 — External calendar sync: pull Google / Apple events INTO lykn_events
-- ============================================================================
-- 094 created lykn_events as LYKN's own calendar (the AI writes it in text /
-- voice; the user edits it in the pop-up). The Google Calendar (read-only
-- OAuth) and Apple Calendar (read-only CalDAV) connectors already authenticate
-- and fetch the user's real events, but they only landed them in the Vault as
-- bookmark notes. This migration lets those same connectors ALSO drop each
-- event onto the LYKN calendar grid, so the user sees their real schedule next
-- to their LYKN-native events.
--
-- This is a ONE-WAY import (read). External rows are marked read_only:
--   • the calendar pop-up shows them but won't let the user edit/delete them,
--   • lykn_updateEvent / lykn_deleteEvent refuse to mutate them,
-- because LYKN does NOT write changes back to Google/Apple (that would require
-- the Google read-WRITE scope + re-verification, and CalDAV PUTs — out of
-- scope here). Edits belong in the source app.
--
-- Dedupe / freshness model:
--   (user_id, external_provider, external_id) is unique, so a re-sync UPSERTs
--   the same row (reschedules update in place) instead of duplicating. Native
--   LYKN rows leave external_provider/external_id NULL — and since NULLs are
--   distinct in a Postgres unique index, unlimited native rows coexist freely.

ALTER TABLE public.lykn_events
  -- Which external calendar this row mirrors: 'google' | 'apple' | NULL (native).
  ADD COLUMN IF NOT EXISTS external_provider TEXT
    CHECK (external_provider IS NULL OR external_provider IN ('google', 'apple')),
  -- The provider's stable id for this event/occurrence (Google event id, or
  -- Apple "uid#occurrence" key). NULL for native LYKN events.
  ADD COLUMN IF NOT EXISTS external_id TEXT
    CHECK (external_id IS NULL OR length(external_id) <= 512),
  -- True for synced-in events: the UI and the MCP tools treat these as
  -- read-only since LYKN can't push edits back to the source calendar.
  ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT false;

-- Upsert key for re-syncs. NULL provider/id (native rows) are distinct under
-- a Postgres unique index, so this never constrains LYKN-native events.
CREATE UNIQUE INDEX IF NOT EXISTS lykn_events_external_uidx
  ON public.lykn_events (user_id, external_provider, external_id);

COMMENT ON COLUMN public.lykn_events.external_provider IS
  'Source external calendar for synced rows: google | apple | NULL for LYKN-native events.';
COMMENT ON COLUMN public.lykn_events.external_id IS
  'Stable provider id (Google event id / Apple uid#occurrence) used to dedupe re-syncs. NULL for native events.';
COMMENT ON COLUMN public.lykn_events.read_only IS
  'True for events synced in from Google/Apple. The UI and MCP tools block edits since LYKN does not write back to the source calendar.';

COMMENT ON TABLE public.lykn_events IS
  'LYKN calendar events. Native rows are AI/user-authored (external_provider NULL). Rows with external_provider set are one-way imports from the Google/Apple calendar connectors (read_only=true); LYKN is the source of truth for native rows and a read-only mirror for external ones. Realtime-enabled (086). Sibling of lykn_reminders (089).';
