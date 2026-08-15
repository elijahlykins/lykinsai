-- ============================================================================
-- 123 — Purchased credit top-ups (LYKN AI credits)
-- ============================================================================
--
-- Until now "credits" were derived, never stored: the free signup allowance is
-- FREE_PLAN_CREDITS minus the lifetime sum of ai_usage_logs.credits_used, and
-- paid plans are capped on request count (PLAN_LIMITS.glassRequests). Neither
-- could be extended by a purchase.
--
-- This adds a real balance. A top-up is a one-time Stripe payment that grants
-- credits; those credits are spent only when the account has no included
-- allowance left — either a free account past FREE_PLAN_CREDITS or a
-- subscriber past their monthly request cap. Spend detail stays in
-- ai_usage_logs; this table holds only the running totals.
--
-- All mutations go through the two SECURITY DEFINER functions below (service
-- role only). RLS is read-only for the owning user so the billing popup can
-- render a balance and a purchase history.

CREATE TABLE IF NOT EXISTS public.lykn_credit_wallets (
  user_id         uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  credits_granted bigint NOT NULL DEFAULT 0 CHECK (credits_granted >= 0),
  credits_used    bigint NOT NULL DEFAULT 0 CHECK (credits_used >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lykn_credit_wallets_used_within_granted
    CHECK (credits_used <= credits_granted)
);

-- Purchase history. stripe_session_id is UNIQUE so a webhook redelivery can
-- never grant the same pack twice.
CREATE TABLE IF NOT EXISTS public.lykn_credit_topups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_session_id text UNIQUE,
  pack_id           text,
  credits           bigint NOT NULL CHECK (credits > 0),
  amount_cents      bigint,
  currency          text NOT NULL DEFAULT 'usd',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_credit_topups_user_created_idx
  ON public.lykn_credit_topups (user_id, created_at DESC);

ALTER TABLE public.lykn_credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_credit_topups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_credit_wallets_select_own ON public.lykn_credit_wallets;
CREATE POLICY lykn_credit_wallets_select_own
  ON public.lykn_credit_wallets FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_credit_topups_select_own ON public.lykn_credit_topups;
CREATE POLICY lykn_credit_topups_select_own
  ON public.lykn_credit_topups FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- No client INSERT / UPDATE / DELETE policies: the Stripe webhook and the AI
-- gates are the only writers, both through the service role.

COMMENT ON TABLE public.lykn_credit_wallets IS
  'Purchased LYKN AI credit balance (credits_granted - credits_used). Spent only after the plan''s included allowance is exhausted.';
COMMENT ON TABLE public.lykn_credit_topups IS
  'One-time credit purchases. stripe_session_id is unique so webhook retries are idempotent.';

CREATE OR REPLACE FUNCTION public.lykn_credit_wallets_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_lykn_credit_wallets_updated_at ON public.lykn_credit_wallets;
CREATE TRIGGER trg_lykn_credit_wallets_updated_at
  BEFORE UPDATE ON public.lykn_credit_wallets
  FOR EACH ROW
  EXECUTE FUNCTION public.lykn_credit_wallets_set_updated_at();

-- ── Grant (Stripe webhook) ──────────────────────────────────────────────────
-- Idempotent on p_session_id: a redelivered checkout.session.completed returns
-- the existing balance with duplicate = true instead of granting again.
CREATE OR REPLACE FUNCTION public.lykn_credit_topup_grant(
  p_user_id      uuid,
  p_credits      bigint,
  p_session_id   text DEFAULT NULL,
  p_pack_id      text DEFAULT NULL,
  p_amount_cents bigint DEFAULT NULL,
  p_currency     text DEFAULT 'usd'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_granted bigint;
  v_used    bigint;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user_id');
  END IF;
  IF p_credits IS NULL OR p_credits <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_credits');
  END IF;

  IF p_session_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.lykn_credit_topups WHERE stripe_session_id = p_session_id
  ) THEN
    SELECT credits_granted, credits_used INTO v_granted, v_used
    FROM public.lykn_credit_wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'credits_granted', COALESCE(v_granted, 0),
      'credits_used', COALESCE(v_used, 0),
      'balance', COALESCE(v_granted, 0) - COALESCE(v_used, 0)
    );
  END IF;

  INSERT INTO public.lykn_credit_topups (
    user_id, stripe_session_id, pack_id, credits, amount_cents, currency
  ) VALUES (
    p_user_id, p_session_id, p_pack_id, p_credits, p_amount_cents,
    COALESCE(NULLIF(trim(p_currency), ''), 'usd')
  );

  INSERT INTO public.lykn_credit_wallets (user_id, credits_granted)
  VALUES (p_user_id, p_credits)
  ON CONFLICT (user_id) DO UPDATE
    SET credits_granted = public.lykn_credit_wallets.credits_granted + p_credits
  RETURNING credits_granted, credits_used INTO v_granted, v_used;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'credits_granted', v_granted,
    'credits_used', v_used,
    'balance', v_granted - v_used
  );
END;
$$;

-- ── Spend (AI usage logging) ────────────────────────────────────────────────
-- Clamps to the remaining balance so a burst of concurrent requests can never
-- push credits_used past credits_granted. Returns how much was actually spent.
CREATE OR REPLACE FUNCTION public.lykn_credit_wallet_spend(
  p_user_id uuid,
  p_credits bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_granted bigint;
  v_used    bigint;
  v_spend   bigint;
BEGIN
  IF p_user_id IS NULL OR p_credits IS NULL OR p_credits <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_request');
  END IF;

  SELECT credits_granted, credits_used INTO v_granted, v_used
  FROM public.lykn_credit_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_granted IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_wallet', 'balance', 0);
  END IF;

  v_spend := LEAST(p_credits, v_granted - v_used);
  IF v_spend <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'spent', 0, 'balance', 0);
  END IF;

  UPDATE public.lykn_credit_wallets
  SET credits_used = credits_used + v_spend
  WHERE user_id = p_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'spent', v_spend,
    'balance', v_granted - (v_used + v_spend)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lykn_credit_topup_grant(uuid, bigint, text, text, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lykn_credit_topup_grant(uuid, bigint, text, text, bigint, text) TO service_role;

REVOKE ALL ON FUNCTION public.lykn_credit_wallet_spend(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lykn_credit_wallet_spend(uuid, bigint) TO service_role;
