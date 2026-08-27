-- Generic, user-owned encrypted credentials for trusted server runtimes.
-- Secrets retain the existing CONNECTOR_TOKEN_KEY AES-GCM format so legacy
-- ciphertext can be copied without exposing or re-encrypting plaintext.

CREATE TABLE IF NOT EXISTS public.lykn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_type TEXT NOT NULL CHECK (length(trim(credential_type)) BETWEEN 1 AND 80),
  label TEXT CHECK (label IS NULL OR length(label) <= 120),
  secret_encrypted TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'reauth')),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_credentials_user_type_idx
  ON public.lykn_credentials (user_id, credential_type, updated_at DESC);

ALTER TABLE public.lykn_credentials ENABLE ROW LEVEL SECURITY;

-- Credential material is server-only. No authenticated-client policies are
-- created: the service-role runtime owns all reads and writes.

ALTER TABLE public.lykn_cursor_builds
  ADD COLUMN IF NOT EXISTS credential_id UUID
    REFERENCES public.lykn_credentials(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lykn_cursor_builds_credential_idx
  ON public.lykn_cursor_builds (credential_id)
  WHERE credential_id IS NOT NULL;

COMMENT ON TABLE public.lykn_credentials IS
  'Typed encrypted credentials resolved only by trusted server runtimes. Secrets are never exposed through user-facing APIs or model context.';

COMMENT ON COLUMN public.lykn_cursor_builds.credential_id IS
  'Generic credential used to launch and poll this Cursor Cloud build. Legacy connection_id remains temporarily for read-through migration only.';

CREATE TABLE IF NOT EXISTS public.lykn_external_auth_states (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (length(trim(purpose)) BETWEEN 1 AND 80),
  redirect_after TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lykn_external_auth_states_expiry_idx
  ON public.lykn_external_auth_states (expires_at);

ALTER TABLE public.lykn_external_auth_states ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.lykn_external_auth_states IS
  'Short-lived server-only OAuth state for product-owned external integrations. Separate from legacy connector oauth_states and MCP OAuth sessions.';
