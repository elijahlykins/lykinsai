-- ============================================
-- LYKN connector framework — generic OAuth + sync state
-- Migration: 037_social_connections.sql
-- ============================================
-- One row in `social_connections` per (user, provider, account) with the
-- access / refresh tokens encrypted at rest. Every OAuth-based connector
-- (GitHub first, then Reddit, Notion, Spotify, Pinterest, Slack, Google,
-- etc.) reads/writes through this single table.
--
-- `oauth_states` is the short-lived CSRF anti-replay store used during the
-- authorization-code dance. Each row is 1 OAuth attempt and is deleted as
-- soon as the callback consumes it.
--
-- Token encryption is performed in application code (AES-256-GCM with a
-- key from CONNECTOR_TOKEN_KEY). This migration just provides the columns.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- social_connections — one row per linked account
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Provider key: 'github', 'reddit', 'notion', 'spotify', 'pinterest', ...
  -- Matches the connector id used by catalog.js, so the UI and the
  -- backend agree on identity.
  provider TEXT NOT NULL,

  -- Stable identifier from the provider (numeric GitHub ID, Notion bot id,
  -- Spotify user id, etc.). Combined with (user_id, provider) it uniquely
  -- identifies a connection — letting one user link several accounts of
  -- the same kind down the line ("personal" + "work" GitHubs).
  provider_user_id TEXT NOT NULL,

  -- Display fields cached at connect time so the UI doesn't have to call
  -- the provider just to render the card label.
  account_handle TEXT,                       -- "@octocat"
  account_display_name TEXT,                 -- "Mona Lisa"
  account_email TEXT,
  account_avatar_url TEXT,

  -- Granted scopes (informational; per-provider format).
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Encrypted token blobs. Format produced by app code:
  --   <iv_b64>:<auth_tag_b64>:<ciphertext_b64>
  -- Always treat as opaque at the SQL layer.
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,              -- NULL = never expires

  -- Per-provider extras: pagination cursors, page sizes, "since" anchors,
  -- webhook subscription ids, region preferences, etc. Keeps adapters
  -- flexible without schema churn for every new connector.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Lifecycle:
  --   active       → polling/syncing normally
  --   paused       → user disabled; skipped by background sync
  --   error        → repeated sync failures; backed off but still retried
  --   reauth       → token revoked / refresh failed; user must reconnect
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'error', 'reauth')),

  last_synced_at TIMESTAMPTZ,
  last_sync_count INT NOT NULL DEFAULT 0,    -- items added by latest sync
  total_synced_count INT NOT NULL DEFAULT 0, -- lifetime counter
  consecutive_errors INT NOT NULL DEFAULT 0,
  last_error TEXT,
  sync_interval_minutes INT NOT NULL DEFAULT 60
    CHECK (sync_interval_minutes >= 5 AND sync_interval_minutes <= 1440),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One (user, provider, account) is unique. A user reconnecting their same
-- GitHub account just upserts this row instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conn_user_prov_acct
  ON social_connections (user_id, provider, provider_user_id);

CREATE INDEX IF NOT EXISTS idx_conn_user
  ON social_connections (user_id, created_at DESC);

-- Background sync uses this: "active connections, oldest sync first".
CREATE INDEX IF NOT EXISTS idx_conn_due
  ON social_connections (status, last_synced_at NULLS FIRST);

ALTER TABLE social_connections ENABLE ROW LEVEL SECURITY;

-- All real client traffic goes through the Express server using the
-- service role; these policies are belt-and-suspenders against an anon
-- client ever touching the table. Token columns are never returned to
-- the client (server selects only the display columns).
CREATE POLICY "users read own connections"
  ON social_connections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "users update own connections"
  ON social_connections FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "users delete own connections"
  ON social_connections FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- oauth_states — short-lived CSRF/state store
-- ---------------------------------------------------------------------------
-- Created when a user clicks "Connect <provider>". Consumed (and deleted)
-- when the provider redirects back to /oauth/callback. Rows older than 10
-- minutes are vacuumed by the same background task that runs sync.
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,

  -- Optional code_verifier for PKCE flows (Reddit, Notion, Twitter, ...).
  code_verifier TEXT,

  -- Where to send the user's browser after success — usually the dialog
  -- that opened the popup. Defaults to /connections at the application root.
  redirect_after TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_user
  ON oauth_states (user_id, created_at DESC);

-- Service role only. No SELECT/INSERT policies for authenticated users.
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- updated_at trigger for social_connections
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION social_connections_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS social_connections_updated_at ON social_connections;
CREATE TRIGGER social_connections_updated_at
  BEFORE UPDATE ON social_connections
  FOR EACH ROW
  EXECUTE FUNCTION social_connections_set_updated_at();
