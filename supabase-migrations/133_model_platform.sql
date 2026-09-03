-- Model platform: named routes, user routing settings, normalized usage events.
-- Additive. Does not alter Usage Balance, credits, or existing model ids.
-- Apply in the Supabase SQL Editor after 132.

CREATE TABLE IF NOT EXISTS public.lykn_model_routes (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  purpose text NOT NULL DEFAULT 'default',
  primary_model_id text NOT NULL,
  fallback_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lykn_model_routes_purpose_chk CHECK (
    purpose IN ('default', 'quick', 'reasoning', 'coding', 'vision', 'research', 'agents')
  )
);

CREATE INDEX IF NOT EXISTS idx_lykn_model_routes_user_created
  ON public.lykn_model_routes (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.lykn_user_model_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'lykn',
  categories jsonb NOT NULL DEFAULT '{}'::jsonb,
  fallback_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  favorite_model_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lykn_user_model_settings_mode_chk CHECK (
    mode IN ('lykn', 'my_setup', 'model', 'route')
  )
);

CREATE TABLE IF NOT EXISTS public.lykn_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  chat_id uuid,
  bot_id text,
  request_id text,
  route_id text,
  gateway text,
  upstream_provider text,
  model_id text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  upstream_cost_micros bigint NOT NULL DEFAULT 0,
  markup_amount_micros bigint NOT NULL DEFAULT 0,
  customer_charge_micros bigint NOT NULL DEFAULT 0,
  estimated_cost_micros bigint NOT NULL DEFAULT 0,
  cost_source text,
  payer_type text,
  billing_source text NOT NULL DEFAULT 'lykn',
  pricing_version text,
  action_type text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lykn_usage_events_tokens_chk CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND reasoning_tokens >= 0
    AND cached_input_tokens >= 0 AND cache_write_tokens >= 0
  ),
  CONSTRAINT lykn_usage_events_money_chk CHECK (
    upstream_cost_micros >= 0 AND markup_amount_micros >= 0
    AND customer_charge_micros >= 0 AND estimated_cost_micros >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lykn_usage_events_request
  ON public.lykn_usage_events (user_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lykn_usage_events_user_created
  ON public.lykn_usage_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lykn_usage_events_bot
  ON public.lykn_usage_events (user_id, bot_id, created_at DESC)
  WHERE bot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lykn_usage_events_route
  ON public.lykn_usage_events (user_id, route_id, created_at DESC)
  WHERE route_id IS NOT NULL;

ALTER TABLE public.lykn_model_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_user_model_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lykn_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_model_routes_select_own ON public.lykn_model_routes;
CREATE POLICY lykn_model_routes_select_own ON public.lykn_model_routes
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS lykn_model_routes_insert_own ON public.lykn_model_routes;
CREATE POLICY lykn_model_routes_insert_own ON public.lykn_model_routes
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS lykn_model_routes_update_own ON public.lykn_model_routes;
CREATE POLICY lykn_model_routes_update_own ON public.lykn_model_routes
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS lykn_model_routes_delete_own ON public.lykn_model_routes;
CREATE POLICY lykn_model_routes_delete_own ON public.lykn_model_routes
  FOR DELETE TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_user_model_settings_select_own ON public.lykn_user_model_settings;
CREATE POLICY lykn_user_model_settings_select_own ON public.lykn_user_model_settings
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS lykn_user_model_settings_upsert_own ON public.lykn_user_model_settings;
DROP POLICY IF EXISTS lykn_user_model_settings_insert_own ON public.lykn_user_model_settings;
CREATE POLICY lykn_user_model_settings_insert_own ON public.lykn_user_model_settings
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS lykn_user_model_settings_update_own ON public.lykn_user_model_settings;
CREATE POLICY lykn_user_model_settings_update_own ON public.lykn_user_model_settings
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_usage_events_select_own ON public.lykn_usage_events;
CREATE POLICY lykn_usage_events_select_own ON public.lykn_usage_events
  FOR SELECT TO authenticated USING (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';
