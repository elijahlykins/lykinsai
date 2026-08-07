-- ============================================
-- Apple in-app purchase as a second billing channel
-- Migration: 122_apple_iap_billing.sql
-- ============================================
--
-- App Review requires the iOS app to offer in-app purchase alongside the web
-- (Stripe) subscription path. Rather than stand up a parallel entitlement
-- store, Apple becomes a SECOND WRITER into `user_billing` — so every existing
-- consumer keeps working untouched:
--
--   * the cap resolvers (vault_cap_for_plan, blocks_per_grid_cap,
--     synthesis_neuron_cap_for_plan, upload_rate_*) all key off
--     `user_billing.plan` and need no change;
--   * the enforcement triggers on lykn_chats / lykn_beliefs /
--     lykn_user_model_facts / vault items keep firing as-is;
--   * `GET /api/billing/me` stays the single contract the iOS app reads.
--
-- Product decision (2026-08-05): a user may hold an active subscription on
-- exactly ONE channel. The server refuses a Stripe checkout while an Apple
-- subscription is active and vice versa, so `provider` is unambiguous — it is
-- never "both". See the eligibility checks in server.js.
--
-- Note there is deliberately no `apple_transaction_id` column: individual
-- transaction ids change on every renewal. `original_transaction_id` is the
-- stable identity for the subscription across its whole life, which is what
-- we key on.

-- ---------------------------------------------
-- 1. Channel columns on user_billing
-- ---------------------------------------------
ALTER TABLE public.user_billing
  ADD COLUMN IF NOT EXISTS provider                       text,
  ADD COLUMN IF NOT EXISTS apple_original_transaction_id  text,
  ADD COLUMN IF NOT EXISTS apple_product_id               text;

COMMENT ON COLUMN public.user_billing.provider IS
  'Which channel owns the current subscription: ''stripe'' | ''apple''. NULL means the user has never subscribed on either channel. Determines where the client sends the user to manage or cancel — Apple requires IAP subscriptions be managed through the App Store, not a web portal.';

COMMENT ON COLUMN public.user_billing.apple_original_transaction_id IS
  'Apple''s originalTransactionId — stable across renewals, the Apple analogue of stripe_subscription_id.';

-- `provider` is intentionally NULLABLE rather than NOT NULL DEFAULT ''stripe'':
-- a free user who never subscribed has no owning channel, and claiming
-- ''stripe'' for them would make the cross-channel eligibility check read as
-- though a Stripe relationship exists when it does not.
ALTER TABLE public.user_billing
  DROP CONSTRAINT IF EXISTS user_billing_provider_check;

ALTER TABLE public.user_billing
  ADD CONSTRAINT user_billing_provider_check
    CHECK (provider IS NULL OR provider IN ('stripe', 'apple'));

-- Apple's originalTransactionId maps 1:1 to a user, same as
-- stripe_subscription_id. Partial so the many NULL rows don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_billing_apple_original_txn
  ON public.user_billing (apple_original_transaction_id)
  WHERE apple_original_transaction_id IS NOT NULL;

-- ---------------------------------------------
-- 2. Backfill: every existing subscription is Stripe's
-- ---------------------------------------------
-- Only rows that actually reached Stripe get a provider. A row that exists
-- solely because something touched user_billing (plan 'free', no subscription)
-- stays NULL.
UPDATE public.user_billing
   SET provider = 'stripe'
 WHERE provider IS NULL
   AND (stripe_subscription_id IS NOT NULL OR stripe_customer_id IS NOT NULL);

-- ---------------------------------------------
-- 3. App Store Server Notification log (idempotency + audit)
-- ---------------------------------------------
-- Mirrors public.stripe_events. The PK enforces idempotency: Apple retries a
-- notification until it gets a 2xx, and the handler must insert this row ONLY
-- after the billing write succeeded, so a failed sync is redelivered rather
-- than silently marked processed.
CREATE TABLE IF NOT EXISTS public.apple_notifications (
  notification_uuid  text PRIMARY KEY,
  notification_type  text NOT NULL,
  subtype            text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  payload            jsonb
);

ALTER TABLE public.apple_notifications ENABLE ROW LEVEL SECURITY;

-- No client policies: service role only, same posture as stripe_events.

CREATE INDEX IF NOT EXISTS idx_apple_notifications_type_received
  ON public.apple_notifications (notification_type, received_at DESC);

NOTIFY pgrst, 'reload schema';
