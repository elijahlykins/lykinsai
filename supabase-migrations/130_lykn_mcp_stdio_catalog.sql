-- ============================================================================
-- 130 — Local stdio MCP + marketplace metadata
-- ============================================================================
-- Additive. Marketplace is discovery metadata only. Execution stays Universal MCP.

ALTER TABLE public.lykn_mcp_connections
  ALTER COLUMN server_url DROP NOT NULL;

ALTER TABLE public.lykn_mcp_connections
  DROP CONSTRAINT IF EXISTS lykn_mcp_connections_server_url_check;

ALTER TABLE public.lykn_mcp_connections
  ADD CONSTRAINT lykn_mcp_connections_server_url_check
  CHECK (
    (
      transport = 'streamable_http'
      AND server_url IS NOT NULL
      AND server_url ~* '^https?://'
    )
    OR (
      transport = 'stdio'
      AND (server_url IS NULL OR length(trim(server_url)) = 0 OR server_url LIKE 'stdio:%')
    )
  );

ALTER TABLE public.lykn_mcp_connections
  ADD COLUMN IF NOT EXISTS command TEXT,
  ADD COLUMN IF NOT EXISTS args JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS working_directory TEXT,
  ADD COLUMN IF NOT EXISTS env_credential_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS catalog_id TEXT,
  ADD COLUMN IF NOT EXISTS catalog_source JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provided_through TEXT;

COMMENT ON COLUMN public.lykn_mcp_connections.command IS
  'Local stdio executable. Never a shell string. Secrets must not appear here.';
COMMENT ON COLUMN public.lykn_mcp_connections.env_credential_refs IS
  'Map of ENV_NAME -> credential ref. Raw secrets are never persisted.';
COMMENT ON COLUMN public.lykn_mcp_connections.catalog_id IS
  'Marketplace entry id used at connect time. Metadata only, not execution authority.';
