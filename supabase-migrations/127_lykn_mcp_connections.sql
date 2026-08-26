-- ============================================================================
-- 127 — Universal MCP connections (LYKN as MCP client)
-- ============================================================================
-- Durable remote MCP connection rows. Credentials are AES-GCM encrypted and
-- never selected by list APIs. The model sees only credentialRef handles.
--
-- Vault-sync connectors (social_connections) remain LEGACY and are untouched.

CREATE TABLE IF NOT EXISTS public.lykn_mcp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  server_url TEXT NOT NULL CHECK (server_url ~* '^https?://'),
  transport TEXT NOT NULL DEFAULT 'streamable_http'
    CHECK (transport IN ('streamable_http', 'stdio')),

  auth_mode TEXT NOT NULL DEFAULT 'none'
    CHECK (auth_mode IN ('none', 'bearer')),
  secret_encrypted TEXT,

  trust_level TEXT NOT NULL DEFAULT 'remote'
    CHECK (trust_level IN ('remote', 'local_trusted')),

  server_info JSONB NOT NULL DEFAULT '{}'::jsonb,
  capability_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  classified_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  schema_hash TEXT,

  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN (
      'connected',
      'authentication_required',
      'offline',
      'error',
      'refreshing',
      'disconnected'
    )),
  last_error TEXT,

  last_connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_mcp_connections_user_idx
  ON public.lykn_mcp_connections (user_id, created_at DESC);

ALTER TABLE public.lykn_mcp_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_mcp_connections_select_own ON public.lykn_mcp_connections;
CREATE POLICY lykn_mcp_connections_select_own
  ON public.lykn_mcp_connections FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_mcp_connections_insert_own ON public.lykn_mcp_connections;
CREATE POLICY lykn_mcp_connections_insert_own
  ON public.lykn_mcp_connections FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_mcp_connections_update_own ON public.lykn_mcp_connections;
CREATE POLICY lykn_mcp_connections_update_own
  ON public.lykn_mcp_connections FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_mcp_connections_delete_own ON public.lykn_mcp_connections;
CREATE POLICY lykn_mcp_connections_delete_own
  ON public.lykn_mcp_connections FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.lykn_mcp_connections_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lykn_mcp_connections_updated_at ON public.lykn_mcp_connections;
CREATE TRIGGER lykn_mcp_connections_updated_at
  BEFORE UPDATE ON public.lykn_mcp_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.lykn_mcp_connections_set_updated_at();

COMMENT ON TABLE public.lykn_mcp_connections IS
  'LYKN-as-MCP-client connections. Encrypted secrets are injected only by trusted runtime; list APIs omit secret_encrypted.';
