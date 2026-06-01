-- ============================================
-- Scale perf: O(1) synthesis-neuron counts + atomic session increments
-- Migration: 072_scale_perf.sql
-- ============================================
--
-- Problem: migration 066's count_user_explicit_neurons() runs four full
-- table scans on every grid/belief/fact INSERT. At 144+ users that
-- pegs CPU and connections. Usage tracking also did GET+PATCH per chat
-- turn (two round trips, race-prone).
--
-- Fixes:
--   1. lykn_synthesis_neuron_counts — maintained incrementally via
--      AFTER triggers; cap guards read O(1) from the counter row.
--   2. increment_session_totals RPC — single atomic UPDATE for session
--      cost/token/credit deltas + last_activity_at (service_role only).

-- ---------------------------------------------
-- 1. Cached explicit-neuron counter per user
-- ---------------------------------------------

CREATE TABLE IF NOT EXISTS public.lykn_synthesis_neuron_counts (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  explicit_count integer NOT NULL DEFAULT 0 CHECK (explicit_count >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.lykn_synthesis_neuron_counts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.lykn_synthesis_neuron_counts IS
  'Incremental cache of explicit synthesis neurons per user. Maintained by AFTER triggers; read by cap enforcement (066).';

-- ---------------------------------------------
-- Helpers
-- ---------------------------------------------

CREATE OR REPLACE FUNCTION public.belief_counts_as_explicit_neuron(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p_status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.fact_counts_as_explicit_neuron(p_status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p_status IN ('stated', 'confirmed', 'corrected');
$$;

-- Full recompute from source tables — backfill / repair only.
CREATE OR REPLACE FUNCTION public.recompute_synthesis_neuron_count_from_tables(p_user uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
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

CREATE OR REPLACE FUNCTION public.adjust_synthesis_neuron_count(p_user uuid, p_delta integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_user IS NULL OR p_delta = 0 THEN
    RETURN;
  END IF;

  INSERT INTO public.lykn_synthesis_neuron_counts (user_id, explicit_count)
  VALUES (p_user, GREATEST(p_delta, 0))
  ON CONFLICT (user_id) DO UPDATE SET
    explicit_count = GREATEST(0, public.lykn_synthesis_neuron_counts.explicit_count + p_delta),
    updated_at     = now();
END;
$$;

-- Hot path: O(1) read for cap enforcement.
CREATE OR REPLACE FUNCTION public.count_user_explicit_neurons(p_user uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    (SELECT explicit_count FROM public.lykn_synthesis_neuron_counts WHERE user_id = p_user),
    0
  );
$$;

COMMENT ON FUNCTION public.count_user_explicit_neurons(uuid) IS
  'O(1) read of cached explicit-neuron count (grids + notes + active beliefs + manual facts). Maintained by maintain_synthesis_neuron_count_* triggers.';

-- ---------------------------------------------
-- AFTER triggers: keep counter in sync
-- ---------------------------------------------

CREATE OR REPLACE FUNCTION public.maintain_synthesis_neuron_count_boards()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.user_id IS NOT NULL THEN
    PERFORM public.adjust_synthesis_neuron_count(NEW.user_id, 1);
  ELSIF TG_OP = 'DELETE' AND OLD.user_id IS NOT NULL THEN
    PERFORM public.adjust_synthesis_neuron_count(OLD.user_id, -1);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.maintain_synthesis_neuron_count_notes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.user_id IS NOT NULL THEN
    PERFORM public.adjust_synthesis_neuron_count(NEW.user_id, 1);
  ELSIF TG_OP = 'DELETE' AND OLD.user_id IS NOT NULL THEN
    PERFORM public.adjust_synthesis_neuron_count(OLD.user_id, -1);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.maintain_synthesis_neuron_count_beliefs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NOT NULL AND public.belief_counts_as_explicit_neuron(NEW.status) THEN
      PERFORM public.adjust_synthesis_neuron_count(NEW.user_id, 1);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.user_id IS NOT NULL AND public.belief_counts_as_explicit_neuron(OLD.status) THEN
      PERFORM public.adjust_synthesis_neuron_count(OLD.user_id, -1);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS NOT NULL
       AND NOT public.belief_counts_as_explicit_neuron(OLD.status)
       AND public.belief_counts_as_explicit_neuron(NEW.status) THEN
      PERFORM public.adjust_synthesis_neuron_count(NEW.user_id, 1);
    ELSIF OLD.user_id IS NOT NULL
       AND public.belief_counts_as_explicit_neuron(OLD.status)
       AND NOT public.belief_counts_as_explicit_neuron(NEW.status) THEN
      PERFORM public.adjust_synthesis_neuron_count(OLD.user_id, -1);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.maintain_synthesis_neuron_count_facts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS NOT NULL AND public.fact_counts_as_explicit_neuron(NEW.status) THEN
      PERFORM public.adjust_synthesis_neuron_count(NEW.user_id, 1);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.user_id IS NOT NULL AND public.fact_counts_as_explicit_neuron(OLD.status) THEN
      PERFORM public.adjust_synthesis_neuron_count(OLD.user_id, -1);
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.user_id IS NOT NULL
       AND NOT public.fact_counts_as_explicit_neuron(OLD.status)
       AND public.fact_counts_as_explicit_neuron(NEW.status) THEN
      PERFORM public.adjust_synthesis_neuron_count(NEW.user_id, 1);
    ELSIF OLD.user_id IS NOT NULL
       AND public.fact_counts_as_explicit_neuron(OLD.status)
       AND NOT public.fact_counts_as_explicit_neuron(NEW.status) THEN
      PERFORM public.adjust_synthesis_neuron_count(OLD.user_id, -1);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_omnia_boards_synthesis_count ON public.omnia_boards;
CREATE TRIGGER trg_omnia_boards_synthesis_count
  AFTER INSERT OR DELETE ON public.omnia_boards
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_synthesis_neuron_count_boards();

DROP TRIGGER IF EXISTS trg_notes_synthesis_count ON public.notes;
CREATE TRIGGER trg_notes_synthesis_count
  AFTER INSERT OR DELETE ON public.notes
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_synthesis_neuron_count_notes();

DROP TRIGGER IF EXISTS trg_lykn_beliefs_synthesis_count ON public.lykn_beliefs;
CREATE TRIGGER trg_lykn_beliefs_synthesis_count
  AFTER INSERT OR DELETE OR UPDATE OF status ON public.lykn_beliefs
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_synthesis_neuron_count_beliefs();

DROP TRIGGER IF EXISTS trg_lykn_user_model_facts_synthesis_count ON public.lykn_user_model_facts;
CREATE TRIGGER trg_lykn_user_model_facts_synthesis_count
  AFTER INSERT OR DELETE OR UPDATE OF status ON public.lykn_user_model_facts
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_synthesis_neuron_count_facts();

-- Backfill counters for every user who has at least one contributing row.
INSERT INTO public.lykn_synthesis_neuron_counts (user_id, explicit_count)
SELECT u.user_id, public.recompute_synthesis_neuron_count_from_tables(u.user_id)
FROM (
  SELECT user_id FROM public.omnia_boards
  UNION
  SELECT user_id FROM public.notes
  UNION
  SELECT user_id FROM public.lykn_beliefs WHERE status = 'active'
  UNION
  SELECT user_id FROM public.lykn_user_model_facts
    WHERE status IN ('stated', 'confirmed', 'corrected')
) u
ON CONFLICT (user_id) DO UPDATE SET
  explicit_count = EXCLUDED.explicit_count,
  updated_at     = now();

-- ---------------------------------------------
-- 2. Atomic session total increments (service role)
-- ---------------------------------------------

CREATE OR REPLACE FUNCTION public.increment_session_totals(
  p_session_id    uuid,
  p_cost_delta    numeric DEFAULT 0,
  p_tokens_delta  integer DEFAULT 0,
  p_credits_delta integer DEFAULT 0
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.sessions
  SET
    total_cost       = total_cost + COALESCE(p_cost_delta, 0),
    total_tokens     = total_tokens + COALESCE(p_tokens_delta, 0),
    total_credits    = total_credits + COALESCE(p_credits_delta, 0),
    last_activity_at = now()
  WHERE id = p_session_id
    AND ended_at IS NULL;
$$;

COMMENT ON FUNCTION public.increment_session_totals(uuid, numeric, integer, integer) IS
  'Atomically bump session usage totals + last_activity_at. Called by usageTracking.js (debounced).';

GRANT EXECUTE ON FUNCTION public.increment_session_totals(uuid, numeric, integer, integer)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.recompute_synthesis_neuron_count_from_tables(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.adjust_synthesis_neuron_count(uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.belief_counts_as_explicit_neuron(text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fact_counts_as_explicit_neuron(text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.maintain_synthesis_neuron_count_boards()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.maintain_synthesis_neuron_count_notes()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.maintain_synthesis_neuron_count_beliefs()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.maintain_synthesis_neuron_count_facts()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.increment_session_totals(uuid, numeric, integer, integer)
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
