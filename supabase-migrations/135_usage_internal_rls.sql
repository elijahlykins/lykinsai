-- 135: internal usage tables are server-only.
--
-- The Usage Balance engine stores internal economics — raw provider cost,
-- markup, and pricing-profile names — on lots, ledger rows, reservations,
-- usage events, and the legacy ai_usage_logs / usage_sessions telemetry.
-- Customers must only ever see the customer charge, which the server already
-- exposes through /api/billing/credits, /api/usage/summary, and
-- /api/usage/events (all scrubbed payloads).
--
-- This migration removes every client-facing (authenticated-role) policy on
-- those tables so PostgREST cannot serve the raw columns to a user JWT.
-- The service role bypasses RLS, so server behavior is unchanged.
--
-- lykn_usage_balances keeps its select-own policy: it only carries
-- customer-charge totals (available/purchased/promotional/plan micros),
-- never raw cost or profile names.

-- ── Usage Balance internals (131/133/134) ───────────────────────────────────
DROP POLICY IF EXISTS lykn_usage_lots_select_own ON public.lykn_usage_lots;
DROP POLICY IF EXISTS lykn_usage_reservations_select_own ON public.lykn_usage_reservations;
DROP POLICY IF EXISTS lykn_usage_ledger_select_own ON public.lykn_usage_ledger;
DROP POLICY IF EXISTS lykn_usage_events_select_own ON public.lykn_usage_events;

-- ── Legacy telemetry (019, renamed in 107) ──────────────────────────────────
-- ai_usage_logs.cost_usd and usage_sessions.total_cost are raw provider cost.
-- Only the server (service role) reads and writes these tables.
DROP POLICY IF EXISTS "Users can view own usage logs" ON public.ai_usage_logs;
DROP POLICY IF EXISTS "Users can insert own usage logs" ON public.ai_usage_logs;
DROP POLICY IF EXISTS "Users can view own sessions" ON public.usage_sessions;
DROP POLICY IF EXISTS "Users can insert own sessions" ON public.usage_sessions;
DROP POLICY IF EXISTS "Users can update own sessions" ON public.usage_sessions;

-- RLS with zero policies returns an empty 200 response through PostgREST.
-- Explicit table revokes make this boundary fail closed with 401/403 instead,
-- which is both easier to monitor and stronger against future policy mistakes.
REVOKE ALL ON TABLE public.lykn_usage_lots FROM anon, authenticated;
REVOKE ALL ON TABLE public.lykn_usage_reservations FROM anon, authenticated;
REVOKE ALL ON TABLE public.lykn_usage_ledger FROM anon, authenticated;
REVOKE ALL ON TABLE public.lykn_usage_events FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_usage_logs FROM anon, authenticated;
REVOKE ALL ON TABLE public.usage_sessions FROM anon, authenticated;

COMMENT ON TABLE public.lykn_usage_lots IS
  'Usage Balance lots (microdollars, per-lot pricing profile). Server-only: RLS exposes no client policies; customers read scrubbed payloads via the billing API.';
COMMENT ON TABLE public.lykn_usage_ledger IS
  'Append-only Usage Balance ledger. Server-only (see 135); raw provider cost never reaches clients.';
