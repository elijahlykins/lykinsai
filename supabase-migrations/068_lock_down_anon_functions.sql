-- ============================================================================
-- Hotfix: revoke EXECUTE on every SECURITY DEFINER function in public from
-- anon + authenticated. service_role keeps its grants (it's the backend's role
-- and bypasses RLS anyway).
--
-- Root cause: PostgreSQL grants EXECUTE to PUBLIC by default on every new
-- function. Supabase's `anon` role is granted privileges directly (not via
-- PUBLIC), so `REVOKE ... FROM PUBLIC` does NOT remove anon's access. Every
-- existing migration that wrote `REVOKE ... FROM PUBLIC; GRANT ... TO
-- service_role;` is half-broken — anon still has EXECUTE.
--
-- Audited via:
--   SELECT proname, prosecdef, has_function_privilege('anon', oid, 'EXECUTE')
--   FROM pg_proc JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid
--   WHERE nspname = 'public' AND prokind = 'f';
--
-- Exploit confirmed against migrations 040 / 042: anon JWT can call
-- admin_users_with_usage, admin_recent_activity, admin_usage_live,
-- admin_user_drilldown, admin_usage_overview and pull every user's email,
-- spend, and AI activity metadata.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. The five admin RPCs — exploit-confirmed leak of emails + usage data.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.admin_recent_activity(integer)
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_usage_live(integer)
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_usage_overview(timestamptz)
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_user_drilldown(uuid, timestamptz)
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_users_with_usage(timestamptz)
  FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. User-scoped SECURITY DEFINER RPCs. These currently return [] for anon
--    because they filter by auth.uid(), but they should only be callable by
--    authenticated. Revoke from anon only; keep authenticated.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.concept_links(uuid)                 FROM anon;
REVOKE EXECUTE ON FUNCTION public.concept_links_for_user(integer)     FROM anon;
REVOKE EXECUTE ON FUNCTION public.concepts_moved_since(timestamptz)   FROM anon;
REVOKE EXECUTE ON FUNCTION public.concepts_overview()                 FROM anon;
REVOKE EXECUTE ON FUNCTION public.count_user_explicit_neurons(uuid)   FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_belief_provenance(uuid[])       FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_connector_synthesis_counts()    FROM anon;
REVOKE EXECUTE ON FUNCTION public.vault_tag_counts()                  FROM anon;
REVOKE EXECUTE ON FUNCTION public.match_lykn_synthesis_chunks(vector, integer, double precision)
  FROM anon;

-- ----------------------------------------------------------------------------
-- 3. Internal write/admin functions exposed by mistake. These should never
--    be reachable from any client role.
--
--    rls_auto_enable() and handle_new_user_preferences() are not defined in
--    any repo migration — they were created out-of-band (Supabase advisor /
--    SQL Editor). Guarding their REVOKEs in DO blocks so this migration
--    succeeds on environments where the function never existed; otherwise
--    the whole transaction rolls back and NO revokes land. (The audit
--    against this project's prod DB confirmed both exist there, so the
--    guard is purely for repeatability against staging / fresh clones.)
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.merge_concepts(uuid, uuid)
  FROM anon, authenticated;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM anon, authenticated';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'handle_new_user_preferences'
  ) THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.handle_new_user_preferences() FROM anon, authenticated';
  END IF;
END $$;

REVOKE EXECUTE ON FUNCTION public.enforce_blocks_per_grid_cap()
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_beliefs()
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_boards()
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_facts()
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_upload_rate()
  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_vault_cap()
  FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. The sharing-feature view recorder. Keep anon EXECUTE — confirmed in use
--    by src/lib/grid/sharedGrids.ts (line 199), where the public board-share
--    landing page calls this RPC with the anon supabase client to record an
--    unauthenticated view. Migration 034 grants EXECUTE to anon intentionally.
--    DO NOT UNCOMMENT without removing the public-share feature first.
-- ----------------------------------------------------------------------------
-- REVOKE EXECUTE ON FUNCTION public.omnia_shared_board_record_view(text)
--   FROM anon;

-- ----------------------------------------------------------------------------
-- 5. Tighten the trigger functions and plan-helper functions (SECURITY
--    INVOKER, low risk — can't realistically be exploited via PostgREST since
--    they expect trigger context — but no reason to expose them).
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column()              FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.touch_lykn_user_preferences_updated_at() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lykn_concepts_touch_updated_at()        FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lykn_mcp_tokens_set_updated_at()        FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lykn_oauth_clients_set_updated_at()     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rss_feeds_set_updated_at()              FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.social_connections_set_updated_at()     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.studio_max_waitlist_set_updated_at()    FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.user_billing_set_updated_at()           FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lykn_audit_mcp_tokens()                 FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lykn_audit_oauth_authorization_codes()  FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lykn_audit_oauth_refresh_tokens()       FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.effective_plan_for_user(uuid)           FROM anon;
REVOKE EXECUTE ON FUNCTION public.block_count_for_state(jsonb)            FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.blocks_per_grid_cap(text)               FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.synthesis_neuron_cap_for_plan(text)     FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upload_rate_per_hour(text)              FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.upload_rate_per_minute(text)            FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_cap_for_plan(text)                FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- 6. Drop the five admin reporting views from migration 027. They are dead
--    code (no application reference outside supabase-queries/ai_usage_dashboard.sql,
--    a manual SQL Editor cheat-sheet) and they bypass RLS on ai_usage_logs
--    because they run as their owner. Same anon-grant problem as the RPCs:
--    migration 027 only revokes from PUBLIC + authenticated, so anon retains
--    SELECT via Supabase's default privileges. The actual admin dashboard
--    reads via the admin_* RPCs in migrations 040 / 042, so dropping these
--    breaks nothing in the running app.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.v_usage_by_user_month;
DROP VIEW IF EXISTS public.v_usage_by_model;
DROP VIEW IF EXISTS public.v_usage_by_action;
DROP VIEW IF EXISTS public.v_usage_daily;
DROP VIEW IF EXISTS public.v_top_users;

COMMIT;

-- ----------------------------------------------------------------------------
-- After applying:
--   1. NOTIFY pgrst, 'reload schema';   -- forces PostgREST to drop the cached
--                                        -- function exposure
--   2. Re-run the anon probe (~/lykn-anon-probe.sh) and confirm every
--      admin_* RPC returns 42501 / permission denied, and every dropped view
--      returns 404 / relation does not exist.
-- ----------------------------------------------------------------------------
