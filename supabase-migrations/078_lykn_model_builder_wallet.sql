-- ============================================================================
-- 078 — Model Builder wallet (user-funded Together / training costs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.lykn_model_builder_wallets (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  balance_cents BIGINT NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lykn_model_builder_wallet_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  amount_cents BIGINT NOT NULL,
  kind TEXT NOT NULL,
  reference_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_model_builder_wallet_ledger_user_created_idx
  ON public.lykn_model_builder_wallet_ledger (user_id, created_at DESC);

ALTER TABLE public.lykn_model_builder_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_model_builder_wallet_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_model_builder_wallets_select_own ON public.lykn_model_builder_wallets;
CREATE POLICY lykn_model_builder_wallets_select_own
  ON public.lykn_model_builder_wallets FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_model_builder_wallet_ledger_select_own ON public.lykn_model_builder_wallet_ledger;
CREATE POLICY lykn_model_builder_wallet_ledger_select_own
  ON public.lykn_model_builder_wallet_ledger FOR SELECT TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.lykn_model_builder_wallets IS
  'Prepaid balance for Model Builder (LoRA training / provider pass-through). Not LYKN subscription credits.';
COMMENT ON TABLE public.lykn_model_builder_wallet_ledger IS
  'Audit log of wallet credits and debits (Stripe top-ups, LoRA reserves, refunds).';

-- Atomic apply delta; service role only (no client INSERT policies).
CREATE OR REPLACE FUNCTION public.lykn_model_builder_wallet_apply_delta(
  p_user_id UUID,
  p_delta_cents BIGINT,
  p_kind TEXT,
  p_reference_id TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance BIGINT;
  v_new_balance BIGINT;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_user_id');
  END IF;
  IF p_delta_cents = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'zero_delta');
  END IF;
  IF p_kind IS NULL OR length(trim(p_kind)) < 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'missing_kind');
  END IF;

  INSERT INTO public.lykn_model_builder_wallets (user_id, balance_cents)
  VALUES (p_user_id, 0)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT balance_cents INTO v_balance
  FROM public.lykn_model_builder_wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  v_new_balance := v_balance + p_delta_cents;
  IF v_new_balance < 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'insufficient_balance',
      'balance_cents', v_balance,
      'required_cents', -p_delta_cents
    );
  END IF;

  UPDATE public.lykn_model_builder_wallets
  SET balance_cents = v_new_balance, updated_at = now()
  WHERE user_id = p_user_id;

  INSERT INTO public.lykn_model_builder_wallet_ledger (
    user_id, amount_cents, kind, reference_id, metadata
  ) VALUES (
    p_user_id, p_delta_cents, p_kind, p_reference_id, COALESCE(p_metadata, '{}'::jsonb)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'balance_cents', v_new_balance,
    'delta_cents', p_delta_cents
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lykn_model_builder_wallet_apply_delta(UUID, BIGINT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lykn_model_builder_wallet_apply_delta(UUID, BIGINT, TEXT, TEXT, JSONB) TO service_role;
