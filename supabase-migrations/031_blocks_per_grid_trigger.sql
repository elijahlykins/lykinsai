-- ============================================
-- Blocks-per-grid cap enforcement
-- Migration: 031_blocks_per_grid_trigger.sql
-- ============================================
--
-- `src/store/canvasStore.ts` already refuses to add more than `blocksPerGrid`
-- blocks to a canvas (see `PLAN_LIMITS` in `src/lib/pricing-config.js`). This
-- migration backs that up with a DB-level trigger so a tampered client or
-- direct supabase-js call can't blow past the cap by upserting a bloated
-- state blob into `omnia_board_states`.
--
-- Per-plan caps (mirrored from `PLAN_LIMITS.blocksPerGrid`):
--   free        -> 50
--   studio      -> unlimited (NULL)
--   studio_pro  -> unlimited (NULL)
--   studio_max  -> unlimited (NULL)
--
-- Plan resolution reuses `public.effective_plan_for_user` from migration 029
-- (which collapses inactive paid subscriptions down to 'free').
--
-- Legacy-data tolerance: if a board was saved with more blocks than the cap
-- before this trigger existed (or before the user downgraded), we don't want
-- to wedge them out of saving. The trigger only blocks saves where the new
-- block count exceeds the cap AND is strictly greater than what was already
-- in the row. That lets users keep editing and trimming an over-cap grid
-- without adding more to it.

-- ---------------------------------------------
-- Plan -> blocks-per-grid cap resolver
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.blocks_per_grid_cap(p_plan text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_plan
    WHEN 'free'       THEN 50
    WHEN 'studio'     THEN NULL      -- unlimited
    WHEN 'studio_pro' THEN NULL      -- unlimited
    WHEN 'studio_max' THEN NULL      -- unlimited
    ELSE 50                          -- unknown / missing -> treat as free
  END;
$$;

-- ---------------------------------------------
-- Count blocks inside a state blob. Returns NULL if the blob shape isn't
-- recognizable so the trigger can opt out of enforcement rather than
-- blocking a legitimate save.
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.block_count_for_state(p_state jsonb)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_blocks jsonb;
BEGIN
  IF p_state IS NULL OR jsonb_typeof(p_state) <> 'object' THEN
    RETURN NULL;
  END IF;
  v_blocks := p_state->'blocks';
  IF v_blocks IS NULL OR jsonb_typeof(v_blocks) <> 'object' THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT count(*)::int FROM jsonb_object_keys(v_blocks));
END;
$$;

-- ---------------------------------------------
-- BEFORE INSERT/UPDATE guard on omnia_board_states
-- ---------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_blocks_per_grid_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller        uuid;
  v_plan          text;
  v_cap           integer;
  v_new_count     integer;
  v_existing      integer;
BEGIN
  -- Service role / direct-SQL / migrations have a NULL auth.uid() and bypass.
  v_caller := auth.uid();
  IF v_caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only enforce on the caller's own rows. Cross-user writes are blocked by
  -- RLS separately; this is just a defensive short-circuit.
  IF NEW.user_id IS NULL OR NEW.user_id <> v_caller THEN
    RETURN NEW;
  END IF;

  v_new_count := public.block_count_for_state(NEW.state);
  -- Unknown shape -> don't second-guess the client, let the save through.
  IF v_new_count IS NULL THEN
    RETURN NEW;
  END IF;

  v_plan := public.effective_plan_for_user(v_caller);
  v_cap  := public.blocks_per_grid_cap(v_plan);

  -- NULL cap = unlimited.
  IF v_cap IS NULL THEN
    RETURN NEW;
  END IF;

  -- Under the cap? Fine.
  IF v_new_count <= v_cap THEN
    RETURN NEW;
  END IF;

  -- Over the cap — but tolerate legacy/over-cap grids as long as we're not
  -- growing them. For UPDATEs, compare against the existing stored count.
  IF TG_OP = 'UPDATE' THEN
    v_existing := public.block_count_for_state(OLD.state);
    IF v_existing IS NOT NULL AND v_new_count <= v_existing THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'blocks_per_grid_cap_reached: plan % allows % blocks per grid, this grid now has %',
    v_plan, v_cap, v_new_count
    USING ERRCODE = 'check_violation',
          HINT   = 'Upgrade your plan or delete blocks to save more on this grid.';
END;
$$;

-- BEFORE INSERT *and* UPDATE — upserts hit both paths depending on whether
-- the row already exists.
DROP TRIGGER IF EXISTS trg_board_states_blocks_cap ON public.omnia_board_states;
CREATE TRIGGER trg_board_states_blocks_cap
  BEFORE INSERT OR UPDATE ON public.omnia_board_states
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_blocks_per_grid_cap();
