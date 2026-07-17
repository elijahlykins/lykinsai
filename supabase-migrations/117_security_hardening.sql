-- ============================================================================
-- 117 — Security hardening pass
-- ============================================================================
-- Three fixes surfaced by a full security audit:
--
--   1. search_notes_bm25() is SECURITY DEFINER, takes an arbitrary p_user_id,
--      and was granted to `authenticated`. Any signed-in user could call it
--      with another user's UUID and read that user's private vault note IDs +
--      titles (a content-presence oracle). It must be service-role only — the
--      in-app path always goes through the service role, which is unaffected.
--
--   2. count_user_explicit_neurons() is SECURITY DEFINER and was revoked from
--      `anon` (068) but not `authenticated`, leaking another user's total item
--      count. It's only ever called internally by the SECURITY DEFINER cap
--      triggers (which run as the definer), so no legitimate caller needs the
--      `authenticated` grant.
--
--   3. The chat-share tables (lykn_chat_shares / lykn_chats / lykn_chat_states,
--      formerly omnia_*) had token-less "public can read active shares" SELECT
--      policies. Because RLS is the only gate PostgREST enforces, an anonymous
--      client could enumerate EVERY active share's token, chat_id, and owner
--      UUID (and then read every shared chat's content) with a filter-less
--      request. The unguessable-token model was never actually enforced. We
--      drop those policies and resolve shares through a token-argument RPC
--      instead. (These tables are currently dormant — no server/client code
--      references them — so this changes no live flow.)
--
-- Plus a small defense-in-depth: pin search_path on two trigger functions that
-- slipped past the 069 pinning pass.
-- ----------------------------------------------------------------------------

-- 1. Vault full-text search: service-role only.
REVOKE EXECUTE ON FUNCTION public.search_notes_bm25(uuid, text, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.search_notes_bm25(uuid, text, integer) FROM PUBLIC;
-- (service_role grant from migration 098 remains in force.)

-- 2. Neuron count: drop the authenticated grant (068 only dropped anon).
REVOKE EXECUTE ON FUNCTION public.count_user_explicit_neurons(uuid) FROM authenticated;

-- 3. Chat-share tables: remove enumerable public read policies.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'lykn_chat_shares') THEN
    -- Policy names carried over from the omnia_* era (renaming a table keeps
    -- its policies). Drop every public/anon read path on the share tables.
    DROP POLICY IF EXISTS "Public can resolve active share tokens" ON public.lykn_chat_shares;
    DROP POLICY IF EXISTS "Public can read boards with an active share" ON public.lykn_chats;
    DROP POLICY IF EXISTS "Public can read board states with an active share" ON public.lykn_chat_states;
  END IF;
END $$;

-- Token-argument resolver: returns the single matching active share (or no
-- rows). SECURITY DEFINER so it can read past RLS, but only ever for the exact
-- token supplied — no enumeration. The token remains the unguessable secret.
CREATE OR REPLACE FUNCTION public.resolve_chat_share(p_token TEXT)
RETURNS TABLE (chat_id UUID, owner_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.chat_id, s.owner_id
  FROM public.lykn_chat_shares s
  WHERE s.token = p_token
    AND s.revoked_at IS NULL
    AND (s.expires_at IS NULL OR s.expires_at > NOW())
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_chat_share(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_chat_share(TEXT) TO anon, authenticated;

-- Read the shared chat + its state by token, again scoped to one token so
-- nothing is enumerable. Callers pass the token they already hold.
CREATE OR REPLACE FUNCTION public.read_shared_chat(p_token TEXT)
RETURNS TABLE (chat_id UUID, chat JSONB, state JSONB)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH share AS (
    SELECT s.chat_id
    FROM public.lykn_chat_shares s
    WHERE s.token = p_token
      AND s.revoked_at IS NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
    LIMIT 1
  )
  SELECT
    c.id,
    to_jsonb(c.*) AS chat,
    (SELECT to_jsonb(st.*) FROM public.lykn_chat_states st WHERE st.chat_id = c.id) AS state
  FROM public.lykn_chats c
  JOIN share ON share.chat_id = c.id;
$$;

REVOKE ALL ON FUNCTION public.read_shared_chat(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_shared_chat(TEXT) TO anon, authenticated;

-- 4. Defense-in-depth: pin search_path on trigger functions missed by 069.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'lykn_custom_connections_set_updated_at') THEN
    EXECUTE 'ALTER FUNCTION public.lykn_custom_connections_set_updated_at() SET search_path = pg_catalog, public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'touch_lykn_steward_items_updated_at') THEN
    EXECUTE 'ALTER FUNCTION public.touch_lykn_steward_items_updated_at() SET search_path = pg_catalog, public';
  END IF;
END $$;
