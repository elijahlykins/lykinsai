-- ============================================
-- Simplify paid plans: Pro gets unlimited Vault
-- Migration: 071_pro_unlimited_vault.sql
-- ============================================
--
-- Pro (`studio`) is the only paid tier at checkout. It now includes
-- unlimited Vault cards (PLAN_LIMITS.studio.vaultCards = Infinity in
-- src/lib/pricing-config.js). This updates the DB trigger to match.

CREATE OR REPLACE FUNCTION public.vault_cap_for_plan(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 50
    WHEN 'studio'     THEN NULL      -- unlimited (Pro)
    WHEN 'studio_pro' THEN NULL      -- legacy — unlimited
    WHEN 'studio_max' THEN NULL      -- legacy — unlimited
    ELSE 50                          -- unknown / missing -> treat as free
  END;
$$;

NOTIFY pgrst, 'reload schema';
