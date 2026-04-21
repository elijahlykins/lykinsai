-- ============================================
-- Studio Max waitlist
-- Migration: 030_studio_max_waitlist.sql
-- ============================================
--
-- Studio Max is marked `comingSoon: true` in `src/lib/pricing-config.js` and
-- the pricing card renders a "Join Waitlist" CTA. This migration adds the
-- table that captures those sign-ups so we have an ordered list to email
-- when the team plan goes live.
--
-- Writes happen via the backend (`/api/billing/waitlist`) using the service
-- role, so clients cannot INSERT/UPDATE/DELETE directly. A single SELECT
-- policy lets a user confirm whether they're already on the list so the
-- pricing card can show "You're on the waitlist" instead of re-prompting.

CREATE TABLE IF NOT EXISTS public.studio_max_waitlist (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  email       text NOT NULL,
  -- User-supplied context (team size, use case, etc.). Free-form, capped at
  -- 2000 chars on the server.
  note        text,
  -- Server-filled metadata (ip / user-agent) for deliverability + fraud
  -- triage. Kept as JSONB so we can extend without migrations.
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_max_waitlist_email_check
    CHECK (char_length(email) <= 320 AND position('@' in email) > 1),
  CONSTRAINT studio_max_waitlist_note_check
    CHECK (note IS NULL OR char_length(note) <= 2000)
);

ALTER TABLE public.studio_max_waitlist ENABLE ROW LEVEL SECURITY;

-- Users can see their own entry (so the UI can render a confirmed state).
-- No INSERT / UPDATE / DELETE policies for clients: service role writes only.
CREATE POLICY "Users can view own waitlist entry"
  ON public.studio_max_waitlist FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_studio_max_waitlist_email
  ON public.studio_max_waitlist (lower(email));

CREATE INDEX IF NOT EXISTS idx_studio_max_waitlist_created
  ON public.studio_max_waitlist (created_at DESC);

-- Keep updated_at fresh on UPDATEs (admin edits, note revisions, etc).
CREATE OR REPLACE FUNCTION public.studio_max_waitlist_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_studio_max_waitlist_updated_at ON public.studio_max_waitlist;
CREATE TRIGGER trg_studio_max_waitlist_updated_at
  BEFORE UPDATE ON public.studio_max_waitlist
  FOR EACH ROW
  EXECUTE FUNCTION public.studio_max_waitlist_set_updated_at();
