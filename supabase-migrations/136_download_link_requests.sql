-- ============================================
-- Mac download-link email capture
-- Migration: 136_download_link_requests.sql
-- ============================================
--
-- Phones can't install the desktop app, so the landing hero swaps the
-- download button for an email field ("Send the link"). The backend
-- (`POST /api/download-link`) mails the visitor their Mac download link and
-- records the address here via the service role. Repeat requests re-send the
-- email without inserting a duplicate row (unique violation is ignored).
-- There is no SELECT policy: this list is ops-only.

CREATE TABLE IF NOT EXISTS public.download_link_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT download_link_requests_email_check
    CHECK (char_length(email) <= 320 AND position('@' in email) > 1)
);

CREATE INDEX IF NOT EXISTS idx_download_link_requests_created
  ON public.download_link_requests (created_at DESC);

ALTER TABLE public.download_link_requests ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.download_link_requests_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_download_link_requests_updated_at ON public.download_link_requests;
CREATE TRIGGER trg_download_link_requests_updated_at
  BEFORE UPDATE ON public.download_link_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.download_link_requests_set_updated_at();
