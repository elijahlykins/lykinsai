-- ============================================================================
-- 131 — Usage Balance ledger (dollar-denominated prepaid compute)
-- ============================================================================
--
-- Customer-facing money is dollars.
-- Internal unit is microdollars (1 USD = 1,000,000 micros).
--
-- This is parallel to lykn_credit_wallets. Do not convert or delete credits.
-- Users may read their own rows. Only service_role RPCs may write.
--
-- Spending order (locked, not row-order dependent):
--   promotional (earliest expiry first), then included, then purchased.
-- Expired promotional lots are skipped and cannot debit purchased funds.

CREATE TABLE IF NOT EXISTS public.lykn_usage_balances (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  purchased_micros     bigint NOT NULL DEFAULT 0 CHECK (purchased_micros >= 0),
  promotional_micros   bigint NOT NULL DEFAULT 0 CHECK (promotional_micros >= 0),
  included_micros      bigint NOT NULL DEFAULT 0 CHECK (included_micros >= 0),
  reserved_micros      bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
  currency             text NOT NULL DEFAULT 'usd',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lykn_usage_lots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket               text NOT NULL CHECK (bucket IN ('purchased', 'promotional', 'included')),
  remaining_micros     bigint NOT NULL CHECK (remaining_micros >= 0),
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_usage_lots_user_spend_idx
  ON public.lykn_usage_lots (user_id, bucket, expires_at, created_at);

CREATE TABLE IF NOT EXISTS public.lykn_usage_reservations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_micros        bigint NOT NULL CHECK (amount_micros > 0),
  status               text NOT NULL CHECK (status IN ('open', 'settled', 'released')),
  idempotency_key      text UNIQUE,
  allocations          jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_type          text,
  pricing_version      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lykn_usage_ledger (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_micros              bigint NOT NULL CHECK (amount_micros > 0),
  direction                  text NOT NULL CHECK (direction IN ('credit', 'debit')),
  txn_type                   text NOT NULL,
  bucket                     text,
  currency                   text NOT NULL DEFAULT 'usd',
  provider_cost_micros       bigint,
  customer_charge_micros     bigint,
  pricing_version            text,
  action_type                text,
  run_id                     text,
  model                      text,
  provider                   text,
  stripe_session_id          text,
  stripe_event_id            text,
  idempotency_key            text UNIQUE,
  reservation_id             uuid,
  status                     text NOT NULL DEFAULT 'posted',
  resulting_available_micros bigint,
  metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lykn_usage_ledger_funding_session_uidx
  ON public.lykn_usage_ledger (stripe_session_id)
  WHERE stripe_session_id IS NOT NULL AND txn_type = 'funding';

CREATE INDEX IF NOT EXISTS lykn_usage_ledger_user_created_idx
  ON public.lykn_usage_ledger (user_id, created_at DESC);

ALTER TABLE public.lykn_usage_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_usage_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_usage_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_usage_balances_select_own ON public.lykn_usage_balances;
CREATE POLICY lykn_usage_balances_select_own
  ON public.lykn_usage_balances FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_usage_lots_select_own ON public.lykn_usage_lots;
CREATE POLICY lykn_usage_lots_select_own
  ON public.lykn_usage_lots FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_usage_reservations_select_own ON public.lykn_usage_reservations;
CREATE POLICY lykn_usage_reservations_select_own
  ON public.lykn_usage_reservations FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_usage_ledger_select_own ON public.lykn_usage_ledger;
CREATE POLICY lykn_usage_ledger_select_own
  ON public.lykn_usage_ledger FOR SELECT TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_usage_balances IS
  'Usage Balance summary in microdollars. Authoritative spend uses lykn_usage_lots.';
COMMENT ON TABLE public.lykn_usage_ledger IS
  'Append-only Usage Balance ledger. Reversals insert new rows; history is never deleted.';

CREATE OR REPLACE FUNCTION public.lykn_usage_balances_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lykn_usage_balances_updated_at ON public.lykn_usage_balances;
CREATE TRIGGER trg_lykn_usage_balances_updated_at
  BEFORE UPDATE ON public.lykn_usage_balances
  FOR EACH ROW
  EXECUTE FUNCTION public.lykn_usage_balances_set_updated_at();

CREATE OR REPLACE FUNCTION public.lykn_usage_ensure_balance(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.lykn_usage_balances (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;
END;
$$;

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
    ), 0)
  WHERE b.user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_available_micros(p_user_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(SUM(remaining_micros), 0)
  FROM public.lykn_usage_lots
  WHERE user_id = p_user_id
    AND remaining_micros > 0
    AND (expires_at IS NULL OR expires_at > now());
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
    AND bucket = 'promotional'
    AND expires_at IS NOT NULL
    AND expires_at <= now();

  RETURN jsonb_build_object(
    'ok', true,
    'purchased_micros', v_row.purchased_micros,
    'promotional_micros', v_row.promotional_micros,
    'included_micros', v_row.included_micros,
    'available_micros', v_row.purchased_micros + v_row.promotional_micros + v_row.included_micros,
    'expired_promotional_micros', v_expired,
    'reserved_micros', v_row.reserved_micros,
    'currency', v_row.currency
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_allocate(
  p_user_id uuid,
  p_amount bigint
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_left bigint := p_amount;
  v_lot public.lykn_usage_lots%ROWTYPE;
  v_take bigint;
  v_alloc jsonb := '[]'::jsonb;
BEGIN
  FOR v_lot IN
    SELECT * FROM public.lykn_usage_lots
    WHERE user_id = p_user_id
    ORDER BY
      CASE bucket
        WHEN 'promotional' THEN 0
        WHEN 'included' THEN 1
        WHEN 'purchased' THEN 2
        ELSE 9
      END,
      expires_at ASC NULLS LAST,
      created_at ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_left <= 0;
    CONTINUE WHEN v_lot.remaining_micros <= 0;
    CONTINUE WHEN v_lot.expires_at IS NOT NULL AND v_lot.expires_at <= now();
    v_take := LEAST(v_lot.remaining_micros, v_left);
    UPDATE public.lykn_usage_lots
      SET remaining_micros = remaining_micros - v_take
      WHERE id = v_lot.id;
    v_alloc := v_alloc || jsonb_build_array(jsonb_build_object(
      'lot_id', v_lot.id,
      'bucket', v_lot.bucket,
      'micros', v_take
    ));
    v_left := v_left - v_take;
  END LOOP;

  IF v_left > 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_usage_balance', 'shortfall', v_left);
  END IF;
  RETURN jsonb_build_object('ok', true, 'allocations', v_alloc);
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_credit_allocations(
  p_user_id uuid,
  p_allocations jsonb
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_item jsonb;
  v_updated int;
BEGIN
  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_allocations, '[]'::jsonb))
  LOOP
    UPDATE public.lykn_usage_lots
      SET remaining_micros = remaining_micros + (v_item->>'micros')::bigint
      WHERE id = (v_item->>'lot_id')::uuid
        AND user_id = p_user_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      INSERT INTO public.lykn_usage_lots (user_id, bucket, remaining_micros)
      VALUES (
        p_user_id,
        COALESCE(v_item->>'bucket', 'purchased'),
        (v_item->>'micros')::bigint
      );
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_fund(
  p_user_id uuid,
  p_amount_micros bigint,
  p_stripe_session_id text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_existing public.lykn_usage_ledger%ROWTYPE;
  v_available bigint;
BEGIN
  IF p_user_id IS NULL OR p_amount_micros IS NULL OR p_amount_micros <= 0 OR p_amount_micros > 1000000000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key, ''), CASE WHEN p_stripe_session_id IS NULL THEN NULL ELSE 'funding:' || p_stripe_session_id END);

  PERFORM public.lykn_usage_ensure_balance(p_user_id);
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;

  IF v_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.lykn_usage_ledger WHERE idempotency_key = v_key;
    IF FOUND THEN
      v_available := public.lykn_usage_available_micros(p_user_id);
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'available', v_available, 'ledgerId', v_existing.id);
    END IF;
  END IF;

  INSERT INTO public.lykn_usage_lots (user_id, bucket, remaining_micros)
  VALUES (p_user_id, 'purchased', p_amount_micros);

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type, bucket, stripe_session_id,
    idempotency_key, metadata, resulting_available_micros
  ) VALUES (
    p_user_id, p_amount_micros, 'credit', 'funding', 'purchased', p_stripe_session_id,
    v_key, COALESCE(p_metadata, '{}'::jsonb), public.lykn_usage_available_micros(p_user_id)
  );

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  v_available := public.lykn_usage_available_micros(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'available', v_available);
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_grant(
  p_user_id uuid,
  p_amount_micros bigint,
  p_bucket text,
  p_txn_type text,
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
  IF p_user_id IS NULL OR p_amount_micros IS NULL OR p_amount_micros <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;
  IF p_bucket NOT IN ('purchased', 'promotional', 'included') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_bucket');
  END IF;

  PERFORM public.lykn_usage_ensure_balance(p_user_id);
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.lykn_usage_ledger WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'available', public.lykn_usage_available_micros(p_user_id));
    END IF;
  END IF;

  INSERT INTO public.lykn_usage_lots (user_id, bucket, remaining_micros, expires_at)
  VALUES (p_user_id, p_bucket, p_amount_micros, p_expires_at);

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type, bucket, idempotency_key, metadata,
    resulting_available_micros
  ) VALUES (
    p_user_id, p_amount_micros, 'credit', COALESCE(p_txn_type, 'promotional_grant'), p_bucket,
    p_idempotency_key, COALESCE(p_metadata, '{}'::jsonb),
    public.lykn_usage_available_micros(p_user_id)
  );

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  v_available := public.lykn_usage_available_micros(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'available', v_available);
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_reserve(
  p_user_id uuid,
  p_amount_micros bigint,
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
BEGIN
  IF p_user_id IS NULL OR p_amount_micros IS NULL OR p_amount_micros <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_amount');
  END IF;

  PERFORM public.lykn_usage_ensure_balance(p_user_id);
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.lykn_usage_reservations WHERE idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'reservationId', v_existing.id, 'allocations', v_existing.allocations);
    END IF;
  END IF;

  v_plan := public.lykn_usage_allocate(p_user_id, p_amount_micros);
  IF (v_plan->>'ok')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_usage_balance',
      'available_micros', public.lykn_usage_available_micros(p_user_id),
      'required_micros', p_amount_micros
    );
  END IF;

  INSERT INTO public.lykn_usage_reservations (
    user_id, amount_micros, status, idempotency_key, allocations, action_type, pricing_version
  ) VALUES (
    p_user_id, p_amount_micros, 'open', p_idempotency_key, v_plan->'allocations', p_action_type, p_pricing_version
  ) RETURNING id INTO v_res_id;

  UPDATE public.lykn_usage_balances
    SET reserved_micros = reserved_micros + p_amount_micros
    WHERE user_id = p_user_id;

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type, reservation_id, idempotency_key,
    action_type, pricing_version, status, metadata, resulting_available_micros
  ) VALUES (
    p_user_id, p_amount_micros, 'debit', 'reservation', v_res_id, p_idempotency_key,
    p_action_type, p_pricing_version, 'reserved',
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('allocations', v_plan->'allocations'),
    public.lykn_usage_available_micros(p_user_id)
  );

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'reservationId', v_res_id, 'allocations', v_plan->'allocations');
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_release(
  p_user_id uuid,
  p_reservation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res public.lykn_usage_reservations%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;
  SELECT * INTO v_res FROM public.lykn_usage_reservations WHERE id = p_reservation_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reservation_missing');
  END IF;
  IF v_res.status = 'released' THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'reservationId', v_res.id);
  END IF;
  IF v_res.status <> 'open' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reservation_closed');
  END IF;

  PERFORM public.lykn_usage_credit_allocations(p_user_id, v_res.allocations);
  UPDATE public.lykn_usage_reservations SET status = 'released', updated_at = now() WHERE id = v_res.id;
  UPDATE public.lykn_usage_balances
    SET reserved_micros = GREATEST(0, reserved_micros - v_res.amount_micros)
    WHERE user_id = p_user_id;

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type, reservation_id, metadata, resulting_available_micros
  ) VALUES (
    p_user_id, v_res.amount_micros, 'credit', 'reservation_release', v_res.id,
    jsonb_build_object('allocations', v_res.allocations),
    public.lykn_usage_available_micros(p_user_id)
  );

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'releasedMicros', v_res.amount_micros);
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_settle(
  p_user_id uuid,
  p_reservation_id uuid,
  p_actual_micros bigint,
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
  v_unused bigint;
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

  v_actual := COALESCE(p_actual_micros, v_res.amount_micros);
  IF v_actual < 0 OR v_actual > v_res.amount_micros THEN
    RETURN jsonb_build_object('ok', false, 'error', 'settle_exceeds_reserve');
  END IF;
  v_unused := v_res.amount_micros - v_actual;

  IF v_unused > 0 THEN
    PERFORM public.lykn_usage_credit_allocations(p_user_id, v_res.allocations);
    -- Unused release credits the original lots in full, then re-debits the settled amount.
    PERFORM public.lykn_usage_allocate(p_user_id, v_actual);
    INSERT INTO public.lykn_usage_ledger (
      user_id, amount_micros, direction, txn_type, reservation_id, metadata, resulting_available_micros
    ) VALUES (
      p_user_id, v_unused, 'credit', 'reservation_release', v_res.id,
      jsonb_build_object('unused', true),
      public.lykn_usage_available_micros(p_user_id)
    );
  END IF;

  IF v_actual > 0 THEN
    INSERT INTO public.lykn_usage_ledger (
      user_id, amount_micros, direction, txn_type, reservation_id,
      provider_cost_micros, customer_charge_micros, pricing_version,
      action_type, model, provider, run_id, metadata, resulting_available_micros
    ) VALUES (
      p_user_id, v_actual, 'debit', 'usage_charge', v_res.id,
      COALESCE(p_provider_cost_micros, 0), v_actual, COALESCE(p_pricing_version, v_res.pricing_version),
      COALESCE(p_action_type, v_res.action_type), p_model, p_provider, p_run_id,
      COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('allocations', v_res.allocations),
      public.lykn_usage_available_micros(p_user_id)
    );
  END IF;

  UPDATE public.lykn_usage_reservations SET status = 'settled', updated_at = now() WHERE id = v_res.id;
  UPDATE public.lykn_usage_balances
    SET reserved_micros = GREATEST(0, reserved_micros - v_res.amount_micros)
    WHERE user_id = p_user_id;

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'chargedMicros', v_actual, 'releasedMicros', v_unused);
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_charge(
  p_user_id uuid,
  p_amount_micros bigint,
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
  v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_amount_micros IS NULL OR p_amount_micros <= 0 THEN
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

  v_plan := public.lykn_usage_allocate(p_user_id, p_amount_micros);
  IF (v_plan->>'ok')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_usage_balance',
      'available_micros', public.lykn_usage_available_micros(p_user_id),
      'required_micros', p_amount_micros
    );
  END IF;

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type,
    provider_cost_micros, customer_charge_micros, pricing_version,
    action_type, model, provider, run_id, idempotency_key, metadata, resulting_available_micros
  ) VALUES (
    p_user_id, p_amount_micros, 'debit', 'usage_charge',
    COALESCE(p_provider_cost_micros, 0), p_amount_micros, p_pricing_version,
    p_action_type, p_model, p_provider, p_run_id, p_idempotency_key,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('allocations', v_plan->'allocations'),
    public.lykn_usage_available_micros(p_user_id)
  ) RETURNING id INTO v_id;

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'ledgerId', v_id, 'chargedMicros', p_amount_micros);
END;
$$;

CREATE OR REPLACE FUNCTION public.lykn_usage_reverse(
  p_user_id uuid,
  p_ledger_id uuid,
  p_idempotency_key text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text;
  v_existing public.lykn_usage_ledger%ROWTYPE;
  v_original public.lykn_usage_ledger%ROWTYPE;
  v_id uuid;
BEGIN
  v_key := COALESCE(NULLIF(p_idempotency_key, ''), 'reversal:' || p_ledger_id::text);

  PERFORM public.lykn_usage_ensure_balance(p_user_id);
  PERFORM 1 FROM public.lykn_usage_balances WHERE user_id = p_user_id FOR UPDATE;

  SELECT * INTO v_existing FROM public.lykn_usage_ledger WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'ledgerId', v_existing.id);
  END IF;

  SELECT * INTO v_original FROM public.lykn_usage_ledger WHERE id = p_ledger_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ledger_missing');
  END IF;
  IF v_original.direction <> 'debit' OR v_original.txn_type <> 'usage_charge' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_reversible');
  END IF;

  PERFORM public.lykn_usage_credit_allocations(p_user_id, v_original.metadata->'allocations');

  INSERT INTO public.lykn_usage_ledger (
    user_id, amount_micros, direction, txn_type, idempotency_key, metadata, resulting_available_micros
  ) VALUES (
    p_user_id, v_original.amount_micros, 'credit', 'reversal', v_key,
    COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object('original_ledger_id', p_ledger_id),
    public.lykn_usage_available_micros(p_user_id)
  ) RETURNING id INTO v_id;

  PERFORM public.lykn_usage_refresh_summary(p_user_id);
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'ledgerId', v_id, 'restoredMicros', v_original.amount_micros);
END;
$$;

REVOKE ALL ON FUNCTION public.lykn_usage_ensure_balance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_refresh_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_available_micros(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_allocate(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_credit_allocations(uuid, jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.lykn_usage_balance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_fund(uuid, bigint, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_grant(uuid, bigint, text, text, timestamptz, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_reserve(uuid, bigint, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_release(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_settle(uuid, uuid, bigint, bigint, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_charge(uuid, bigint, bigint, text, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lykn_usage_reverse(uuid, uuid, text, jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.lykn_usage_balance(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_fund(uuid, bigint, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_grant(uuid, bigint, text, text, timestamptz, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_reserve(uuid, bigint, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_release(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_settle(uuid, uuid, bigint, bigint, text, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_charge(uuid, bigint, bigint, text, text, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_usage_reverse(uuid, uuid, text, jsonb) TO service_role;
