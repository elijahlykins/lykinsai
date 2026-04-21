-- ============================================
-- Stripe Billing: per-user subscription state
-- Migration: 028_billing.sql
-- ============================================
--
-- Owns the mapping between a Supabase auth user and their Stripe customer /
-- subscription. All mutations happen server-side via the service role; RLS is
-- read-only for the owning user so the frontend can render plan + status.

CREATE TABLE IF NOT EXISTS public.user_billing (
  user_id                 uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id      text UNIQUE,
  stripe_subscription_id  text UNIQUE,
  plan                    text NOT NULL DEFAULT 'free',
  -- 'free' | 'studio' | 'studio_pro' | 'studio_max'
  billing_period          text,
  -- 'monthly' | 'annual' | null
  status                  text NOT NULL DEFAULT 'inactive',
  -- Mirrors Stripe subscription.status. 'free' users stay 'inactive'.
  current_period_end      timestamptz,
  cancel_at_period_end    boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_billing_plan_check
    CHECK (plan IN ('free', 'studio', 'studio_pro', 'studio_max')),
  CONSTRAINT user_billing_period_check
    CHECK (billing_period IS NULL OR billing_period IN ('monthly', 'annual'))
);

ALTER TABLE public.user_billing ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own billing row"
  ON public.user_billing FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT / UPDATE / DELETE policies for clients: the service role bypasses
-- RLS and the Stripe webhook is the only writer.

CREATE INDEX IF NOT EXISTS idx_user_billing_customer
  ON public.user_billing (stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_user_billing_subscription
  ON public.user_billing (stripe_subscription_id);

-- Keep updated_at fresh automatically.
CREATE OR REPLACE FUNCTION public.user_billing_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_billing_updated_at ON public.user_billing;
CREATE TRIGGER trg_user_billing_updated_at
  BEFORE UPDATE ON public.user_billing
  FOR EACH ROW
  EXECUTE FUNCTION public.user_billing_set_updated_at();

-- ============================================
-- Stripe webhook event log (idempotency + audit)
-- ============================================
CREATE TABLE IF NOT EXISTS public.stripe_events (
  id           text PRIMARY KEY,
  -- Stripe event id (evt_...). PK enforces idempotency.
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  payload      jsonb
);

ALTER TABLE public.stripe_events ENABLE ROW LEVEL SECURITY;

-- No client policies: service role only.

CREATE INDEX IF NOT EXISTS idx_stripe_events_type_received
  ON public.stripe_events (type, received_at DESC);
