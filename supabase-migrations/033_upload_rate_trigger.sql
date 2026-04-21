-- ============================================
-- Vault upload RATE limit enforcement
-- Migration: 033_upload_rate_trigger.sql
-- ============================================
--
-- `029_vault_cap_trigger.sql` already caps the *total* number of Vault items
-- a user can own (50 on free, 1,000 on Studio, unlimited above). This
-- migration adds the missing second dimension: how fast can they create
-- them?
--
-- Without this a determined user (or a malfunctioning client) could burn
-- through the bucket quota and our Supabase egress budget with a single
-- "drop 10,000 files" action. This trigger counts the caller's recent
-- file-upload notes in two rolling windows and blocks bursts that exceed
-- the per-plan limits.
--
-- The limits MUST stay in sync with `UPLOAD_RATE_LIMITS` in
-- src/lib/pricing-config.js.
--
-- Effective-plan resolution reuses `effective_plan_for_user()` from
-- 029_vault_cap_trigger.sql, so inactive paid users collapse back to 'free'
-- automatically.
--
-- The service role is exempted (auth.uid() is NULL for service-role / direct
-- SQL / migrations), so backend writes can never be throttled here.

-- ---------------------------------------------
-- Prereqs: `source` and `folder` columns on notes.
--
-- `src/lib/vault/uploadPipeline.ts::createVaultNote` tries to insert rows
-- with `{ folder, source='file_upload', tags }` and, if Postgres rejects
-- the insert for any missing column (PGRST204), falls back to a minimal
-- insert with just `{ user_id, title, content }`.
--
-- That fallback meant BOTH `source` and `folder` could be missing in
-- production, which in turn made this rate trigger (which filters on
-- `source = 'file_upload'`) a no-op because every new upload was taking
-- the fallback path and never actually setting `source`. We need BOTH
-- columns to exist so the rich insert succeeds and `source='file_upload'`
-- actually lands in the row.
--
-- Existing rows get NULL for both, which is exactly what we want — they
-- don't count as file uploads for rate-limiting and they don't need a
-- folder.
-- ---------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'notes'
      AND column_name  = 'source'
  ) THEN
    ALTER TABLE public.notes ADD COLUMN source text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'notes'
      AND column_name  = 'folder'
  ) THEN
    ALTER TABLE public.notes ADD COLUMN folder text;
  END IF;
END
$$;

-- ---------------------------------------------
-- Plan -> (files per minute, files per hour)
-- NULL component = no cap in that window.
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.upload_rate_per_minute(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 20
    WHEN 'studio'     THEN 100
    WHEN 'studio_pro' THEN 300
    WHEN 'studio_max' THEN 600
    ELSE 20                      -- unknown / missing -> treat as free
  END;
$$;

CREATE OR REPLACE FUNCTION public.upload_rate_per_hour(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 120
    WHEN 'studio'     THEN 1200
    WHEN 'studio_pro' THEN 3600
    WHEN 'studio_max' THEN 7200
    ELSE 120
  END;
$$;

-- ---------------------------------------------
-- BEFORE INSERT guard on notes — rate portion only.
-- Only triggers on file-upload rows (source='file_upload'); other note
-- sources (quick note, AI save, link drop) are not throttled here.
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_upload_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller       uuid;
  v_plan         text;
  v_max_min      integer;
  v_max_hour     integer;
  v_count_min    integer;
  v_count_hour   integer;
BEGIN
  -- auth.uid() is NULL for service-role / direct-SQL / migration contexts.
  -- Those paths are the backend and must never be throttled.
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only throttle file uploads. If the `source` column isn't 'file_upload'
  -- we let the insert through untouched.
  IF NEW.source IS NULL OR NEW.source <> 'file_upload' THEN
    RETURN NEW;
  END IF;

  -- Defensive: only throttle the caller's own rows. Mismatches are RLS's
  -- problem, not ours.
  IF NEW.user_id IS NULL OR NEW.user_id <> v_caller THEN
    RETURN NEW;
  END IF;

  v_plan     := public.effective_plan_for_user(v_caller);
  v_max_min  := public.upload_rate_per_minute(v_plan);
  v_max_hour := public.upload_rate_per_hour(v_plan);

  -- Per-minute window. We count file-upload notes created in the last
  -- 60 seconds and reject if adding this one would push us over.
  IF v_max_min IS NOT NULL THEN
    SELECT count(*) INTO v_count_min
    FROM public.notes
    WHERE user_id = v_caller
      AND source = 'file_upload'
      AND created_at > (now() - interval '1 minute');

    IF v_count_min >= v_max_min THEN
      RAISE EXCEPTION
        'upload_rate_limit: plan % allows % uploads per minute, you have % in the last minute',
        v_plan, v_max_min, v_count_min
        USING ERRCODE = 'check_violation',
              HINT    = 'Slow down or upgrade your plan for faster uploads.';
    END IF;
  END IF;

  -- Per-hour window. Cheap: same index as above, just a wider interval.
  IF v_max_hour IS NOT NULL THEN
    SELECT count(*) INTO v_count_hour
    FROM public.notes
    WHERE user_id = v_caller
      AND source = 'file_upload'
      AND created_at > (now() - interval '1 hour');

    IF v_count_hour >= v_max_hour THEN
      RAISE EXCEPTION
        'upload_rate_limit: plan % allows % uploads per hour, you have % in the last hour',
        v_plan, v_max_hour, v_count_hour
        USING ERRCODE = 'check_violation',
              HINT    = 'Slow down or upgrade your plan for faster uploads.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Supporting index: this trigger fires on every file upload and runs two
-- count(*) queries filtered by (user_id, source, created_at). Without a
-- dedicated index these scans get expensive once notes.count crosses a few
-- million rows. The partial index keeps it small by only covering file
-- uploads.
CREATE INDEX IF NOT EXISTS notes_user_file_upload_recent_idx
  ON public.notes (user_id, created_at DESC)
  WHERE source = 'file_upload';

-- Install after the vault-cap trigger so hitting the absolute cap fires
-- its (more actionable) "Upgrade your plan" error before a rate-limit one.
DROP TRIGGER IF EXISTS trg_notes_upload_rate ON public.notes;
CREATE TRIGGER trg_notes_upload_rate
  BEFORE INSERT ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_upload_rate();
