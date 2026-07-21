-- ============================================================================
-- Migration 116: lock down the anon-executable SECURITY DEFINER functions
-- still exposed to the shipped anon key in prod (project yxntfqgbkxjiyesewyoz).
--
-- App Review audit 2026-07-16, checklist #9 (anon-lockdown). Approach chosen:
-- REVOKE (not CREATE OR REPLACE with auth.uid()) for the critical functions,
-- because a read-only call-site sweep of both repos (2026-07-16) shows their
-- only legitimate callers use the service role, which keeps its direct grant.
-- Revoking preserves every function's signature, body, and return shape, so
-- no caller changes are needed. lykn_merge_projects is the one function with
-- a real authenticated-JWT caller; it keeps `authenticated` and only loses
-- `anon` (see section 2).
--
-- WHY EARLIER LOCKDOWNS (067/078/092/098, and 068) DIDN'T STICK -- two
-- distinct failure modes, confirmed against live pg_proc.proacl 2026-07-16:
--
--   (a) Direct anon grants re-appeared. Supabase sets
--       ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO
--       anon, authenticated, service_role -- so any later DROP+CREATE of a
--       function (072, 092, 097, 098 rework, 109) silently re-granted anon
--       DIRECTLY. Live proacl e.g. search_notes_bm25:
--       {postgres=X, anon=X, service_role=X}. Fix: REVOKE ... FROM anon.
--
--   (b) PUBLIC grants were never removed on some functions.
--       count_user_explicit_neurons and the enforce_*/handle_new_user_*
--       trigger functions carry `=X/postgres` (a PUBLIC grant) in proacl;
--       anon inherits EXECUTE through PUBLIC, and `REVOKE ... FROM anon`
--       is a NO-OP against a PUBLIC grant. Fix: REVOKE ... FROM PUBLIC.
--
--   This migration revokes from PUBLIC, anon (and authenticated where no
--   client should call with a bearer token either) on every function, so it
--   is correct regardless of which mechanism granted the access, and is
--   idempotent (revoking a grant that doesn't exist is a no-op).
--
-- THE CRITICAL LEAKS (all reachable with the anon key embedded in the iOS
-- bundle, all SECURITY DEFINER, none checks auth.uid()):
--   * search_notes_bm25(p_user_id uuid, p_query text, match_count int)
--     -- returns any user's note text by UUID.
--   * match_lykn_synthesis_chunks_for_user(vector, uuid, int, float)
--     -- returns any user's synthesis-chunk content; caller controls
--     match_threshold so the whole corpus can be dumped.
--   * count_user_explicit_neurons(p_user uuid) -- leaks per-user counts.
--   * lykn_model_builder_wallet_apply_delta(...) -- mutates any user's
--     wallet balance + ledger.
--   * lykn_merge_projects(...) -- anon (auth.uid() NULL) with an arbitrary
--     p_user_id skips the p_user_id <> auth.uid() guard (it only fires when
--     BOTH are non-null) and can merge/delete a victim's projects.
--
-- VERIFIED CALL-SITE FACTS (grep of LYKN-Ideation + LYKN-iOS, 2026-07-16):
--   * search_notes_bm25, match_lykn_synthesis_chunks_for_user -> only ever
--     invoked via ctx.supabaseAdmin / supabaseAdmin (service role) in
--     mcp-tools/searchVault.js and server.js. No web client caller. iOS
--     mentions them only in comments (Vault search is a local filter; BM25
--     fusion is server-side future work).
--   * count_user_explicit_neurons -> only called inside the
--     enforce_synthesis_neuron_cap_* trigger functions, which run as their
--     owner (postgres); trigger firing does not check the invoking role's
--     EXECUTE privilege, so no grant beyond postgres/service_role is needed.
--   * lykn_model_builder_wallet_apply_delta -> only
--     lib/modelBuilder/modelBuilderWallet.js (feature-flagged Stripe/server
--     path). Migration 078 already intended service_role only.
--   * lykn_merge_projects -> web src/lib/userProjects.ts calls it under an
--     authenticated JWT (no p_user_id; identity from auth.uid()); MCP
--     mergeProjects.js uses ctx.supabaseAdmin + explicit p_user_id. Neither
--     needs anon. The authenticated path cannot spoof p_user_id: with a
--     non-null auth.uid(), a mismatched p_user_id raises.
--
-- FULL DISPOSITION RECORD: see 116_DISPOSITION.md (same directory) for the
-- complete 26-row table -- every anon-executable SECURITY DEFINER function
-- found in live prod on 2026-07-16, its grants, the action taken here, and
-- the concrete justification for every function this migration does NOT
-- touch. Nothing is undispositioned.
--
-- NOT touched by this migration (documented, intentional anon surface):
--   * lykn_chat_share_record_view / read_shared_chat / resolve_chat_share
--     -- token-gated public chat-share landing pages, anon by design
--     (return/mutate nothing without a valid, unrevoked, unexpired token;
--     1 active share row exists in prod).
--   * vault_manual_notes_for_graph, vault_connector_source_counts,
--     lykn_is_project_member / _is_project_owner / _project_can_edit /
--     _list_project_members / _accept_project_invites -- all filter on
--     auth.uid() (return [] / 0 / false / no-op for anon) and the
--     lykn_is_* / _can_edit helpers back RLS predicates that must remain
--     executable by the querying role.
--   NOTE: lykn_project_has_collaborators was ORIGINALLY listed here, but a
--   body re-check (2026-07-16, disposition pass) shows it has NO auth.uid()
--   guard -- anyone with the shipped anon key could probe arbitrary project
--   UUIDs for a has-collaborators boolean. It is now locked down in
--   section 3 below.
--
-- PREPARE-ONLY: do NOT auto-apply. Review, apply out-of-band against prod,
-- then run the verification queries at the bottom (expect zero rows).
-- Rollback: supabase-queries/rollback_116_lock_down_anon_secdef_functions.sql
-- restores the exact pre-migration ACLs captured on 2026-07-16.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Critical user-id-parameterised functions with no auth.uid() check.
--    Only ever called by the backend service role -> revoke PUBLIC, anon AND
--    authenticated (no client should reach these with a bearer token either),
--    and re-assert the service_role grant explicitly so intent is durable.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.search_notes_bm25(uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.match_lykn_synthesis_chunks_for_user(vector, uuid, integer, double precision)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.count_user_explicit_neurons(uuid)
  FROM PUBLIC, anon, authenticated;  -- live grant is via PUBLIC (`=X`); the FROM PUBLIC clause is the load-bearing one
REVOKE EXECUTE ON FUNCTION public.lykn_model_builder_wallet_apply_delta(uuid, bigint, text, text, jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.search_notes_bm25(uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.match_lykn_synthesis_chunks_for_user(vector, uuid, integer, double precision) TO service_role;
GRANT EXECUTE ON FUNCTION public.count_user_explicit_neurons(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.lykn_model_builder_wallet_apply_delta(uuid, bigint, text, text, jsonb) TO service_role;

-- ----------------------------------------------------------------------------
-- 2. Destructive project merge. Web calls it under an authenticated JWT
--    (identity from auth.uid(), no p_user_id); the MCP server uses the
--    service-role client. Revoke anon; KEEP authenticated + service_role.
--    (auth.uid() is NULL for anon, which slips past the in-body
--    p_user_id/auth.uid() mismatch guard -- revoking anon closes that path.)
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.lykn_merge_projects(uuid, uuid, boolean, uuid)
  FROM PUBLIC, anon;

-- ----------------------------------------------------------------------------
-- 3. lykn_project_has_collaborators(p_project uuid). SECURITY DEFINER with NO
--    auth.uid() guard and no token gate: it answers, for ANY project UUID,
--    whether the project has non-owner member rows. Anon (shipped iOS key)
--    could probe arbitrary UUIDs. No RLS policy references it (checked
--    pg_policies 2026-07-16, and every policy on the project tables is
--    roles={authenticated} anyway), so anon EXECUTE is not load-bearing.
--    The one real caller is web src/lib/userProjects.ts mergeProjects()
--    under an authenticated JWT -> revoke PUBLIC + anon, KEEP authenticated
--    and service_role.
--    Residual (accepted, low): an authenticated user can still probe foreign
--    project UUIDs for the boolean. UUIDv4s are unguessable and the answer
--    is one bit; adding an in-body membership guard is follow-up work, not
--    done here because 116 is deliberately REVOKE-only (no body changes).
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.lykn_project_has_collaborators(uuid)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.lykn_project_has_collaborators(uuid) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 4. Internal trigger / event-trigger functions. These cannot be invoked
--    through PostgREST RPC (calling a trigger function directly errors), so
--    the grants are inert -- but they are spurious PUBLIC/default grants that
--    068 already intended to strip. Defense in depth. Trigger firing checks
--    the function owner's rights, not the invoker's EXECUTE, so revoking
--    PUBLIC/anon/authenticated cannot break inserts/updates that fire them.
-- ----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.enforce_blocks_per_chat_cap()            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_beliefs()   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_chats()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_facts()     FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_upload_rate()                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_vault_cap()                      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_preferences()            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lykn_custom_agents_touch_updated_at()    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.lykn_project_seed_owner_member()         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()                        FROM PUBLIC, anon, authenticated;

COMMIT;

-- ============================================================================
-- Post-apply verification (run each; expected results noted).
-- ============================================================================
-- (V1) The six RPC-reachable functions must no longer be anon-executable.
--      Expect ZERO rows:
--
--   SELECT p.proname
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND has_function_privilege('anon', p.oid, 'EXECUTE')
--     AND p.proname IN (
--       'search_notes_bm25','match_lykn_synthesis_chunks_for_user',
--       'count_user_explicit_neurons','lykn_model_builder_wallet_apply_delta',
--       'lykn_merge_projects','lykn_project_has_collaborators');
--
-- (V2) authenticated must be gone from the service-role-only four but KEPT on
--      lykn_merge_projects. Expect exactly one row: lykn_merge_projects.
--
--   SELECT p.proname
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
--     AND p.proname IN (
--       'search_notes_bm25','match_lykn_synthesis_chunks_for_user',
--       'count_user_explicit_neurons','lykn_model_builder_wallet_apply_delta',
--       'lykn_merge_projects');
--
-- (V3) service_role must still hold EXECUTE on all five. Expect FIVE rows:
--
--   SELECT p.proname
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND has_function_privilege('service_role', p.oid, 'EXECUTE')
--     AND p.proname IN (
--       'search_notes_bm25','match_lykn_synthesis_chunks_for_user',
--       'count_user_explicit_neurons','lykn_model_builder_wallet_apply_delta',
--       'lykn_merge_projects');
--
-- (V4) No remaining SECURITY DEFINER function in public should be
--      anon-executable except the documented intentional anon surface.
--      Expect ONLY these TEN: lykn_chat_share_record_view, read_shared_chat,
--      resolve_chat_share, vault_manual_notes_for_graph,
--      vault_connector_source_counts, lykn_is_project_member,
--      lykn_is_project_owner, lykn_project_can_edit,
--      lykn_list_project_members, lykn_accept_project_invites.
--      (lykn_project_has_collaborators must NOT appear -- section 3.)
--
--   SELECT p.proname, pg_get_function_identity_arguments(p.oid)
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND has_function_privilege('anon', p.oid, 'EXECUTE')
--   ORDER BY p.proname;
--
-- ============================================================================
-- Client call sites to re-test after apply:
--   * mcp-tools/searchVault.js  -- BM25 + semantic fused vault search
--     (service role; must keep working).
--   * server.js /api/ai/stream synthesis retrieval -- calls
--     match_lykn_synthesis_chunks_for_user via supabaseAdmin.
--   * lib/modelBuilder/modelBuilderWallet.js -- wallet apply-delta path
--     (feature-flagged; exercise if MODEL_BUILDER_WALLET is enabled).
--   * Web: src/lib/userProjects.ts mergeProjects() -- authenticated JWT;
--     must keep working (authenticated grant retained).
--   * MCP: mcp-tools/mergeProjects.js -- service role; must keep working.
--   * Any insert into vault_items / lykn_chat tables (exercises the
--     enforce_* triggers) -- e.g. iOS vault save + chat send round-trip,
--     new-user signup (handle_new_user_preferences on auth.users).
--   * Web: src/lib/userProjects.ts mergeProjects() collaboration guard --
--     calls lykn_project_has_collaborators under an authenticated JWT; must
--     keep working (authenticated grant retained in section 3).
--   * Negative test: anon-key RPC to search_notes_bm25 /
--     match_lykn_synthesis_chunks_for_user / count_user_explicit_neurons /
--     lykn_model_builder_wallet_apply_delta / lykn_merge_projects /
--     lykn_project_has_collaborators must now return 42501 permission denied.
-- ============================================================================
