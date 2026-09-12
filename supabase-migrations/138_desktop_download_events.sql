-- ============================================
-- Desktop installer download counts
-- Migration: 138_desktop_download_events.sql
-- ============================================
--
-- Public download buttons and emailed installer links go through
-- `GET /api/download/mac` and `GET /api/download/win`, which record a row
-- here via the service role and then 302 to the GitHub release asset.
-- There is no SELECT policy and no read API: totals are ops-only, read
-- directly in the Supabase dashboard (SQL editor) with the service role.
-- This is a click/request log, not unique people and not Mac-app telemetry.

CREATE TABLE IF NOT EXISTS public.desktop_download_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform    text NOT NULL,
  artifact    text NOT NULL,
  source      text NOT NULL DEFAULT 'website',
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT desktop_download_events_platform_check
    CHECK (platform IN ('mac', 'win')),
  CONSTRAINT desktop_download_events_artifact_check
    CHECK (artifact IN ('dmg', 'exe')),
  CONSTRAINT desktop_download_events_source_check
    CHECK (char_length(source) BETWEEN 1 AND 32)
);

CREATE INDEX IF NOT EXISTS idx_desktop_download_events_created
  ON public.desktop_download_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_desktop_download_events_platform_created
  ON public.desktop_download_events (platform, created_at DESC);

ALTER TABLE public.desktop_download_events ENABLE ROW LEVEL SECURITY;
