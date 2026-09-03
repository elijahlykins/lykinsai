-- Usage Balance and model-platform smoke checks for migrations 131-135.
-- Run AFTER applying migrations 131, 132, 133, 134, and 135.
-- Replace :test_user with a real auth.users id you control.
-- This script leaves no lots/ledger/reservations for that user if the cleanup
-- block runs. It does not weaken RLS.

\echo 'tables'
SELECT c.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN (
    'lykn_usage_balances',
    'lykn_usage_lots',
    'lykn_usage_reservations',
    'lykn_usage_ledger',
    'lykn_usage_events',
    'lykn_model_routes',
    'lykn_user_model_settings'
  )
ORDER BY 1;

\echo 'rls'
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename LIKE 'lykn_usage_%'
ORDER BY 1;

\echo 'write_rpcs'
SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname LIKE 'lykn_usage_%'
ORDER BY 1;

\echo 'rpc_execute_grants'
SELECT
  p.proname,
  has_function_privilege('anon', p.oid, 'execute') AS anon_exec,
  has_function_privilege('authenticated', p.oid, 'execute') AS authenticated_exec,
  has_function_privilege('service_role', p.oid, 'execute') AS service_role_exec
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'lykn_usage_fund',
    'lykn_usage_grant',
    'lykn_usage_grant_v2',
    'lykn_usage_charge',
    'lykn_usage_charge_cost',
    'lykn_usage_reserve',
    'lykn_usage_reserve_cost',
    'lykn_usage_release',
    'lykn_usage_settle',
    'lykn_usage_settle_cost',
    'lykn_usage_reverse',
    'lykn_usage_balance'
  )
ORDER BY 1;

\echo 'internal_usage_policies_removed_by_135'
SELECT
  tablename,
  COUNT(*) FILTER (WHERE roles::text LIKE '%authenticated%') AS authenticated_policy_count
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'lykn_usage_lots',
    'lykn_usage_reservations',
    'lykn_usage_ledger',
    'lykn_usage_events',
    'ai_usage_logs',
    'usage_sessions'
  )
GROUP BY tablename
ORDER BY tablename;

\echo 'customer_balance_policy_retained'
SELECT policyname, roles, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'lykn_usage_balances'
ORDER BY policyname;

\echo 'user_files_bucket'
SELECT id, public, file_size_limit
FROM storage.buckets
WHERE id = 'user-files';

\echo 'user_files_policies'
SELECT policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'storage'
  AND tablename = 'objects'
  AND policyname IN (
    'user_files_select_own',
    'user_files_insert_own',
    'user_files_update_own',
    'user_files_delete_own'
  )
ORDER BY policyname;

-- Authoritative service-role path. Use the SQL editor as service_role / postgres.
-- BEGIN;
-- SELECT public.lykn_usage_fund('TEST_USER'::uuid, 5000000, 'cs_smoke_1', 'funding:cs_smoke_1', '{}'::jsonb);
-- SELECT public.lykn_usage_grant('TEST_USER'::uuid, 1000000, 'promotional', 'promotional_grant', now() + interval '7 days', 'promo:smoke', '{}'::jsonb);
-- SELECT public.lykn_usage_reserve('TEST_USER'::uuid, 70000, 'image_gen', 'usage-v1', 'res:smoke', '{}'::jsonb);
-- -- settle the returned reservation id, then:
-- SELECT public.lykn_usage_fund('TEST_USER'::uuid, 5000000, 'cs_smoke_1', 'funding:cs_smoke_1', '{}'::jsonb); -- duplicate
-- SELECT public.lykn_usage_charge('TEST_USER'::uuid, 999999999, 0, 'usage-v1', 'image_gen', null, null, null, 'charge:too-big', '{}'::jsonb); -- insufficient
-- Outstanding purchased:
-- SELECT COALESCE(SUM(remaining_micros), 0)
-- FROM public.lykn_usage_lots
-- WHERE user_id = 'TEST_USER'::uuid AND bucket = 'purchased';
-- ROLLBACK;

\echo 'legacy_credit_tables_untouched'
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('lykn_credit_wallets', 'lykn_credit_topups')
ORDER BY 1;
