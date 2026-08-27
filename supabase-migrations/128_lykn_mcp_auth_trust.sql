-- ============================================================================
-- 128 — MCP OAuth sessions, trust, identity, credential lifecycle
-- ============================================================================
-- Additive. Does not touch social_connections / Vault-sync connectors.

ALTER TABLE public.lykn_mcp_connections
  ADD COLUMN IF NOT EXISTS oauth_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS account_label TEXT,
  ADD COLUMN IF NOT EXISTS account_identity TEXT,
  ADD COLUMN IF NOT EXISTS origin TEXT,
  ADD COLUMN IF NOT EXISTS identity JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS session_epoch INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.lykn_mcp_connections
  DROP CONSTRAINT IF EXISTS lykn_mcp_connections_auth_mode_check;
ALTER TABLE public.lykn_mcp_connections
  ADD CONSTRAINT lykn_mcp_connections_auth_mode_check
  CHECK (auth_mode IN ('none', 'bearer', 'oauth'));

ALTER TABLE public.lykn_mcp_connections
  DROP CONSTRAINT IF EXISTS lykn_mcp_connections_trust_level_check;
ALTER TABLE public.lykn_mcp_connections
  ADD CONSTRAINT lykn_mcp_connections_trust_level_check
  CHECK (trust_level IN (
    'official',
    'verified',
    'community',
    'custom',
    'local_trusted',
    'enterprise',
    'remote'
  ));

ALTER TABLE public.lykn_mcp_connections
  DROP CONSTRAINT IF EXISTS lykn_mcp_connections_status_check;
ALTER TABLE public.lykn_mcp_connections
  ADD CONSTRAINT lykn_mcp_connections_status_check
  CHECK (status IN (
    'connected',
    'authentication_required',
    'authorizing',
    'offline',
    'error',
    'refreshing',
    'disconnected',
    'revoked'
  ));

CREATE TABLE IF NOT EXISTS public.lykn_mcp_oauth_sessions (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES public.lykn_mcp_connections(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_verifier TEXT,
  authorization_server_url TEXT,
  resource TEXT,
  used BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_mcp_oauth_sessions_user_idx
  ON public.lykn_mcp_oauth_sessions (user_id, created_at DESC);

ALTER TABLE public.lykn_mcp_oauth_sessions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.lykn_mcp_oauth_sessions IS
  'One-shot MCP OAuth state+PKCE. Never exposed to the model. Consumed on callback.';

COMMENT ON COLUMN public.lykn_mcp_connections.oauth_encrypted IS
  'AES-GCM blob of OAuth tokens + DCR client info. Omitted from list APIs.';
