-- ============================================
-- Windows desktop waitlist
-- Migration: 135_windows_waitlist.sql
-- ============================================
--
-- Public marketing page at /windows collects emails until the Windows
-- installer ships. Writes happen via the backend (`POST /api/waitlist/windows`)
-- using the service role so clients cannot INSERT/UPDATE/DELETE directly.
-- There is no SELECT policy: this list is ops-only until we email invites.

CREATE TABLE IF NOT EXISTS public.windows_waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT windows_waitlist_email_check
    CHECK (char_length(email) <= 320 AND position('@' in email) > 1)
);

CREATE INDEX IF NOT EXISTS idx_windows_waitlist_created
  ON public.windows_waitlist (created_at DESC);

ALTER TABLE public.windows_waitlist ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.windows_waitlist_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_windows_waitlist_updated_at ON public.windows_waitlist;
CREATE TRIGGER trg_windows_waitlist_updated_at
  BEFORE UPDATE ON public.windows_waitlist
  FOR EACH ROW
  EXECUTE FUNCTION public.windows_waitlist_set_updated_at();
