-- ============================================
-- Vault item cap enforcement
-- Migration: 029_vault_cap_trigger.sql
-- ============================================
--
-- The client (src/lib/useUsageGate.js) already refuses to save past the
-- per-plan vault cap, but that's a UI hint — a tampered request or a direct
-- supabase-js call would bypass it. This migration adds a BEFORE INSERT
-- trigger on `public.notes` that counts the caller's existing notes, resolves
-- their effective plan from `public.user_billing`, and raises if they'd
-- exceed the cap.
--
-- Plan caps mirror PLAN_LIMITS in src/lib/pricing-config.js:
--   free         -> 50
--   studio       -> 1000
--   studio_pro   -> unlimited (NULL)
--   studio_max   -> unlimited (NULL)
--
-- Effective-plan resolution mirrors resolveUserPlan() in server.js:
--   - No user_billing row -> 'free'.
--   - user_billing.status NOT IN ('active','trialing','past_due') -> 'free'.
--     (past_due stays paid so users don't lose vault access mid-dunning.)
--
-- The service role is exempted so backend writes (AI auto-save, webhook
-- backfills, migrations) can never be blocked by this trigger.

-- ---------------------------------------------
-- Plan -> vault cap resolver
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.vault_cap_for_plan(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 50
    WHEN 'studio'     THEN 1000
    WHEN 'studio_pro' THEN NULL      -- unlimited
    WHEN 'studio_max' THEN NULL      -- unlimited
    ELSE 50                          -- unknown / missing -> treat as free
  END;
$$;

-- ---------------------------------------------
-- Resolve the effective plan for a user, collapsing inactive paid plans
-- back down to 'free'. Matches the server-side logic in resolveUserPlan().
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.effective_plan_for_user(p_user uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN ub.user_id IS NULL THEN 'free'
    WHEN ub.plan = 'free' THEN 'free'
    WHEN ub.status IN ('active', 'trialing', 'past_due') THEN ub.plan
    ELSE 'free'
  END
  FROM (SELECT p_user AS user_id) caller
  LEFT JOIN public.user_billing ub ON ub.user_id = caller.user_id;
$$;

-- ---------------------------------------------
-- BEFORE INSERT guard on notes
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_vault_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   uuid;
  v_plan     text;
  v_cap      integer;
  v_current  integer;
BEGIN
  -- auth.uid() is NULL for service-role / direct-SQL / migration contexts.
  -- Those paths are the backend and should never be rate-limited here.
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Defensive: if somehow a user_id sneaks in that doesn't match the caller,
  -- let RLS deal with it — we only care about capping the caller's own rows.
  IF NEW.user_id IS NULL OR NEW.user_id <> v_caller THEN
    RETURN NEW;
  END IF;

  v_plan := public.effective_plan_for_user(v_caller);
  v_cap  := public.vault_cap_for_plan(v_plan);

  -- NULL cap = unlimited.
  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_current
  FROM public.notes
  WHERE user_id = v_caller;

  IF v_current >= v_cap THEN
    RAISE EXCEPTION
      'vault_cap_reached: plan % allows % vault items, you already have %',
      v_plan, v_cap, v_current
      USING ERRCODE = 'check_violation',
            HINT   = 'Upgrade your plan to save more Vault items.';
  END IF;

  RETURN NEW;
END;
$$;

-- SECURITY DEFINER lets the trigger read user_billing regardless of the
-- caller's RLS scope. We intentionally don't REVOKE EXECUTE here because
-- trigger firing in some Postgres versions still checks function privileges
-- for the invoking role.

DROP TRIGGER IF EXISTS trg_notes_vault_cap ON public.notes;
CREATE TRIGGER trg_notes_vault_cap
  BEFORE INSERT ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_vault_cap();
