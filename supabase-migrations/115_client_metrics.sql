-- 115: Landing table for POST /api/metrics/ingest (server.js).
--
-- The iOS app's MetricKitForwarder has been POSTing daily MXMetricPayload /
-- MXDiagnosticPayload JSON to /api/metrics/ingest since launch prep (PRD
-- P0-34 / Decisions §31) — the endpoint never existed, so every upload
-- 404ed silently. Payloads are stored as raw jsonb; MetricKit's schema is
-- Apple-defined and versioned, so no point mirroring it in columns.
--
-- Cascade FK means deleting an account also drops its diagnostics, keeping
-- the App Privacy "crash/performance data linked to identity" answer honest.

CREATE TABLE IF NOT EXISTS public.lykn_client_metrics (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_client_metrics_user_received_idx
  ON public.lykn_client_metrics (user_id, received_at DESC);

-- Service-role only (RLS on, no policies): clients write via the API, never
-- directly; nothing here is client-readable.
ALTER TABLE public.lykn_client_metrics ENABLE ROW LEVEL SECURITY;
