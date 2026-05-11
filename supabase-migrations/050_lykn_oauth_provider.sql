-- ============================================
-- LYKN as an OAuth 2.1 provider — "Connect LYKN" inside other apps
-- Migration: 050_lykn_oauth_provider.sql
-- ============================================
-- The keystone of LYKN's four-layer integration strategy. Today (044)
-- the only way an external AI client reaches LYKN is by pasting a
-- personal-access token that the user manually mints in /Connections.
-- That works for power users, but it's a non-starter for consumer
-- onboarding — ChatGPT Connectors, Cursor's "Custom MCP via OAuth",
-- and a future LYKN GPT in the GPT Store all expect a hosted OAuth
-- flow with Dynamic Client Registration so the user just sees a
-- "Sign in with LYKN" button and a consent screen.
--
-- This migration adds the IdP-side bookkeeping LYKN needs to be that
-- OAuth provider:
--
--   • lykn_oauth_clients              — RFC 7591 Dynamic Client Registration
--                                        (one row per registered client app)
--   • lykn_oauth_authorization_codes  — short-lived codes with PKCE bound
--                                        to a (client, user, redirect_uri)
--   • lykn_oauth_consents             — durable per-(user, client) approval
--                                        so we don't re-prompt on refresh
--   • lykn_oauth_refresh_tokens       — rotating refresh tokens chained to
--                                        a row in lykn_mcp_tokens (the
--                                        access token, reused as-is)
--
-- And then extends lykn_mcp_tokens with three columns so OAuth-issued
-- access tokens slot in alongside personal-access tokens without the
-- /mcp middleware noticing the difference:
--
--   • oauth_client_id    — FK to lykn_oauth_clients.client_id
--   • oauth_consent_id   — FK to lykn_oauth_consents.id
--   • expires_at         — nullable; PATs are non-expiring, OAuth bearers expire
--
-- Spec choices (encoded here, surfaced via /.well-known later):
--   • response_types: code only (no implicit, no hybrid)
--   • grant_types:   authorization_code, refresh_token
--   • PKCE:          required, S256 only (no plain)
--   • client auth:   "none" (public + PKCE) or "client_secret_basic"
--   • scopes:        lykn:read, lykn:write, offline_access
--
-- Companion to:
--   • lykn_mcp_tokens (044) — the access-token store we extend below
--   • oauth_states (037)    — UNRELATED. That table is for OAuth flows
--                             where LYKN is the *client* (GitHub etc).
--                             This one is for LYKN as the *server*.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. lykn_oauth_clients — registered OAuth client apps (RFC 7591)
-- ---------------------------------------------------------------------------
-- One row per app that wants to OAuth into LYKN. Created either by:
--   (a) Anonymous Dynamic Client Registration: ChatGPT/Cursor/Claude POST
--       to /oauth/register with their redirect_uris, get back a client_id
--       (and optional client_secret). registered_by_user_id stays NULL.
--   (b) An admin pre-registers a "trusted partner" client via the LYKN
--       admin UI (rare in v1; here for future "we shipped a first-party
--       LYKN extension" cases). registered_by_user_id is set.
--
-- We do NOT scope client rows to a single user — a registered client is
-- a SHARED installation that any LYKN user can grant consent to. The
-- per-user binding lives in lykn_oauth_consents below.

CREATE TABLE IF NOT EXISTS lykn_oauth_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Public client identifier returned to the client app and echoed in
  -- every /authorize / /token request. Format: `lkn_client_<24 random>`.
  -- Public on purpose; the secret (if any) is what proves identity.
  client_id TEXT NOT NULL UNIQUE,

  -- SHA-256 hex of the plaintext client_secret. NULL for public clients
  -- (browser / mobile / extension) that authenticate with PKCE only.
  -- Plaintext is shown ONCE in the DCR response and never persisted.
  client_secret_hash TEXT,

  -- RFC 7591 metadata fields. Stored as snake_case TEXT to make the
  -- pass-through to /.well-known and the DCR response trivial.
  client_name TEXT NOT NULL,
  client_uri TEXT,
  logo_uri TEXT,
  tos_uri TEXT,
  policy_uri TEXT,
  software_id TEXT,
  software_version TEXT,

  -- The set of redirect_uris the client may use. Strict exact-match per
  -- the spec — no prefix matching, no wildcards. Stored as text[] so
  -- DCR-registering ChatGPT can list its multiple Connector callback URLs.
  redirect_uris TEXT[] NOT NULL CHECK (cardinality(redirect_uris) > 0),

  -- v1 supported sets — kept as text[] so we can grow later without a
  -- migration. The /token endpoint REJECTS anything outside these.
  --   grant_types:  ['authorization_code', 'refresh_token']
  --   response_types: ['code']
  grant_types TEXT[] NOT NULL DEFAULT ARRAY['authorization_code', 'refresh_token']::TEXT[],
  response_types TEXT[] NOT NULL DEFAULT ARRAY['code']::TEXT[],

  -- How the client authenticates to /token.
  --   'none'                  — public client, PKCE only (extension, mobile, browser)
  --   'client_secret_basic'   — confidential client, HTTP Basic auth (server-side apps)
  -- We deliberately DO NOT support 'client_secret_post' (passes secret in
  -- form body — discouraged) or 'private_key_jwt' (overkill for v1).
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK (token_endpoint_auth_method IN ('none', 'client_secret_basic')),

  -- Space-separated list of scopes the client MAY request, per RFC 7591.
  -- The actual token's scopes are the INTERSECTION of (this) ∩ (user
  -- consent). A client cannot escalate beyond what's listed here.
  -- v1 vocabulary: 'lykn:read lykn:write offline_access'.
  scope TEXT NOT NULL DEFAULT 'lykn:read offline_access',

  -- Lifecycle. 'pending' lets us hold a flag for clients that need
  -- manual approval later (none today — DCR auto-approves).
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'suspended')),

  -- If an admin pre-registered the client (vs. anonymous DCR), record
  -- it here. NULL is the common case for self-service DCR.
  registered_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Lightweight provenance for DCR rows so we can spot abuse (one IP
  -- registering 1000 clients/sec). Trimmed at write time.
  registration_ip INET,
  registration_user_agent TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lykn_oauth_clients_status
  ON lykn_oauth_clients (status, created_at DESC);

ALTER TABLE lykn_oauth_clients ENABLE ROW LEVEL SECURITY;

-- All real reads/writes happen via the Express server using the service
-- role (DCR is anonymous; /authorize + /token need the secret hash). We
-- expose just enough to let an admin user view the registry of clients
-- they pre-registered.
CREATE POLICY "Admins read clients they registered"
  ON lykn_oauth_clients FOR SELECT TO authenticated
  USING (auth.uid() = registered_by_user_id);

-- ---------------------------------------------------------------------------
-- 2. lykn_oauth_consents — durable per-(user, client) approval
-- ---------------------------------------------------------------------------
-- The consent screen shown at /authorize writes one row here per
-- (user, client) pair. Subsequent /authorize calls from the same client
-- with a subset of the granted scopes SKIP the consent UI ("trusted
-- application" UX). Refresh-token rotation also reads this row to know
-- the user is still happy with the relationship.
--
-- Consent CAN be revoked from /Connections — that's a separate UX from
-- "revoke this specific access token". Revoking consent invalidates ALL
-- tokens minted under it (cascade via lykn_mcp_tokens.oauth_consent_id).

CREATE TABLE IF NOT EXISTS lykn_oauth_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES lykn_oauth_clients(client_id) ON DELETE CASCADE,

  -- The scopes the user actually approved. Subset of the client's
  -- registered scope. /token enforces (requested ⊆ granted).
  scopes TEXT[] NOT NULL DEFAULT ARRAY['lykn:read']::TEXT[],

  -- Convenience: a human-readable label the user can recognise on the
  -- /Connections page. Defaults to the client_name at consent time so
  -- a later client_name change doesn't relabel old consents.
  label TEXT NOT NULL DEFAULT 'Connected app',

  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,

  -- One active consent per (user, client). New /authorize calls UPSERT
  -- — re-granting refreshes scopes & revokes any prior revocation.
  CONSTRAINT lykn_oauth_consents_user_client_unique UNIQUE (user_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_lykn_oauth_consents_user_active
  ON lykn_oauth_consents (user_id, granted_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE lykn_oauth_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own consents"
  ON lykn_oauth_consents FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users update own consents"
  ON lykn_oauth_consents FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own consents"
  ON lykn_oauth_consents FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. lykn_oauth_authorization_codes — short-lived codes (PKCE)
-- ---------------------------------------------------------------------------
-- Issued by GET /oauth/authorize after the user approves the consent
-- screen. The client redeems the code at POST /oauth/token within ~60s
-- by presenting the matching PKCE verifier and the same redirect_uri.
--
-- We store SHA-256 of the code (not the plaintext) for the same reason
-- as the access tokens: a DB compromise should not yield usable codes.
-- Codes are single-use — `consumed_at IS NULL` is the redemption check
-- and the same query that consumes the code MUST flip it atomically
-- (UPDATE ... WHERE consumed_at IS NULL RETURNING ...).

CREATE TABLE IF NOT EXISTS lykn_oauth_authorization_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SHA-256 of the opaque code (`lkn_code_<random>`). UNIQUE so the
  -- redemption query can be a single keyed lookup.
  code_hash TEXT NOT NULL UNIQUE,

  client_id TEXT NOT NULL REFERENCES lykn_oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_id UUID NOT NULL REFERENCES lykn_oauth_consents(id) ON DELETE CASCADE,

  -- The redirect_uri the code was bound to. /token MUST receive the
  -- exact same one and reject otherwise (RFC 6749 §10.6).
  redirect_uri TEXT NOT NULL,

  -- The space-separated scope string the code was issued for. /token
  -- mints an access token with these exact scopes.
  scope TEXT NOT NULL,

  -- PKCE binding (RFC 7636). S256 only — `plain` is rejected at
  -- /authorize. The verifier presented at /token is hashed and
  -- compared against this challenge.
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256'
    CHECK (code_challenge_method = 'S256'),

  -- Echoed back into the redirect by /authorize so the client can
  -- correlate the response with its in-flight request. We persist it
  -- so the resource server can audit if needed.
  state TEXT,

  -- Code TTL — spec recommends "as short as possible", we go 60s.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '60 seconds'),

  -- Single-use enforcement. Set to now() in the same UPDATE that
  -- redeems the code. A second redemption attempt observes the prior
  -- consumed_at and is rejected with invalid_grant. This is also our
  -- cue to invalidate any tokens already minted from the code (RFC
  -- 6749 §4.1.2).
  consumed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cleanup helper — admins can prune codes older than ~1h. Codes are
-- expired-at-60s so anything past that is dead weight.
CREATE INDEX IF NOT EXISTS idx_lykn_oauth_authz_codes_expires
  ON lykn_oauth_authorization_codes (expires_at);

ALTER TABLE lykn_oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
-- No policies: codes are touched only by the server using the service role.

-- ---------------------------------------------------------------------------
-- 4. lykn_oauth_refresh_tokens — rotating refresh tokens
-- ---------------------------------------------------------------------------
-- One row per refresh token issued. We rotate on every /token use
-- (replaced_by chains the family) and detect token-replay attacks by
-- watching for redemption of a token whose `replaced_by` is non-null —
-- that means an attacker redeemed an already-used token, and per
-- RFC 6749 §10.4 we revoke the entire family + access tokens.
--
-- Refresh tokens are bound 1:1 to a row in lykn_mcp_tokens (the
-- access token). Revoking the access token cascades to the refresh
-- token via access_token_id FK ON DELETE CASCADE.

CREATE TABLE IF NOT EXISTS lykn_oauth_refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- SHA-256 of the opaque refresh token (`lkn_refresh_<random>`).
  refresh_hash TEXT NOT NULL UNIQUE,

  client_id TEXT NOT NULL REFERENCES lykn_oauth_clients(client_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_id UUID NOT NULL REFERENCES lykn_oauth_consents(id) ON DELETE CASCADE,

  -- The access token this refresh token was issued alongside. When the
  -- access token is revoked (via /Connections or via /oauth/revoke) the
  -- refresh token dies too via FK cascade. NOTE: we set this AFTER the
  -- access-token row is inserted in the same /token transaction, so
  -- this column is nullable to avoid a chicken-and-egg.
  access_token_id UUID REFERENCES lykn_mcp_tokens(id) ON DELETE CASCADE,

  scope TEXT NOT NULL,

  -- Refresh tokens last longer than access tokens. v1 default 30 days;
  -- /token rejects expired ones with invalid_grant.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),

  -- Rotation chain: when this refresh token is redeemed for a new
  -- access+refresh pair, we set consumed_at=now() and replaced_by to
  -- the new row's id. A redemption attempt where replaced_by IS NOT
  -- NULL → suspected replay → revoke whole family.
  consumed_at TIMESTAMPTZ,
  replaced_by UUID REFERENCES lykn_oauth_refresh_tokens(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lykn_oauth_refresh_active
  ON lykn_oauth_refresh_tokens (refresh_hash)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lykn_oauth_refresh_user_client
  ON lykn_oauth_refresh_tokens (user_id, client_id, created_at DESC);

ALTER TABLE lykn_oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
-- No policies: refresh tokens are touched only by the server.

-- ---------------------------------------------------------------------------
-- 5. Extend lykn_mcp_tokens with OAuth lineage
-- ---------------------------------------------------------------------------
-- The access token issued at the end of an OAuth flow IS a row in
-- lykn_mcp_tokens — same table as PATs, same hash-only storage, same
-- middleware lookup. The columns below tag the row with where it came
-- from so the /Connections UI can show "Issued via OAuth (ChatGPT)"
-- vs. "Issued by you (Claude Desktop)" and so revoking a consent can
-- nuke every token ever minted under it.

ALTER TABLE lykn_mcp_tokens
  ADD COLUMN IF NOT EXISTS oauth_client_id TEXT REFERENCES lykn_oauth_clients(client_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS oauth_consent_id UUID REFERENCES lykn_oauth_consents(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- An "OAuth token" has BOTH oauth_client_id and oauth_consent_id set.
-- A "PAT" has both NULL. We don't enforce this with a CHECK constraint
-- (would block migration backfill if we ever needed it), but the
-- /Connections UI uses (oauth_client_id IS NOT NULL) as the OAuth filter.
COMMENT ON COLUMN lykn_mcp_tokens.oauth_client_id IS
  'NULL for personal-access tokens; set for tokens minted via /oauth/token. Tells the UI how to label provenance.';
COMMENT ON COLUMN lykn_mcp_tokens.oauth_consent_id IS
  'NULL for PATs; set for OAuth-issued tokens. Cascade-deleted when the user revokes consent at /Connections.';
COMMENT ON COLUMN lykn_mcp_tokens.expires_at IS
  'NULL for PATs (non-expiring). Set for OAuth bearers (typ. now()+1h). The /mcp middleware rejects rows where now() > expires_at.';

-- Cheap query: "all active OAuth tokens for this user-client pair".
-- Used by the consent-revoke path to enumerate what to invalidate.
CREATE INDEX IF NOT EXISTS idx_lykn_mcp_tokens_oauth_consent
  ON lykn_mcp_tokens (oauth_consent_id)
  WHERE oauth_consent_id IS NOT NULL;

-- The active-lookup partial index from 044 is on (token_hash) WHERE
-- status = 'active'. That's still correct — expires_at is checked in
-- application code so a row can be active but expired (and the next
-- scheduled job will flip it to status='expired').

-- ---------------------------------------------------------------------------
-- 6. updated_at trigger for lykn_oauth_clients
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lykn_oauth_clients_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lykn_oauth_clients_updated_at ON lykn_oauth_clients;
CREATE TRIGGER lykn_oauth_clients_updated_at
  BEFORE UPDATE ON lykn_oauth_clients
  FOR EACH ROW
  EXECUTE FUNCTION lykn_oauth_clients_set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE lykn_oauth_clients IS
  'Registered OAuth client apps (RFC 7591 DCR). One row per app that wants to OAuth into LYKN.';
COMMENT ON TABLE lykn_oauth_consents IS
  'Durable per-(user, client) approval. Re-grants UPSERT; revoke cascades to all tokens minted under it.';
COMMENT ON TABLE lykn_oauth_authorization_codes IS
  'Short-lived (60s) PKCE-bound auth codes. Single-use via consumed_at; replay detection cascades to refresh family.';
COMMENT ON TABLE lykn_oauth_refresh_tokens IS
  'Rotating refresh tokens. Bound 1:1 to lykn_mcp_tokens.id; replay detection revokes the whole family per RFC 6749 §10.4.';
