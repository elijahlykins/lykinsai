-- ============================================
-- Register the `student` and `max` plan tiers
-- Migration: 119_student_max_plans.sql
-- ============================================
--
-- The app sells three plans at checkout — `student`, `studio` (Pro), and
-- `max` (see PLANS in src/lib/pricing-config.js and STRIPE_PRICE_MAP in
-- server.js) — but `user_billing.plan` still carried the original CHECK
-- constraint from 028 that only allows 'free' | 'studio' | 'studio_pro' |
-- 'studio_max'. Any Student or Max checkout therefore failed at the webhook:
-- Postgres rejected the entire row update (status, subscription id, and
-- period end included), leaving the user charged in Stripe but 'free' in
-- the app.
--
-- This migration:
--   1. Widens the CHECK constraint to include 'student' and 'max'.
--   2. Teaches every plan->cap resolver function about the new tiers,
--      mirroring PLAN_LIMITS / UPLOAD_RATE_LIMITS in pricing-config.js.
--      (Also fixes 'studio' upload rates, which had drifted from the JS
--      source of truth: 100/1200 in the DB vs 300/3600 in the app.)

-- ---------------------------------------------
-- 1. Plan CHECK constraint
-- ---------------------------------------------
ALTER TABLE public.user_billing
  DROP CONSTRAINT IF EXISTS user_billing_plan_check;

ALTER TABLE public.user_billing
  ADD CONSTRAINT user_billing_plan_check
    CHECK (plan IN ('free', 'student', 'studio', 'max', 'studio_pro', 'studio_max'));

-- ---------------------------------------------
-- 2. Vault cap (PLAN_LIMITS.<plan>.vaultCards)
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.vault_cap_for_plan(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 50
    WHEN 'student'    THEN NULL      -- unlimited (Pro entitlements)
    WHEN 'studio'     THEN NULL      -- unlimited (Pro)
    WHEN 'max'        THEN NULL      -- unlimited
    WHEN 'studio_pro' THEN NULL      -- legacy — unlimited
    WHEN 'studio_max' THEN NULL      -- legacy — unlimited
    ELSE 50                          -- unknown / missing -> treat as free
  END;
$$;

-- ---------------------------------------------
-- 3. Blocks-per-grid cap (PLAN_LIMITS.<plan>.blocksPerGrid)
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.blocks_per_grid_cap(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 50
    WHEN 'student'    THEN NULL      -- unlimited
    WHEN 'studio'     THEN NULL      -- unlimited
    WHEN 'max'        THEN NULL      -- unlimited
    WHEN 'studio_pro' THEN NULL      -- unlimited
    WHEN 'studio_max' THEN NULL      -- unlimited
    ELSE 50                          -- unknown / missing -> treat as free
  END;
$$;

-- ---------------------------------------------
-- 4. Synthesis-neuron cap (PLAN_LIMITS.<plan>.synthesisNodes)
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.synthesis_neuron_cap_for_plan(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 100
    WHEN 'student'    THEN NULL      -- unlimited
    WHEN 'studio'     THEN NULL      -- unlimited (Pro)
    WHEN 'max'        THEN NULL      -- unlimited
    WHEN 'studio_pro' THEN NULL      -- unlimited
    WHEN 'studio_max' THEN NULL      -- unlimited
    ELSE 100                         -- unknown / missing -> treat as free
  END;
$$;

-- ---------------------------------------------
-- 5. Upload rates (UPLOAD_RATE_LIMITS in pricing-config.js)
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.upload_rate_per_minute(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 20
    WHEN 'student'    THEN 300
    WHEN 'studio'     THEN 300
    WHEN 'max'        THEN 600
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
    WHEN 'student'    THEN 3600
    WHEN 'studio'     THEN 3600
    WHEN 'max'        THEN 7200
    WHEN 'studio_pro' THEN 3600
    WHEN 'studio_max' THEN 7200
    ELSE 120
  END;
$$;

NOTIFY pgrst, 'reload schema';
