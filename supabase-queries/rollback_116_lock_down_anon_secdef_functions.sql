-- ============================================================================
-- ROLLBACK for migration 116 (lock down anon-executable SECURITY DEFINER
-- functions). Restores the EXACT pre-migration ACLs captured from live prod
-- (project yxntfqgbkxjiyesewyoz) via pg_proc.proacl on 2026-07-16.
--
-- Only run this if migration 116 breaks a legitimate caller and you need the
-- previous (insecure) state back while you investigate. Re-opens the
-- cross-user read/write leaks described in the 116 header.
--
-- Placed in supabase-queries/ (not supabase-migrations/) so migration
-- tooling never applies it automatically.
-- ============================================================================

BEGIN;

-- Pre-116 proacl: {postgres=X, anon=X, service_role=X}
GRANT EXECUTE ON FUNCTION public.search_notes_bm25(uuid, text, integer) TO anon;

-- Pre-116 proacl: {postgres=X, anon=X, authenticated=X, service_role=X}
GRANT EXECUTE ON FUNCTION public.match_lykn_synthesis_chunks_for_user(vector, uuid, integer, double precision) TO anon, authenticated;

-- Pre-116 proacl: {=X, postgres=X, service_role=X}  (grant was via PUBLIC)
GRANT EXECUTE ON FUNCTION public.count_user_explicit_neurons(uuid) TO PUBLIC;

-- Pre-116 proacl: {postgres=X, anon=X, authenticated=X, service_role=X}
GRANT EXECUTE ON FUNCTION public.lykn_model_builder_wallet_apply_delta(uuid, bigint, text, text, jsonb) TO anon, authenticated;

-- Pre-116 proacl: {postgres=X, anon=X, authenticated=X, service_role=X}
-- (116 revoked anon only; authenticated was never dropped.)
GRANT EXECUTE ON FUNCTION public.lykn_merge_projects(uuid, uuid, boolean, uuid) TO anon;

-- Trigger / event-trigger functions.
-- Pre-116 proacl: {=X, postgres=X, service_role=X}  (PUBLIC grant only)
GRANT EXECUTE ON FUNCTION public.enforce_blocks_per_chat_cap()          TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_beliefs() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_chats()   TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_synthesis_neuron_cap_facts()   TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_upload_rate()                  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_vault_cap()                    TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_user_preferences()          TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.rls_auto_enable()                      TO PUBLIC;

-- Pre-116 proacl: {=X, postgres=X, anon=X, authenticated=X, service_role=X}
-- (PUBLIC grant plus direct anon/authenticated grants)
GRANT EXECUTE ON FUNCTION public.lykn_custom_agents_touch_updated_at() TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lykn_project_seed_owner_member()      TO PUBLIC, anon, authenticated;

-- Pre-116 proacl: {=X, postgres=X, anon=X, authenticated=X, service_role=X}
-- (116 section 3 revoked PUBLIC + anon; authenticated/service_role kept.)
GRANT EXECUTE ON FUNCTION public.lykn_project_has_collaborators(uuid)  TO PUBLIC, anon;

COMMIT;

-- Post-rollback verification -- expect SIX rows (the pre-116 exposure):
--
--   SELECT p.proname
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND has_function_privilege('anon', p.oid, 'EXECUTE')
--     AND p.proname IN (
--       'search_notes_bm25','match_lykn_synthesis_chunks_for_user',
--       'count_user_explicit_neurons','lykn_model_builder_wallet_apply_delta',
--       'lykn_merge_projects','lykn_project_has_collaborators');
