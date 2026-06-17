-- 107_rename_sessions_to_usage_sessions.sql
--
-- Phase 5 (Vault Normalization Program) — legacy naming pass.
--
-- Renames the billing/usage telemetry table `sessions` to `usage_sessions`
-- (the bare name `sessions` is ambiguous next to auth/chat sessions). Installs
-- a backward-compatible `sessions` VIEW so usageTracking.js + the server usage
-- routes keep working until they switch to `usage_sessions`.
--
-- Same view rationale as migration 106: RENAME carries RLS/indexes/triggers; a
-- single-table view is auto-updatable; security_invoker=on enforces RLS against
-- the querying user.
--
-- Idempotent: safe to run more than once.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sessions' AND table_type = 'BASE TABLE'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'usage_sessions'
  ) THEN
    EXECUTE 'ALTER TABLE public.sessions RENAME TO usage_sessions';
  END IF;
END $$;

CREATE OR REPLACE VIEW public.sessions
  WITH (security_invoker = on)
  AS SELECT * FROM public.usage_sessions;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sessions TO anon;

COMMENT ON VIEW public.sessions IS
  'Backward-compat alias for usage_sessions (Phase 5 rename). security_invoker=on. Retire after usageTracking.js + usage routes read usage_sessions.';

NOTIFY pgrst, 'reload schema';
