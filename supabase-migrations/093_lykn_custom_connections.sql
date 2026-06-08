-- ============================================================================
-- 093 — Custom connections: bring-your-own API key for ANY app
-- ============================================================================
-- The universal action lane. A user attaches an arbitrary app by giving LYKN
-- its base URL + an API key (and how to send it). LYKN can then call that app
-- on the user's behalf via the lykn_call_app agent tool — the secret is
-- encrypted at rest (AES-256-GCM, CONNECTOR_TOKEN_KEY) and is INJECTED
-- server-side, so the model never sees the credential. It only references a
-- connection by slug and supplies method/path/body.
--
-- This complements the hardcoded read connectors (social_connections) and the
-- Cursor action adapter: instead of writing a bespoke adapter per app, any REST
-- API works immediately. `kind` reserves room for a future 'mcp' lane (LYKN as
-- an MCP client connecting to a user's remote MCP server).
--
-- Safety model enforced in lib/customConnections/customConnections.js:
--   • requests are host-pinned to base_url's host (the model can't redirect the
--     credential to another origin) and run through the same SSRF guard as
--     lykn_http_request (no localhost / private IPs / cloud metadata)
--   • GET/HEAD always allowed; mutating methods require allow_writes = true
--   • response size + timeout capped; per-user/host rate limited

CREATE TABLE IF NOT EXISTS public.lykn_custom_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Human label + stable slug the agent references ("acme-crm").
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,47}$'),

  -- 'rest' today; 'mcp' reserved for the future MCP-client lane.
  kind TEXT NOT NULL DEFAULT 'rest' CHECK (kind IN ('rest', 'mcp')),

  -- Origin (+ optional base path) every call is pinned to.
  base_url TEXT NOT NULL CHECK (base_url ~* '^https?://'),
  -- Free-text hint the model reads: what the API does, key endpoints, etc.
  description TEXT,

  -- How the credential is sent. 'none' = public API, no secret.
  auth_type TEXT NOT NULL DEFAULT 'bearer'
    CHECK (auth_type IN ('none', 'bearer', 'header', 'query')),
  auth_header_name TEXT,   -- when auth_type='header'  (e.g. 'X-Api-Key')
  auth_query_param TEXT,   -- when auth_type='query'   (e.g. 'api_key')

  -- AES-256-GCM blob: <iv_b64>:<tag_b64>:<ciphertext_b64>. NULL when 'none'.
  secret_encrypted TEXT,

  -- Static headers sent on every request (non-secret; e.g. an API version).
  default_headers JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Gate for mutating calls. Off by default — reads are safe, writes opt-in.
  allow_writes BOOLEAN NOT NULL DEFAULT false,

  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),

  last_used_at TIMESTAMPTZ,
  use_count INT NOT NULL DEFAULT 0,
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One slug per user (the agent resolves a connection by slug).
CREATE UNIQUE INDEX IF NOT EXISTS lykn_custom_connections_user_slug_idx
  ON public.lykn_custom_connections (user_id, slug);

CREATE INDEX IF NOT EXISTS lykn_custom_connections_user_idx
  ON public.lykn_custom_connections (user_id, created_at DESC);

ALTER TABLE public.lykn_custom_connections ENABLE ROW LEVEL SECURITY;

-- All real traffic is service-role through the Express server; these are
-- belt-and-suspenders against an anon client. Secret columns are never
-- returned to the browser (the server selects only display columns).
DROP POLICY IF EXISTS lykn_custom_connections_select_own ON public.lykn_custom_connections;
CREATE POLICY lykn_custom_connections_select_own
  ON public.lykn_custom_connections FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_custom_connections_insert_own ON public.lykn_custom_connections;
CREATE POLICY lykn_custom_connections_insert_own
  ON public.lykn_custom_connections FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_custom_connections_update_own ON public.lykn_custom_connections;
CREATE POLICY lykn_custom_connections_update_own
  ON public.lykn_custom_connections FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_custom_connections_delete_own ON public.lykn_custom_connections;
CREATE POLICY lykn_custom_connections_delete_own
  ON public.lykn_custom_connections FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.lykn_custom_connections_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lykn_custom_connections_updated_at ON public.lykn_custom_connections;
CREATE TRIGGER lykn_custom_connections_updated_at
  BEFORE UPDATE ON public.lykn_custom_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.lykn_custom_connections_set_updated_at();

COMMENT ON TABLE public.lykn_custom_connections IS
  'User-defined API connections (bring-your-own key) the LYKN agent can call via lykn_call_app. Secret is AES-GCM encrypted and injected server-side; the model never sees it.';
