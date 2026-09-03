-- ============================================================================
-- 134 — Usage pricing profiles + monthly plan bucket
-- ============================================================================
--
-- Extends the 131 Usage Balance ledger:
--   • new 'plan' bucket: monthly subscription usage, expires at period end
--   • per-lot pricing_profile: the internal rate for money in that lot
--   • cost-based allocation: metered work costs RAW provider micros; the
--     customer charge per lot is raw × the lot's profile (rational integer
--     math, ceil — no floats)
--
-- Profile ratios are NOT stored here. The server passes them per call
-- (lib/billing/pricingProfiles.js is the single source of truth), so
-- economics changes never require a DB migration.
--
-- Spending order: plan → included → promotional (earliest expiry first)
-- → purchased. Expired lots are skipped and cannot debit purchased funds.
--
-- v1 RPCs from 131 remain untouched for older deploys. New code uses the
-- *_cost RPCs below. Re-running this file is safe (IF NOT EXISTS /
-- CREATE OR REPLACE).

-- ── Schema ───────────────────────────────────────────────────────────────────

ALTER TABLE public.lykn_usage_lots
  ADD COLUMN IF NOT EXISTS pricing_profile text;

ALTER TABLE public.lykn_usage_lots
  DROP CONSTRAINT IF EXISTS lykn_usage_lots_bucket_check;
ALTER TABLE public.lykn_usage_lots
  ADD CONSTRAINT lykn_usage_lots_bucket_check
  CHECK (bucket IN ('purchased', 'promotional', 'included', 'plan'));

ALTER TABLE public.lykn_usage_balances
  ADD COLUMN IF NOT EXISTS plan_micros bigint NOT NULL DEFAULT 0;

ALTER TABLE public.lykn_usage_reservations
  ADD COLUMN IF NOT EXISTS raw_micros bigint;

COMMENT ON COLUMN public.lykn_usage_lots.pricing_profile IS
  'Internal pricing profile key (topup / promotional / pro_monthly / student_monthly / max_monthly). Ratios live server-side.';

-- ── Summary refresh (v2, includes plan bucket) ───────────────────────────────

CREATE OR REPLACE FUNCTION public.lykn_usage_refresh_summary(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.lykn_usage_balances b
  SET
    purchased_micros = COALESCE((
      SELECT SUM(remaining_micros) FROM public.lykn_usage_lots
      WHERE user_id = p_user_id AND bucket = 'purchased'
        AND (expires_at IS NULL OR expires_at > now())
    ), 0),
    promotional_micros = COALESCE((
      SELECT SUM(remaining_micros) FROM public.lykn_usage_lots
      WHERE user_id = p_user_id AND bucket = 'promotional'
        AND (expires_at IS NULL OR expires_at > now())
    ), 0),
    included_micros = COALESCE((
      SELECT SUM(remaining_micros) FROM public.lykn_usage_lots
      WHERE user_id = p_user_id AND bucket = 'included'
        AND (expires_at IS NULL OR expires_at > now())
    ), 0),
    plan_micros = COALESCE((
      SELECT SUM(remaining_micros) FROM public.lykn_usage_lots
      WHERE user_id = p_user_id AND bucket = 'plan'
        AND (expires_at IS NULL OR expires_at > now())
    ), 0)
  WHERE b.user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_balance(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.lykn_usage_balances%ROWTYPE;
  v_expired bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user_id');
  END IF;

  PERFORM public.lykn_usage_ensure_balance(p_user_id);
  PERFORM public.lykn_usage_refresh_summary(p_user_id);

  SELECT * INTO v_row FROM public.lykn_usage_balances WHERE user_id = p_user_id;
  SELECT COALESCE(SUM(remaining_micros), 0) INTO v_expired
  FROM public.lykn_usage_lots
  WHERE user_id = p_user_id
    AND expires_at IS NOT NULL
    AND expires_at <= now();

  RETURN jsonb_build_object(
    'ok', true,
    'purchased_micros', v_row.purchased_micros,
    'promotional_micros', v_row.promotional_micros,
    'included_micros', v_row.included_micros,
    'plan_micros', v_row.plan_micros,
    'available_micros', v_row.purchased_micros + v_row.promotional_micros
      + v_row.included_micros + v_row.plan_micros,
    'expired_micros', v_expired,
    'expired_promotional_micros', v_expired,
    'reserved_micros', v_row.reserved_micros,
    'currency', v_row.currency
  );
END;
$$;

-- ── Profile helpers ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lykn_usage_profile_ratio(
  p_profiles jsonb,
  p_profile text,
  p_bucket text
)
RETURNS int[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_key text := p_profile;
  v_entry jsonb;
  v_num int;
  v_den int;
BEGIN
  IF v_key IS NULL OR NOT (p_profiles ? v_key) THEN
    v_key := CASE p_bucket
      WHEN 'purchased' THEN 'topup'
      WHEN 'promotional' THEN 'promotional'
      WHEN 'plan' THEN 'pro_monthly'
      WHEN 'included' THEN 'pro_monthly'
      ELSE 'topup'
    END;
  END IF;
  IF NOT (p_profiles ? v_key) THEN
    v_key := 'topup';
  END IF;
  v_entry := p_profiles -> v_key;
  v_num := COALESCE((v_entry->>'num')::int, 1);
  v_den := COALESCE((v_entry->>'den')::int, 1);
  IF v_num < 1 OR v_den < 1 OR v_num < v_den THEN
    -- Never allow a ratio below 1.0: a bad payload cannot undercharge.
    v_num := GREATEST(v_num, v_den, 1);
    v_den := GREATEST(v_den, 1);
  END IF;
  RETURN ARRAY[v_num, v_den];
END;
$$;

-- ── Cost-based allocation ────────────────────────────────────────────────────
-- Allocates a RAW provider cost across lots. Returns per-lot allocations
-- with both the raw portion covered and the customer charge debited.
-- Capacity rounds up so a nearly-empty lot drains instead of stranding.

CREATE OR REPLACE FUNCTION public.lykn_usage_allocate_cost(
  p_user_id uuid,
  p_raw_micros bigint,
  p_profiles jsonb,
  p_allow_partial boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_left bigint := p_raw_micros;
  v_charge_total bigint := 0;
  v_lot public.lykn_usage_lots%ROWTYPE;
  v_ratio int[];
  v_capacity bigint;
  v_take_raw bigint;
  v_charge bigint;
  v_profile text;
  v_alloc jsonb := '[]'::jsonb;
BEGIN
  FOR v_lot IN
    SELECT * FROM public.lykn_usage_lots
    WHERE user_id = p_user_id
    ORDER BY
      CASE bucket
        WHEN 'plan' THEN 0
        WHEN 'included' THEN 1
        WHEN 'promotional' THEN 2
        WHEN 'purchased' THEN 3
        ELSE 9
      END,
      expires_at ASC NULLS LAST,
      created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    CONTINUE WHEN v_lot.remaining_micros <= 0;
    CONTINUE WHEN v_lot.expires_at IS NOT NULL AND v_lot.expires_at <= now();

    v_ratio := public.lykn_usage_profile_ratio(p_profiles, v_lot.pricing_profile, v_lot.bucket);
    v_profile := COALESCE(v_lot.pricing_profile, CASE v_lot.bucket
      WHEN 'purchased' THEN 'topup'
      WHEN 'promotional' THEN 'promotional'
      ELSE 'pro_monthly'
    END);
    -- capacity = ceil(remaining * den / num)
    v_capacity := (v_lot.remaining_micros * v_ratio[2] + v_ratio[1] - 1) / v_ratio[1];
    CONTINUE WHEN v_capacity <= 0;
    v_take_raw := LEAST(v_capacity, v_left);
    -- charge = min(remaining, ceil(take * num / den))
    v_charge := LEAST(
      v_lot.remaining_micros,
      (v_take_raw * v_ratio[1] + v_ratio[2] - 1) / v_ratio[2]
    );
    CONTINUE WHEN v_charge <= 0 AND v_take_raw <= 0;

    UPDATE public.lykn_usage_lots
      SET remaining_micros = remaining_micros - v_charge
      WHERE id = v_lot.id;

    v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
      'lot_id', v_lot.id,
      'bucket', v_lot.bucket,
      'pricing_profile', v_profile,
      'raw_micros', v_take_raw,
      'micros', v_charge
    ));
    v_charge_total := v_charge_total + v_charge;
    v_left := v_left - v_take_raw;
  END LOOP;

  IF v_left > 0 AND NOT p_allow_partial THEN
    -- Roll back the lot updates by raising: the caller RPC's transaction
    -- aborts, so partial deductions never persist.
    RAISE EXCEPTION 'lykn_usage_insufficient' USING ERRCODE = 'P0001',
      DETAIL = jsonb_build_object('shortfall_raw_micros', v_left)::text;
  END IF;

  RETURN jsonb_build_object(
    'ok', v_left = 0,
    'allocations', v_alloc,
    'charge_micros', v_charge_total,
    'covered_raw_micros', p_raw_micros - v_left,
    'shortfall_raw_micros', v_left
  );
END;
$$;

-- ── Grant v2 (bucket + pricing profile) ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lykn_usage_grant_v2(
  p_user_id uuid,
  p_amount_micros bigint,
  p_bucket text,
  p_pricing_profile text DEFAULT NULL,
  p_txn_type text DEFAULT 'promotional_grant',
  p_expires_at timestamptz DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.lykn_usage_ledger%ROWTYPE;
  v_available bigint;
BEGIN
  IF p_user_id IS NULL OR p_amount_micros IS NULL OR p_amount_micros <= 0 OR p_amount_micros > 1000000000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_bucket NOT IN ('purchased', 'promotional', 'included', 'plan') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_bucket');
  END IF;

  PERFORM public.lykn_usage_ensure_balance(p_user_id);
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.lykn_usage_ledger WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'available', public.lykn_usage_available_micros(p_user_id), 'ledgerId', v_existing.id);
    END IF;
  END IF;

  INSERT INTO public.lykn_usage_lots (user_id, bucket, pricing_profile, remaining_micros, expires_at)
  VALUES (p_user_id, p_bucket, p_pricing_profile, p_amount_micros, p_expires_at);

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type, bucket, idempotency_key, metadata,
    resulting_available_micros
  ) VALUES (
    p_user_id, p_amount_micros, 'credit', COALESCE(p_txn_type, 'promotional_grant'), p_bucket,
    p_idempotency_key,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('pricing_profile', p_pricing_profile),
    public.lykn_usage_available_micros(p_user_id)
  );

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  v_available := public.lykn_usage_available_micros(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'available', v_available);
END;
$$;

-- ── Reserve (raw cost) ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lykn_usage_reserve_cost(
  p_user_id uuid,
  p_raw_micros bigint,
  p_profiles jsonb,
  p_action_type text DEFAULT NULL,
  p_pricing_version text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.lykn_usage_reservations%ROWTYPE;
  v_plan jsonb;
  v_res_id uuid;
  v_charge bigint;
BEGIN
  IF p_user_id IS NULL OR p_raw_micros IS NULL OR p_raw_micros <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  PERFORM public.lykn_usage_ensure_balance(p_user_id);
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.lykn_usage_reservations WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'reservationId', v_existing.id,
        'chargeMicros', v_existing.amount_micros, 'allocations', v_existing.allocations);
    END IF;
  END IF;

  BEGIN
    v_plan := public.lykn_usage_allocate_cost(p_user_id, p_raw_micros, p_profiles, false);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_usage_balance',
      'available_micros', public.lykn_usage_available_micros(p_user_id),
      'required_raw_micros', p_raw_micros
    );
  END;

  v_charge := (v_plan->>'charge_micros')::bigint;

  INSERT INTO public.lykn_usage_reservations (
    user_id, amount_micros, raw_micros, status, idempotency_key, allocations, action_type, pricing_version
  ) VALUES (
    p_user_id, GREATEST(v_charge, 1), p_raw_micros, 'open', p_idempotency_key,
    v_plan->'allocations', p_action_type, p_pricing_version
  ) RETURNING id INTO v_res_id;

  UPDATE public.lykn_usage_balances
    SET reserved_micros = reserved_micros + v_charge
    WHERE user_id = p_user_id;

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type, reservation_id, idempotency_key,
    action_type, pricing_version, status, metadata, resulting_available_micros
  ) VALUES (
    p_user_id, GREATEST(v_charge, 1), 'debit', 'reservation', v_res_id, p_idempotency_key,
    p_action_type, p_pricing_version, 'reserved',
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'raw_cost_micros', p_raw_micros,
      'allocations', v_plan->'allocations'
    ),
    public.lykn_usage_available_micros(p_user_id)
  );

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'reservationId', v_res_id,
    'chargeMicros', v_charge, 'allocations', v_plan->'allocations');
END;
$$;

-- ── Settle (raw cost) ────────────────────────────────────────────────────────
-- Credits the reservation back in full, then re-allocates the actual raw
-- cost. The unused remainder returns to its original lots.

CREATE OR REPLACE FUNCTION public.lykn_usage_settle_cost(
  p_user_id uuid,
  p_reservation_id uuid,
  p_actual_raw_micros bigint,
  p_profiles jsonb,
  p_provider_cost_micros bigint DEFAULT 0,
  p_pricing_version text DEFAULT NULL,
  p_action_type text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_run_id text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res public.lykn_usage_reservations%ROWTYPE;
  v_actual bigint;
  v_reserved_raw bigint;
  v_plan jsonb;
  v_charge bigint := 0;
  v_released bigint;
BEGIN
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;
  SELECT * INTO v_res FROM public.lykn_usage_reservations WHERE id = p_reservation_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reservation_missing');
  END IF;
  IF v_res.status = 'settled' THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'reservationId', v_res.id);
  END IF;
  IF v_res.status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reservation_closed');
  END IF;

  v_reserved_raw := COALESCE(v_res.raw_micros, v_res.amount_micros);
  v_actual := COALESCE(p_actual_raw_micros, v_reserved_raw);
  IF v_actual < 0 OR v_actual > v_reserved_raw THEN
    RETURN jsonb_build_object('ok', false, 'error', 'settle_exceeds_reserve');
  END IF;

  PERFORM public.lykn_usage_credit_allocations(p_user_id, v_res.allocations);

  IF v_actual > 0 THEN
    v_plan := public.lykn_usage_allocate_cost(p_user_id, v_actual, p_profiles, true);
    v_charge := (v_plan->>'charge_micros')::bigint;
    IF v_charge > 0 THEN
      INSERT INTO public.lykn_usage_ledger (
        user_id, amount_micros, direction, txn_type, reservation_id,
        provider_cost_micros, customer_charge_micros, pricing_version,
        action_type, model, provider, run_id, metadata, resulting_available_micros
      ) VALUES (
        p_user_id, v_charge, 'debit', 'usage_charge', v_res.id,
        COALESCE(p_provider_cost_micros, 0), v_charge, COALESCE(p_pricing_version, v_res.pricing_version),
        COALESCE(p_action_type, v_res.action_type), p_model, p_provider, p_run_id,
        COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
          'raw_cost_micros', v_actual,
          'allocations', v_plan->'allocations'
        ),
        public.lykn_usage_available_micros(p_user_id)
      );
    END IF;
  END IF;

  v_released := GREATEST(0, v_res.amount_micros - v_charge);
  IF v_released > 0 THEN
    INSERT INTO public.lykn_usage_ledger (
      user_id, amount_micros, direction, txn_type, reservation_id, metadata, resulting_available_micros
    ) VALUES (
      p_user_id, v_released, 'credit', 'reservation_release', v_res.id,
      jsonb_build_object('unused', true),
      public.lykn_usage_available_micros(p_user_id)
    );
  END IF;

  UPDATE public.lykn_usage_reservations SET status = 'settled', updated_at = now() WHERE id = v_res.id;
  UPDATE public.lykn_usage_balances
    SET reserved_micros = GREATEST(0, reserved_micros - v_res.amount_micros)
    WHERE user_id = p_user_id;

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'chargedMicros', v_charge, 'releasedMicros', v_released);
END;
$$;

-- ── Direct charge (raw cost, optional partial drain) ─────────────────────────
-- p_allow_partial = true drains whatever remains instead of failing: the
-- balance can reach exactly $0 from streamed work but never goes negative.

CREATE OR REPLACE FUNCTION public.lykn_usage_charge_cost(
  p_user_id uuid,
  p_raw_micros bigint,
  p_profiles jsonb,
  p_allow_partial boolean DEFAULT false,
  p_provider_cost_micros bigint DEFAULT 0,
  p_pricing_version text DEFAULT NULL,
  p_action_type text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_run_id text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing public.lykn_usage_ledger%ROWTYPE;
  v_plan jsonb;
  v_charge bigint;
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_raw_micros IS NULL OR p_raw_micros <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  PERFORM public.lykn_usage_ensure_balance(p_user_id);
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.lykn_usage_ledger WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'ledgerId', v_existing.id, 'chargedMicros', v_existing.amount_micros);
    END IF;
  END IF;

  BEGIN
    v_plan := public.lykn_usage_allocate_cost(p_user_id, p_raw_micros, p_profiles, p_allow_partial);
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_usage_balance',
      'available_micros', public.lykn_usage_available_micros(p_user_id),
      'required_raw_micros', p_raw_micros
    );
  END;

  v_charge := (v_plan->>'charge_micros')::bigint;
  IF v_charge <= 0 THEN
    RETURN jsonb_build_object(
      'ok', true, 'duplicate', false, 'partial', (v_plan->>'ok')::boolean IS NOT TRUE,
      'chargedMicros', 0,
      'coveredRawMicros', (v_plan->>'covered_raw_micros')::bigint,
      'shortfallRawMicros', (v_plan->>'shortfall_raw_micros')::bigint
    );
  END IF;

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type,
    provider_cost_micros, customer_charge_micros, pricing_version,
    action_type, model, provider, run_id, idempotency_key, metadata, resulting_available_micros
  ) VALUES (
    p_user_id, v_charge, 'debit', 'usage_charge',
    COALESCE(p_provider_cost_micros, 0), v_charge, p_pricing_version,
    p_action_type, p_model, p_provider, p_run_id, p_idempotency_key,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
      'raw_cost_micros', (v_plan->>'covered_raw_micros')::bigint,
      'shortfall_raw_micros', (v_plan->>'shortfall_raw_micros')::bigint,
      'allocations', v_plan->'allocations'
    ),
    public.lykn_usage_available_micros(p_user_id)
  ) RETURNING id INTO v_id;

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  RETURN jsonb_build_object(
    'ok', true, 'duplicate', false,
    'partial', (v_plan->>'ok')::boolean IS NOT TRUE,
    'ledgerId', v_id,
    'chargedMicros', v_charge,
    'coveredRawMicros', (v_plan->>'covered_raw_micros')::bigint,
    'shortfallRawMicros', (v_plan->>'shortfall_raw_micros')::bigint
  );
END;
$$;

-- ── Permissions ──────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.lykn_usage_profile_ratio(jsonb, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_allocate_cost(uuid, bigint, jsonb, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_grant_v2(uuid, bigint, text, text, text, timestamptz, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_reserve_cost(uuid, bigint, jsonb, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_settle_cost(uuid, uuid, bigint, jsonb, bigint, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_charge_cost(uuid, bigint, jsonb, boolean, bigint, text, text, text, text, text, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.lykn_usage_grant_v2(uuid, bigint, text, text, text, timestamptz, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_reserve_cost(uuid, bigint, jsonb, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_settle_cost(uuid, uuid, bigint, jsonb, bigint, text, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_charge_cost(uuid, bigint, jsonb, boolean, bigint, text, text, text, text, text, text, jsonb) TO service_role;
