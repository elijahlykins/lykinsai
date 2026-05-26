-- ============================================
-- Synthesis layer: explicit-neuron cap enforcement
-- Migration: 066_synthesis_neuron_cap_trigger.sql
-- ============================================
--
-- Free users get the full Synthesis Layer up to N "explicit neurons"
-- (PLAN_LIMITS.free.synthesisNodes = 100 today). Paid plans are
-- uncapped. The client (`src/pages/SynthesisLayer.tsx`) already swaps
-- in the upgrade paywall when the rendered graph crosses the cap, but
-- the page check is bypassable by anyone writing directly through MCP,
-- supabase-js, REST mirrors, or the in-app chat tools. This migration
-- adds DB-level enforcement so the cap holds at the source of truth.
--
-- "Explicit neuron" =
--   • a row in `omnia_boards`                                (1 grid)
--   • a row in `lykn_beliefs` with status='active'           (1 ratified belief)
--   • a row in `lykn_user_model_facts` with status IN        (1 manual fact)
--       ('stated', 'confirmed', 'corrected')
--   • a row in `notes`                                       (1 vault item)
--       (covers Vault notes AND `_perspective`-tagged
--        long-form perspectives — they share the table)
--
-- "NOT explicit" — never counted, never blocked:
--   • inferred / dismissed facts (nightly synthesis job output)
--   • proposed / retired / superseded beliefs (awaiting user)
--   • lykn_concepts (AI-clustered topic layer)
--   • profile blob (themes / signals / goals / vocabulary)
--   • lykn_rules (live as children of beliefs, not first-class neurons)
--
-- Plan resolution mirrors `effective_plan_for_user()` from
-- migration 029 — we depend on that function existing, so do not
-- reorder these migrations.
--
-- Service-role / migration bypass mirrors migration 052: the explicit
-- `lykn.bypass_caps` GUC short-circuits enforcement so legitimate
-- backfills can still write past the cap deliberately.
--
-- Why no NOTE trigger here:
--   `notes` already carries `enforce_vault_cap()` from migrations 029 +
--   052, capped at 50 on free. That's strictly tighter than the
--   synthesis cap (100), so a free user can never insert their 101st
--   note past the vault cap to begin with. Notes still COUNT toward the
--   synthesis total (used by the other triggers) — they just don't need
--   their own synthesis trigger because the vault cap fires first.
--
-- Why no UPDATE triggers:
--   Status transitions (proposed → active belief, inferred → confirmed
--   fact) are NOT blocked by this v1. A user past the cap can still
--   ratify an existing proposed belief — that's a known carve-out
--   because ratification is a thoughtful human-in-the-loop action and
--   blocking it mid-flow is worse UX than the cap leak it preserves.
--   Pure INSERT-time enforcement covers the high-volume bypass paths
--   (MCP token spam, /api/learned loops, direct supabase-js inserts).

-- ---------------------------------------------
-- Plan -> synthesis-neuron cap resolver
-- ---------------------------------------------
-- Mirrors PLAN_LIMITS.<plan>.synthesisNodes in src/lib/pricing-config.js.
-- NULL = unlimited (paid plans). Keep this in lockstep with the JS
-- constant — drift means the UI paywall and the DB ceiling disagree,
-- which manifests to the user as "I'm under the cap on screen but the
-- DB still refuses my write." If pricing-config.js changes, this
-- function changes in the same PR.
CREATE OR REPLACE FUNCTION public.synthesis_neuron_cap_for_plan(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 100
    WHEN 'studio'     THEN NULL      -- unlimited (Pro)
    WHEN 'studio_pro' THEN NULL      -- unlimited (Max)
    WHEN 'studio_max' THEN NULL      -- unlimited (Teams)
    ELSE 100                         -- unknown / missing -> treat as free
  END;
$$;

-- ---------------------------------------------
-- Shared explicit-neuron count helper
-- ---------------------------------------------
-- Returns the user's current count of explicit user-created neurons
-- across every contributing table. Used by every trigger below so the
-- counting rule lives in exactly one place — if the product definition
-- of "explicit neuron" changes, only this function needs an update.
--
-- SECURITY DEFINER so the trigger can count rows in tables the calling
-- role doesn't have direct read access to (e.g. service-role-only
-- writes shouldn't fail because the caller can't SELECT lykn_beliefs).
CREATE OR REPLACE FUNCTION public.count_user_explicit_neurons(p_user uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE((SELECT count(*)::int FROM public.omnia_boards         WHERE user_id = p_user), 0)
  + COALESCE((SELECT count(*)::int FROM public.notes                WHERE user_id = p_user), 0)
  + COALESCE((SELECT count(*)::int FROM public.lykn_beliefs
                WHERE user_id = p_user AND status = 'active'), 0)
  + COALESCE((SELECT count(*)::int FROM public.lykn_user_model_facts
                WHERE user_id = p_user
                  AND status IN ('stated', 'confirmed', 'corrected')), 0);
$$;

COMMENT ON FUNCTION public.count_user_explicit_neurons(uuid) IS
  'Returns the count of EXPLICIT user-created neurons (grids + notes + ratified beliefs + manual facts). AI-derived rows (inferred facts, proposed beliefs, concepts, profile blob) are intentionally excluded. Source of truth for the synthesis-neuron cap; mirrored in the SynthesisLayer.tsx userCreatedNodeCount memo.';

-- ---------------------------------------------
-- BEFORE INSERT guard: omnia_boards (grids)
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_synthesis_neuron_cap_boards()
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
  v_bypass := current_setting('lykn.bypass_caps', true);
  IF v_bypass = 'on' THEN
    RETURN NEW;
  END IF;

  v_target := NEW.user_id;
  IF v_target IS NULL THEN
    RETURN NEW;
  END IF;

  v_plan := public.effective_plan_for_user(v_target);
  v_cap  := public.synthesis_neuron_cap_for_plan(v_plan);

  -- NULL cap = unlimited (paid plans).
  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  v_current := public.count_user_explicit_neurons(v_target);

  IF v_current >= v_cap THEN
    RAISE EXCEPTION
      'synthesis_neuron_cap_reached: plan % allows % explicit neurons, user already has %',
      v_plan, v_cap, v_current
      USING ERRCODE = 'check_violation',
            HINT   = 'Upgrade to Pro for unlimited synthesis-layer neurons.';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------
-- BEFORE INSERT guard: lykn_beliefs (only when landing as active)
-- ---------------------------------------------
-- Proposed beliefs are NOT counted toward the cap (they sit in the
-- ratification inbox until the user acts on them), so we exempt them
-- here too. This keeps the AI free to keep noticing belief-shaped
-- patterns without the next nightly cluster run failing on a free
-- account at the cap.
CREATE OR REPLACE FUNCTION public.enforce_synthesis_neuron_cap_beliefs()
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
  v_bypass := current_setting('lykn.bypass_caps', true);
  IF v_bypass = 'on' THEN
    RETURN NEW;
  END IF;

  -- Only enforce when the row is landing as an explicit neuron.
  -- proposed / retired / superseded beliefs don't render in the
  -- explicit-neuron count and shouldn't block creation.
  IF NEW.status IS DISTINCT FROM 'active' THEN
    RETURN NEW;
  END IF;

  v_target := NEW.user_id;
  IF v_target IS NULL THEN
    RETURN NEW;
  END IF;

  v_plan := public.effective_plan_for_user(v_target);
  v_cap  := public.synthesis_neuron_cap_for_plan(v_plan);

  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  v_current := public.count_user_explicit_neurons(v_target);

  IF v_current >= v_cap THEN
    RAISE EXCEPTION
      'synthesis_neuron_cap_reached: plan % allows % explicit neurons, user already has %',
      v_plan, v_cap, v_current
      USING ERRCODE = 'check_violation',
            HINT   = 'Upgrade to Pro for unlimited synthesis-layer neurons.';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------
-- BEFORE INSERT guard: lykn_user_model_facts (only explicit statuses)
-- ---------------------------------------------
-- The nightly synthesis job inserts 'inferred' facts in bulk. Those
-- carry no cap weight and must never be blocked — gating the trigger
-- on status keeps the AI's observation pipeline free regardless of
-- the user's plan. Manual facts (status='stated'|'confirmed'|
-- 'corrected') ARE the explicit-neuron kind, and DO get blocked when
-- the user is at the cap.
CREATE OR REPLACE FUNCTION public.enforce_synthesis_neuron_cap_facts()
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
  v_bypass := current_setting('lykn.bypass_caps', true);
  IF v_bypass = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NULL OR NEW.status NOT IN ('stated', 'confirmed', 'corrected') THEN
    RETURN NEW;
  END IF;

  v_target := NEW.user_id;
  IF v_target IS NULL THEN
    RETURN NEW;
  END IF;

  v_plan := public.effective_plan_for_user(v_target);
  v_cap  := public.synthesis_neuron_cap_for_plan(v_plan);

  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  v_current := public.count_user_explicit_neurons(v_target);

  IF v_current >= v_cap THEN
    RAISE EXCEPTION
      'synthesis_neuron_cap_reached: plan % allows % explicit neurons, user already has %',
      v_plan, v_cap, v_current
      USING ERRCODE = 'check_violation',
            HINT   = 'Upgrade to Pro for unlimited synthesis-layer neurons.';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------
-- Wire the triggers
-- ---------------------------------------------
DROP TRIGGER IF EXISTS trg_omnia_boards_synthesis_cap ON public.omnia_boards;
CREATE TRIGGER trg_omnia_boards_synthesis_cap
  BEFORE INSERT ON public.omnia_boards
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_synthesis_neuron_cap_boards();

DROP TRIGGER IF EXISTS trg_lykn_beliefs_synthesis_cap ON public.lykn_beliefs;
CREATE TRIGGER trg_lykn_beliefs_synthesis_cap
  BEFORE INSERT ON public.lykn_beliefs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_synthesis_neuron_cap_beliefs();

DROP TRIGGER IF EXISTS trg_lykn_user_model_facts_synthesis_cap ON public.lykn_user_model_facts;
CREATE TRIGGER trg_lykn_user_model_facts_synthesis_cap
  BEFORE INSERT ON public.lykn_user_model_facts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_synthesis_neuron_cap_facts();
