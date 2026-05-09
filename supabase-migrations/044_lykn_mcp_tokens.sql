-- ============================================
-- LYKN MCP — per-user bearer tokens for outbound clients
-- Migration: 044_lykn_mcp_tokens.sql
-- ============================================
-- The "context backplane" half of LYKN: instead of LYKN being yet-another
-- chat surface, expose the synthesis layer (beliefs, rules, facts, vault)
-- to whatever AI client the user already lives in — Claude Desktop, Claude
-- Code, Cursor, ChatGPT custom GPTs, Cline, etc.
--
-- Each row here is one (user, client) pairing — a personal-access token
-- the user pasted into Claude Desktop's config or that Cursor minted via
-- our deeplink installer. The plaintext is shown ONCE at creation and only
-- the SHA-256 hash is stored at rest. Same security shape as a GitHub PAT.
--
-- Auth is then: the MCP/REST request arrives with `Authorization: Bearer
-- lkn_live_<random>`, the server hashes it, looks it up in this table, and
-- the row's `user_id` becomes `req.user.id` for the rest of the pipeline.
-- One middleware (`requireAuthOrMcpToken`) accepts EITHER a Supabase JWT
-- or one of these tokens, so the same /api/v1/synthesis/* routes work for
-- the LYKN frontend AND for any external AI client.
--
-- Companion to:
--   • lykn_beliefs / lykn_rules / lykn_result_attributions (043)
--   • lykn_user_model_facts (039)
--   • social_connections / oauth_states (037-038)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. lykn_mcp_tokens — per-user, per-client bearer tokens
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_mcp_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Human label set by the user at creation. Defaults to the client kind
  -- they're hooking up ("Claude Desktop", "Cursor on my MacBook"). NEVER
  -- contains the secret.
  label TEXT NOT NULL DEFAULT 'AI client',

  -- The intended client kind chosen on the Connections page. Used so the
  -- "Connected clients" table can render an icon + a smart default label,
  -- and so per-client install instructions can be re-shown if the user
  -- needs to re-paste the token. Free-form so we don't churn the schema
  -- when a new client appears.
  --   'claude-desktop' | 'claude-code' | 'cursor' | 'chatgpt' | 'other'
  client_kind TEXT NOT NULL DEFAULT 'other',

  -- SHA-256 hex of the plaintext token. We never store the secret itself
  -- — once the user copies it from the issue dialog they're on their own.
  -- Indexed UNIQUE so token validation is a single keyed lookup.
  token_hash TEXT NOT NULL,

  -- First/last 4 chars of the plaintext token (`lkn_live_xxxx…yyyy`) so
  -- the UI can disambiguate "which one is this" in the Connected Clients
  -- list without forcing the user to remember opaque hashes. Plaintext
  -- prefix only — never enough to reconstruct the secret.
  token_prefix TEXT NOT NULL,

  -- Coarse capability set. v1 is just ['read'] or ['read', 'write']. Free
  -- plans get read-only; paid plans can mint write-capable tokens. Stored
  -- as text[] so we can grow this without migrations (e.g. 'beliefs:read'
  -- once we want finer scopes per surface).
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],

  -- Lifecycle.
  --   active   — works
  --   revoked  — user clicked Revoke (or admin disabled). Returns 401.
  --   expired  — auto-rotated; we keep the row for audit, not the secret.
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),

  -- Wall-clock telemetry the Connections page surfaces:
  --   last_used_at         — bumped async on every successful auth.
  --   last_used_client     — User-Agent / MCP client_info string trimmed
  --                          to ~120 chars. Lets the user spot a token
  --                          that's hitting them from somewhere unexpected.
  --   last_used_tool       — last MCP/REST tool name the token invoked.
  --                          Helpful when the user has 3 tokens and isn't
  --                          sure which one Claude Desktop is using.
  last_used_at TIMESTAMPTZ,
  last_used_client TEXT,
  last_used_tool TEXT,

  -- Lifetime usage counter — bumped non-atomically alongside last_used_at.
  -- Cheap admin metric ("which user is hammering us?").
  use_count BIGINT NOT NULL DEFAULT 0,

  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Two tokens with the same hash would let an attacker who guessed one
  -- piggyback on a different user. The probability is astronomically low
  -- with a 32-byte random secret, but the unique index is free insurance.
  CONSTRAINT lykn_mcp_tokens_hash_unique UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_lykn_mcp_tokens_user_status
  ON lykn_mcp_tokens (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lykn_mcp_tokens_active_lookup
  ON lykn_mcp_tokens (token_hash)
  WHERE status = 'active';

ALTER TABLE lykn_mcp_tokens ENABLE ROW LEVEL SECURITY;

-- All real traffic goes through the Express server using the service role
-- (so we can hash + look up the token without exposing the table to PostgREST
-- with anon). The policies below are belt-and-suspenders for the case where
-- a Supabase-JWT'd client wants to list its own tokens via PostgREST. We
-- never expose the hash or the prefix outside the server.
CREATE POLICY "Users read own mcp tokens"
  ON lykn_mcp_tokens FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users update own mcp tokens"
  ON lykn_mcp_tokens FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own mcp tokens"
  ON lykn_mcp_tokens FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- INSERT policy intentionally omitted: tokens must be minted by the server
-- (which generates the secret + hash) so a logged-in client can never
-- forge a row with a known secret. The server uses the service role.

-- ---------------------------------------------------------------------------
-- 2. updated_at trigger — keep updated_at fresh on every UPDATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION lykn_mcp_tokens_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lykn_mcp_tokens_updated_at ON lykn_mcp_tokens;
CREATE TRIGGER lykn_mcp_tokens_updated_at
  BEFORE UPDATE ON lykn_mcp_tokens
  FOR EACH ROW
  EXECUTE FUNCTION lykn_mcp_tokens_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Optional: extend lykn_result_attributions.surface for MCP traffic
-- ---------------------------------------------------------------------------
-- The `surface` column already exists (043) — we just want a comment and an
-- index so admin queries that group attributions by surface are cheap.
-- Surfaces in v1:
--   'lykn-chat'             — in-LYKN chat (the existing hidden <applied> tag path)
--   'mcp:claude-desktop'    — Claude Desktop via MCP
--   'mcp:claude-code'       — Claude Code CLI via MCP
--   'mcp:cursor'            — Cursor via MCP
--   'mcp:other'             — any other MCP client
--   'rest:<client_kind>'    — REST mirror (e.g. ChatGPT custom GPT Action)
COMMENT ON COLUMN lykn_result_attributions.surface IS
  'Where the attribution came from. lykn-chat = in-LYKN model; mcp:<client> = MCP server; rest:<client_kind> = REST mirror. Nullable for legacy rows.';

CREATE INDEX IF NOT EXISTS idx_lykn_result_attributions_surface
  ON lykn_result_attributions (user_id, surface, created_at DESC)
  WHERE surface IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE lykn_mcp_tokens IS
  'Per-user, per-client bearer tokens for the LYKN MCP server + REST mirror. SHA-256 hashes only at rest.';
COMMENT ON COLUMN lykn_mcp_tokens.token_hash IS
  'SHA-256 hex of the plaintext token. Plaintext is shown once at creation and never persisted.';
COMMENT ON COLUMN lykn_mcp_tokens.client_kind IS
  'Coarse client identifier: claude-desktop | claude-code | cursor | chatgpt | other. Used for UX labels + per-client install snippets.';
COMMENT ON COLUMN lykn_mcp_tokens.scopes IS
  'Capability set. v1: [''read''] or [''read'', ''write'']. Read-only on free plan; write requires paid plan.';
