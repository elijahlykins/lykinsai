-- ============================================================================
-- 051_lykn_mcp_tokens_open_write.sql
-- ----------------------------------------------------------------------------
-- Removes the read-only default that was silently capping every
-- OAuth-installed MCP client (Cursor, Claude.ai, ChatGPT, Windsurf,
-- JetBrains, Replit, Lovable, …) at lykn:read.
--
-- ROOT CAUSE: oauth-server.js DCR (/oauth/register) defaulted the
-- registered `scope` to 'lykn:read offline_access' when the client
-- didn't explicitly request lykn:write. None of the MCP clients above
-- pass a `scope` field in their DCR body — they don't know LYKN's
-- custom scope vocabulary. So every freshly OAuth-installed client got
-- a client-level scope cap of read-only, which then propagated:
--
--   lykn_oauth_clients.scope        ('lykn:read offline_access')
--     → lykn_oauth_consents.scopes  (intersected → ['lykn:read'])
--       → lykn_oauth_authorization_codes.scope
--         → lykn_oauth_refresh_tokens.scope
--           → lykn_mcp_tokens.scopes (['read'])
--
-- The code fix (oauth-server.js) flips the DCR default to the full set
-- (lykn:read + lykn:write + offline_access). This migration backfills
-- the cap on every existing row up the chain so users don't have to
-- re-OAuth from each client.
--
-- We also (separately, simpler) flip the lykn_mcp_tokens.scopes default
-- to ['read','write'] and backfill any active read-only token mint —
-- that handles both PAT mints and the legacy plan-gated path that had
-- the same effect on the PAT side.
--
-- All updates are idempotent: filtered to "row currently lacks write".
-- Re-running the migration affects zero rows the second time.
-- ============================================================================

-- ── 1. lykn_mcp_tokens — coarse internal scopes (['read','write']) ─────────
ALTER TABLE lykn_mcp_tokens
  ALTER COLUMN scopes SET DEFAULT ARRAY['read','write']::TEXT[];

COMMENT ON COLUMN lykn_mcp_tokens.scopes IS
  'Capability set. v1: ["read"] or ["read","write"]. Mints default to read+write on every plan; pass an explicit ["read"] only to issue a deliberately read-only token (e.g. for a third party you want to give look-only access).';

UPDATE lykn_mcp_tokens
SET scopes = ARRAY['read','write']::TEXT[]
WHERE status = 'active'
  AND NOT ('write' = ANY(scopes));

-- ── 2. lykn_oauth_clients — registered scope cap (text, space-joined) ─────
-- Append ' lykn:write' to any client whose registered scope doesn't
-- already include it. This is the source-of-truth cap that consents and
-- token mints get filtered against.
UPDATE lykn_oauth_clients
SET scope = TRIM(BOTH ' ' FROM (scope || ' lykn:write'))
WHERE status = 'active'
  AND POSITION('lykn:write' IN COALESCE(scope, '')) = 0;

-- ── 3. lykn_oauth_consents — granted scopes (text[]) ───────────────────────
-- Append 'lykn:write' to any live consent that doesn't have it. Adding
-- a scope to an existing consent without re-prompting is a deliberate
-- choice here: pushing context BACK to LYKN is the implicit promise of
-- "Connect this client to LYKN", and read-only was never what the user
-- thought they were granting. Future grants go through the normal
-- consent UI and will show the full scope set.
UPDATE lykn_oauth_consents
SET scopes = scopes || ARRAY['lykn:write']::TEXT[]
WHERE revoked_at IS NULL
  AND NOT ('lykn:write' = ANY(scopes));

-- ── 4. lykn_oauth_refresh_tokens — bound scope at refresh time (text) ──────
-- The refresh-token grant re-mints the access token using THIS scope
-- (not the consent's). If we don't backfill here, the next refresh
-- will silently demote the access token back to read-only.
UPDATE lykn_oauth_refresh_tokens
SET scope = TRIM(BOTH ' ' FROM (scope || ' lykn:write'))
WHERE consumed_at IS NULL
  AND replaced_by IS NULL
  AND POSITION('lykn:write' IN COALESCE(scope, '')) = 0;

-- ── 5. (no-op for authorization codes) ─────────────────────────────────────
-- lykn_oauth_authorization_codes are single-use and short-lived
-- (typically <60s). Any unconsumed code at migration time will either
-- be redeemed within that window (and the resulting access/refresh
-- token rows already get the correct scope from the new code path) or
-- expire. Backfilling them is not worth the surface area.
