-- ============================================
-- Vault cap + upload-rate enforcement: apply to all writers
-- Migration: 052_vault_caps_apply_to_user_id.sql
-- ============================================
--
-- Background
-- ----------
-- 029_vault_cap_trigger.sql and 033_upload_rate_trigger.sql key their
-- enforcement off `auth.uid()`, which is NULL for any service-role
-- context. That deliberate carve-out was meant for migrations and one-off
-- backend tasks, but in practice it also exempts every connector and the
-- RSS poller (`connectors/*.js`, `rss-service.js`) — they all use
-- `supabaseAdmin` to insert into `notes`. A single noisy feed could push
-- a free user well past their 50-item cap and burn through their plan
-- without the UI ever surfacing it (the failure couldn't fire at all).
--
-- Fix
-- ---
-- Switch both triggers to use `NEW.user_id` as the cap target so the
-- cap applies regardless of which role is doing the insert. Add an
-- explicit, opt-in bypass via the `lykn.bypass_caps` GUC so legitimate
-- system writes (one-off backfills, data migrations) can still skip
-- enforcement deliberately.
--
-- Behavior change for connectors/RSS
-- ----------------------------------
--   Before: unlimited rows allowed, plan caps silently bypassed.
--   After:  inserts that would push the user over their cap raise
--           `vault_cap_reached` (ERRCODE = check_violation). Connectors
--           already wrap their inserts in try/catch and log on failure
--           (see `connectors/*.js`, `rss-service.js::saveEntryAsNote`),
--           so they become no-ops once the user is at cap — exactly the
--           outcome the cap is supposed to produce.
--
-- Bypass usage (server-side)
-- --------------------------
--   begin;
--     select set_config('lykn.bypass_caps', 'on', true); -- txn-local
--     insert into public.notes (...) values (...);
--   commit;
--
-- Triggers do not need to be redropped — they already reference these
-- function names; replacing the function bodies is sufficient.

CREATE OR REPLACE FUNCTION public.enforce_vault_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target   uuid;
  v_plan     text;
  v_cap      integer;
  v_current  integer;
  v_bypass   text;
BEGIN
  -- Explicit opt-in bypass for backfills / migrations / data fixes.
  -- `current_setting(..., true)` returns NULL (not an error) when unset.
  v_bypass := current_setting('lykn.bypass_caps', true);
  IF v_bypass = 'on' THEN
    RETURN NEW;
  END IF;

  -- Cap target = the row's user_id. Previously this was auth.uid() with
  -- a NULL exemption, which let the service role bypass entirely.
  v_target := NEW.user_id;
  IF v_target IS NULL THEN
    RETURN NEW;
  END IF;

  v_plan := public.effective_plan_for_user(v_target);
  v_cap  := public.vault_cap_for_plan(v_plan);

  -- NULL cap = unlimited plan.
  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_current
  FROM public.notes
  WHERE user_id = v_target;

  IF v_current >= v_cap THEN
    RAISE EXCEPTION
      'vault_cap_reached: plan % allows % vault items, user already has %',
      v_plan, v_cap, v_current
      USING ERRCODE = 'check_violation',
            HINT   = 'Upgrade your plan to save more Vault items.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_upload_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target       uuid;
  v_plan         text;
  v_max_min      integer;
  v_max_hour     integer;
  v_count_min    integer;
  v_count_hour   integer;
  v_bypass       text;
BEGIN
  v_bypass := current_setting('lykn.bypass_caps', true);
  IF v_bypass = 'on' THEN
    RETURN NEW;
  END IF;

  -- Only throttle file uploads. Quick-note / RSS / connector saves use
  -- different `source` values and aren't bound by the per-second budget;
  -- they're already bounded by the absolute item cap above.
  IF NEW.source IS NULL OR NEW.source <> 'file_upload' THEN
    RETURN NEW;
  END IF;

  v_target := NEW.user_id;
  IF v_target IS NULL THEN
    RETURN NEW;
  END IF;

  v_plan     := public.effective_plan_for_user(v_target);
  v_max_min  := public.upload_rate_per_minute(v_plan);
  v_max_hour := public.upload_rate_per_hour(v_plan);

  IF v_max_min IS NOT NULL THEN
    SELECT count(*) INTO v_count_min
    FROM public.notes
    WHERE user_id = v_target
      AND source = 'file_upload'
      AND created_at > (now() - interval '1 minute');

    IF v_count_min >= v_max_min THEN
      RAISE EXCEPTION
        'upload_rate_limit: plan % allows % uploads per minute, user has % in the last minute',
        v_plan, v_max_min, v_count_min
        USING ERRCODE = 'check_violation',
              HINT    = 'Slow down or upgrade your plan for faster uploads.';
    END IF;
  END IF;

  IF v_max_hour IS NOT NULL THEN
    SELECT count(*) INTO v_count_hour
    FROM public.notes
    WHERE user_id = v_target
      AND source = 'file_upload'
      AND created_at > (now() - interval '1 hour');

    IF v_count_hour >= v_max_hour THEN
      RAISE EXCEPTION
        'upload_rate_limit: plan % allows % uploads per hour, user has % in the last hour',
        v_plan, v_max_hour, v_count_hour
        USING ERRCODE = 'check_violation',
              HINT    = 'Slow down or upgrade your plan for faster uploads.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
