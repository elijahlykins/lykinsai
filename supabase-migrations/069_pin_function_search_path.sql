-- ============================================================================
-- 069 — Pin search_path on every public function flagged by the Supabase
--      advisor's "function_search_path_mutable" warning, plus the three
--      SECURITY DEFINER functions in migration 001 that ship unpinned.
--
-- Why this matters
-- ----------------
-- A function with mutable search_path resolves unqualified identifiers using
-- the *caller's* search_path. If anyone ever gets CREATE on schema public
-- (a permission anon and authenticated do NOT have today, but the advisor
-- treats this as defense-in-depth), they can shadow a built-in name and
-- hijack a SECURITY DEFINER function on its next invocation. Pinning the
-- search_path closes that vector even if some future role gains CREATE.
--
-- Idempotency model
-- -----------------
-- Some of the functions listed below were dropped by earlier migrations
-- (e.g. migration 011 dropped create_workspace_for_user, get_user_workspace,
-- and search_files_by_embedding when the file-storage system was retired).
-- Other functions were created out-of-band via the SQL Editor and may
-- exist on production but not staging.
--
-- A bare `ALTER FUNCTION ... does-not-exist` errors with 42883 and rolls
-- back the entire BEGIN…COMMIT, so we'd land NONE of the pinning if even
-- one function was missing. Instead, we drive every pinning through one
-- DO block that uses to_regprocedure() to check existence first and skips
-- (with a NOTICE) when a function isn't there.
--
-- Why we use ALTER FUNCTION instead of CREATE OR REPLACE
-- ------------------------------------------------------
-- ALTER FUNCTION ... SET search_path = ... attaches a config setting to the
-- function without touching the body. That keeps this migration reviewable
-- line-by-line and impossible to accidentally rewrite a function body
-- wrong. (CREATE OR REPLACE would copy 100s of lines of plpgsql and
-- silently drop any out-of-band edits made through the SQL Editor.)
--
-- Why we don't pin everything to "pg_catalog, public"
-- ---------------------------------------------------
-- Some functions cross schemas:
--   • search_files_by_embedding uses the `vector` type and the `<=>`
--     operator, both owned by the `extensions` schema in Supabase.
--     (Listed as a no-op on this project — mig 011 dropped it — but kept
--     in the table so future projects that haven't run 011 still benefit.)
--   • The admin_* RPCs in 040 / 042 already pin `public, auth` because
--     they JOIN auth.users. We don't re-pin those — already correct.
--   • lykn_merge_projects (067) pins `public, pg_temp` for plpgsql temp
--     scoping. Already correct.
-- A blanket `pg_catalog, public` would make those functions fail at
-- runtime by hiding the symbols they need. So we group by dependency.
--
-- Companion to migration 068 (anon RPC lockdown). Apply order is 068
-- first (stop the leak), 069 second (harden the surface).
-- ============================================================================

BEGIN;

DO $$
DECLARE
  fn          regprocedure;
  pinning     record;
  applied     int := 0;
  skipped     int := 0;
BEGIN
  -- Each row: (function signature, search_path to pin).
  -- Signatures use the EXACT argument types Postgres records in pg_proc
  -- (e.g. `integer` not `int`, `double precision` not `float`). Wrong
  -- argtypes silently mismatch via to_regprocedure → counted as skipped.
  FOR pinning IN
    SELECT * FROM (VALUES
      -- ----- 1. SECURITY DEFINER functions in mig 001 (likely dropped by 011)
      ('public.create_workspace_for_user()',                     'pg_catalog, public'),
      ('public.get_user_workspace()',                            'pg_catalog, public'),
      ('public.search_files_by_embedding(vector, double precision, integer, uuid)',
                                                                 'pg_catalog, public, extensions'),

      -- ----- 2. SECURITY INVOKER plan-helper IMMUTABLE/STABLE functions
      ('public.effective_plan_for_user(uuid)',                   'pg_catalog, public'),
      ('public.vault_cap_for_plan(text)',                        'pg_catalog, public'),
      ('public.upload_rate_per_minute(text)',                    'pg_catalog, public'),
      ('public.upload_rate_per_hour(text)',                      'pg_catalog, public'),
      ('public.blocks_per_grid_cap(text)',                       'pg_catalog, public'),
      ('public.block_count_for_state(jsonb)',                    'pg_catalog, public'),
      ('public.synthesis_neuron_cap_for_plan(text)',             'pg_catalog, public'),

      -- ----- 3. SECURITY INVOKER updated_at trigger functions
      ('public.update_updated_at_column()',                      'pg_catalog, public'),
      ('public.touch_lykn_user_preferences_updated_at()',        'pg_catalog, public'),
      ('public.lykn_concepts_touch_updated_at()',                'pg_catalog, public'),
      ('public.lykn_mcp_tokens_set_updated_at()',                'pg_catalog, public'),
      ('public.lykn_oauth_clients_set_updated_at()',             'pg_catalog, public'),
      ('public.rss_feeds_set_updated_at()',                      'pg_catalog, public'),
      ('public.social_connections_set_updated_at()',             'pg_catalog, public'),
      ('public.studio_max_waitlist_set_updated_at()',            'pg_catalog, public'),
      ('public.user_billing_set_updated_at()',                   'pg_catalog, public'),

      -- ----- 4. Audit trigger functions added by 065
      ('public.lykn_audit_mcp_tokens()',                         'pg_catalog, public'),
      ('public.lykn_audit_oauth_authorization_codes()',          'pg_catalog, public'),
      ('public.lykn_audit_oauth_refresh_tokens()',               'pg_catalog, public'),

      -- ----- 5. The omnia share recorder (deliberately anon-callable;
      --         pinning its search_path is especially worthwhile)
      ('public.omnia_shared_board_record_view(text)',            'pg_catalog, public')
    ) AS t(fn_sig, sp)
  LOOP
    fn := to_regprocedure(pinning.fn_sig);
    IF fn IS NULL THEN
      RAISE NOTICE '  SKIP  %  (function does not exist on this DB)', pinning.fn_sig;
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = %s',
      fn,                  -- regprocedure renders as fully-qualified signature
      pinning.sp           -- already-trusted literal from this file
    );
    applied := applied + 1;
    RAISE NOTICE '  PIN   %  →  %', fn, pinning.sp;
  END LOOP;

  RAISE NOTICE '----------------------------------------------------------------';
  RAISE NOTICE 'mig 069: pinned search_path on % function(s); skipped % missing.', applied, skipped;
END $$;

COMMIT;

-- ============================================================================
-- Sanity-check after applying:
--   SELECT proname,
--          prosecdef                                AS is_secdef,
--          coalesce(proconfig::text, '(unset)')     AS config
--   FROM pg_proc p
--   JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND prokind = 'f'
--     AND proname IN (
--       'effective_plan_for_user', 'vault_cap_for_plan',
--       'upload_rate_per_minute', 'upload_rate_per_hour',
--       'blocks_per_grid_cap', 'block_count_for_state',
--       'synthesis_neuron_cap_for_plan',
--       'update_updated_at_column', 'touch_lykn_user_preferences_updated_at',
--       'lykn_concepts_touch_updated_at', 'lykn_mcp_tokens_set_updated_at',
--       'lykn_oauth_clients_set_updated_at', 'rss_feeds_set_updated_at',
--       'social_connections_set_updated_at',
--       'studio_max_waitlist_set_updated_at', 'user_billing_set_updated_at',
--       'lykn_audit_mcp_tokens', 'lykn_audit_oauth_authorization_codes',
--       'lykn_audit_oauth_refresh_tokens', 'omnia_shared_board_record_view'
--     )
--   ORDER BY proname;
--
-- Expected: every row's `config` column shows {search_path=...} with
-- pg_catalog as the leading element.
-- ============================================================================
