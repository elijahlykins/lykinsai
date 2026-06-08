-- ============================================================================
-- 091 — Bring-your-own Cursor account for cloud-agent builds
-- ============================================================================
-- Cursor builds used to run on a single server-wide CURSOR_API_KEY (one
-- account, one allowlisted repo). We now resolve a PER-USER Cursor credential:
-- each user attaches their own Cursor account (an API key from Cursor
-- Dashboard → Integrations) as a token-mode connector row in
-- `social_connections` (provider = 'cursor'). A build runs on the launching
-- user's own account, against any repo their key can reach, and opens a PR.
--
-- We record which connection launched each build so the completion poller can
-- re-auth with the EXACT key that started the run (a run is scoped to the key
-- that created it). ON DELETE SET NULL: if the user disconnects/rotates their
-- Cursor account, in-flight builds simply stop syncing rather than erroring —
-- the sync path falls back to the user's current connection when present.

ALTER TABLE public.lykn_cursor_builds
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES public.social_connections(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.lykn_cursor_builds.connection_id IS
  'The social_connections row (provider=cursor) whose API key launched this build. Used to poll the run with the same credential. NULL once that connection is removed.';

-- The poller scans in-flight builds; joining back to the launching connection
-- is keyed off this column.
CREATE INDEX IF NOT EXISTS lykn_cursor_builds_connection_idx
  ON public.lykn_cursor_builds (connection_id)
  WHERE connection_id IS NOT NULL;
