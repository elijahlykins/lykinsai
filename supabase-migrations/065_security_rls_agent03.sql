-- ============================================================================
-- 065_security_rls_agent03.sql
-- ----------------------------------------------------------------------------
-- LYKN Security Plan — Agent 03 (Data & Database Security Architect).
-- Companion to SECURITY_REPORT_03.md.
--
-- This migration does five things, all idempotent:
--
--   A. OAuth provider tables → make service-role-only.
--      Drop the authenticated-role policies on `lykn_oauth_consents` and
--      `lykn_oauth_clients` so PostgREST + a logged-in user's JWT can no
--      longer read those tables. RLS stays on; with zero policies and no
--      service-role bypass through PostgREST, the server's `supabaseAdmin`
--      client is the only path. No frontend code reads these tables via the
--      anon client (verified by grep against `src/`). Flagged in
--      SECURITY_REPORT_02.md as the explicit Agent 03 deliverable.
--
--      Brief deliverable 2: "OAuth tables (must be service-role-only — no anon
--      read via PostgREST)". CIA: Confidentiality. Principle: LP, SbD, DiD.
--      Severity fixed: MEDIUM.
--
--   B. `lykn_mcp_tokens` → drop authenticated S/U/D, server-only.
--      The /api/v1/synthesis/tokens routes (GET/POST/DELETE) all use
--      `supabaseAdmin` server-side; the Connections UI never reads this
--      table via the anon client. Closing the PostgREST surface eliminates
--      the unnecessary exposure of `token_hash` / `token_prefix` even to
--      the token's owner.
--
--      CIA: Confidentiality. Principle: LP, DiD. Severity fixed: LOW.
--
--   C. UPDATE policies → make WITH CHECK explicit.
--      Postgres defaults UPDATE policies' WITH CHECK to mirror USING when
--      omitted. This is correct today, but the brief deliverable 2 wants
--      both clauses written out — so a future contributor reading the
--      policy understands that a row's `user_id` cannot be flipped to
--      another user mid-UPDATE. Pure defense-in-depth; zero behaviour
--      change for compliant queries.
--
--      CIA: Integrity. Principle: DiD, SbD. Severity fixed: LOW.
--
--   D. Lightweight audit trail for OAuth + MCP token tables.
--      A new `lykn_security_audit` table (RLS on, ZERO policies — service-
--      role-only by construction) plus pure-pl/pgsql triggers on
--      `lykn_oauth_authorization_codes`, `lykn_oauth_refresh_tokens`, and
--      `lykn_mcp_tokens` that record mint / consume / rotate / revoke
--      events. No plaintext secrets, no PKCE verifiers, no token hashes
--      — only opaque ids, owning user, client, and timestamps. Agent 06
--      can later ship these rows to a SIEM by polling the table.
--
--      CIA: Integrity, Availability. Principle: DiD, SbD. Severity: INFO →
--      addressed in-pass per brief deliverable 7.
--
-- Every change is wrapped in `DROP POLICY IF EXISTS` / `IF NOT EXISTS` /
-- `CREATE OR REPLACE` so the migration is safe to re-run.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- A. OAuth provider tables → service-role-only
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 050 created three authenticated-role policies on
-- lykn_oauth_consents (read / update / delete own consents) and one
-- authenticated-role SELECT policy on lykn_oauth_clients (read clients I
-- registered). The brief asks for these to be service-role-only. RLS stays
-- ENABLED on every table; dropping the policies means PostgREST denies all
-- non-service-role traffic by default.

DROP POLICY IF EXISTS "Users read own consents"    ON lykn_oauth_consents;
DROP POLICY IF EXISTS "Users update own consents"  ON lykn_oauth_consents;
DROP POLICY IF EXISTS "Users delete own consents"  ON lykn_oauth_consents;

DROP POLICY IF EXISTS "Admins read clients they registered" ON lykn_oauth_clients;

-- Belt-and-suspenders: re-assert RLS is on. CREATE TABLE in 050 already
-- enables it; this is a no-op when already enabled.
ALTER TABLE lykn_oauth_consents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE lykn_oauth_clients              ENABLE ROW LEVEL SECURITY;
ALTER TABLE lykn_oauth_authorization_codes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lykn_oauth_refresh_tokens       ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────────────────
-- B. lykn_mcp_tokens → drop authenticated policies, server-only
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 044 created authenticated-role read/update/delete policies as
-- "belt-and-suspenders" for a logged-in client listing its own tokens via
-- PostgREST. We never use that path — the /Connections UI calls server-
-- side routes that go through `supabaseAdmin`. Drop the policies so the
-- token table is server-only by default. RLS stays ON; INSERT was already
-- omitted by design (server is the only minter).

DROP POLICY IF EXISTS "Users read own mcp tokens"   ON lykn_mcp_tokens;
DROP POLICY IF EXISTS "Users update own mcp tokens" ON lykn_mcp_tokens;
DROP POLICY IF EXISTS "Users delete own mcp tokens" ON lykn_mcp_tokens;

ALTER TABLE lykn_mcp_tokens ENABLE ROW LEVEL SECURITY;


-- ─────────────────────────────────────────────────────────────────────────────
-- C. UPDATE policies → make WITH CHECK explicit on user-scoped tables
-- ─────────────────────────────────────────────────────────────────────────────
-- Pattern repeated below for every user-scoped UPDATE policy that currently
-- has USING-only. We DROP and re-CREATE so the policy is rebuilt with both
-- USING and WITH CHECK. Idempotent (DROP IF EXISTS + CREATE).
--
-- Tables already shipped with explicit WITH CHECK (skipped here, by design):
--   lykn_load_in_user_sections (054), lykn_user_preferences (060),
--   lykn_user_links (062), lykn_project_neurons (063),
--   omnia_shared_boards (FOR ALL, both clauses already present, 034).

DROP POLICY IF EXISTS "Users can update own notes" ON notes;
CREATE POLICY "Users can update own notes"
  ON notes FOR UPDATE
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own boards" ON omnia_boards;
CREATE POLICY "Users can update own boards"
  ON omnia_boards FOR UPDATE
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own board states" ON omnia_board_states;
CREATE POLICY "Users can update own board states"
  ON omnia_board_states FOR UPDATE
  USING       (user_id = auth.uid())
  WITH CHECK  (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own projects" ON omnia_projects;
CREATE POLICY "Users can update own projects"
  ON omnia_projects FOR UPDATE
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own sessions" ON sessions;
CREATE POLICY "Users can update own sessions"
  ON sessions FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own synthesis chunks" ON lykn_synthesis_chunks;
CREATE POLICY "Users update own synthesis chunks"
  ON lykn_synthesis_chunks FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own synthesis profile" ON lykn_user_synthesis_profile;
CREATE POLICY "Users update own synthesis profile"
  ON lykn_user_synthesis_profile FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "users update own rss feeds" ON rss_feeds;
CREATE POLICY "users update own rss feeds"
  ON rss_feeds FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "users update own connections" ON social_connections;
CREATE POLICY "users update own connections"
  ON social_connections FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own model facts" ON lykn_user_model_facts;
CREATE POLICY "Users update own model facts"
  ON lykn_user_model_facts FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own beliefs" ON lykn_beliefs;
CREATE POLICY "Users update own beliefs"
  ON lykn_beliefs FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own rules" ON lykn_rules;
CREATE POLICY "Users update own rules"
  ON lykn_rules FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own attributions" ON lykn_result_attributions;
CREATE POLICY "Users update own attributions"
  ON lykn_result_attributions FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own projects" ON lykn_projects;
CREATE POLICY "Users update own projects"
  ON lykn_projects FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own project state" ON lykn_project_state;
CREATE POLICY "Users update own project state"
  ON lykn_project_state FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own concepts" ON lykn_concepts;
CREATE POLICY "Users update own concepts"
  ON lykn_concepts FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own concept_notes" ON concept_notes;
CREATE POLICY "Users update own concept_notes"
  ON concept_notes FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own concept_facts" ON concept_facts;
CREATE POLICY "Users update own concept_facts"
  ON concept_facts FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own concept_beliefs" ON concept_beliefs;
CREATE POLICY "Users update own concept_beliefs"
  ON concept_beliefs FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own concept_chats" ON concept_chats;
CREATE POLICY "Users update own concept_chats"
  ON concept_chats FOR UPDATE
  TO authenticated
  USING       (auth.uid() = user_id)
  WITH CHECK  (auth.uid() = user_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- D. lykn_security_audit + triggers
-- ─────────────────────────────────────────────────────────────────────────────
-- Append-only audit log for high-value mutations on the OAuth provider
-- tables and the MCP token table. Service-role-only by construction: RLS
-- enabled, ZERO policies. PostgREST + anon key = denied. PostgREST + any
-- authenticated JWT = denied. The Express server (service role) is the
-- only writer (via triggers) and the only reader (via supabaseAdmin).
--
-- NO plaintext secrets are logged. NO PKCE code_verifiers. NO refresh
-- hashes. NO authorization-code plaintext. Only opaque row ids, owning
-- user_id, client_id, event_type, and timestamps — enough to reconstruct
-- "user X minted Y access tokens via client Z in the last hour" without
-- exposing anything that could be replayed.

CREATE TABLE IF NOT EXISTS lykn_security_audit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Free-form, lower_snake_case. v1 vocabulary:
  --   'oauth_code_minted'        — row inserted into lykn_oauth_authorization_codes
  --   'oauth_code_consumed'      — same row's consumed_at flipped from NULL
  --   'oauth_refresh_minted'     — row inserted into lykn_oauth_refresh_tokens
  --   'oauth_refresh_rotated'    — refresh row got a non-null replaced_by
  --   'mcp_token_minted'         — row inserted into lykn_mcp_tokens
  --   'mcp_token_status_changed' — lykn_mcp_tokens.status transitioned
  --                                 (active → revoked / active → expired).
  event_type   TEXT NOT NULL,

  -- Logical table the event happened on. Kept as TEXT so we don't need a
  -- migration when we extend coverage to e.g. social_connections later.
  target_table TEXT NOT NULL,

  -- The row id of the affected record. Stored as TEXT because the OAuth
  -- code/refresh tables use UUID PKs and lykn_mcp_tokens uses UUID PKs,
  -- but we want one column shape across event types.
  target_id    TEXT,

  -- Owning user (NULL only for events that genuinely have no user — e.g.
  -- a future DCR-client audit row). Soft FK to auth.users via UUID; no
  -- hard FK so a user deletion doesn't cascade-delete the audit history
  -- (auditors typically want to see "user X deleted their account at T").
  user_id      UUID,

  -- For OAuth-flow events; NULL for PAT mints. Reference to the OAuth
  -- client this event belongs to.
  client_id    TEXT,

  -- Free-form context. Examples:
  --   { "expires_at": "...", "scope": "..." }
  --   { "old_status": "active", "new_status": "revoked" }
  --   { "replaced_by_id": "..." }
  -- Never contains plaintext secrets or hashes.
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lykn_security_audit_occurred
  ON lykn_security_audit (occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_lykn_security_audit_user_event
  ON lykn_security_audit (user_id, event_type, occurred_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lykn_security_audit_event_type
  ON lykn_security_audit (event_type, occurred_at DESC);

ALTER TABLE lykn_security_audit ENABLE ROW LEVEL SECURITY;
-- ZERO policies on purpose. Service-role-only by construction. PostgREST
-- with anon OR authenticated will see "permission denied for table
-- lykn_security_audit". Only `supabaseAdmin` (service role) can read or
-- write. Triggers below run in the table-owner's context so they bypass
-- RLS regardless.

COMMENT ON TABLE lykn_security_audit IS
  'Append-only audit log for OAuth + MCP token mutations. Service-role-only (RLS on, zero policies). No plaintext secrets or hashes — only opaque ids and event metadata. Read via supabaseAdmin; write via the triggers in migration 065.';


-- D1. lykn_oauth_authorization_codes — mint + consume
CREATE OR REPLACE FUNCTION lykn_audit_oauth_authorization_codes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lykn_security_audit (
      event_type, target_table, target_id, user_id, client_id, metadata
    ) VALUES (
      'oauth_code_minted',
      'lykn_oauth_authorization_codes',
      NEW.id::TEXT,
      NEW.user_id,
      NEW.client_id,
      jsonb_build_object(
        'expires_at',  NEW.expires_at,
        'scope',       NEW.scope,
        'consent_id',  NEW.consent_id
      )
    );
  ELSIF TG_OP = 'UPDATE'
        AND OLD.consumed_at IS NULL
        AND NEW.consumed_at IS NOT NULL THEN
    INSERT INTO lykn_security_audit (
      event_type, target_table, target_id, user_id, client_id, metadata
    ) VALUES (
      'oauth_code_consumed',
      'lykn_oauth_authorization_codes',
      NEW.id::TEXT,
      NEW.user_id,
      NEW.client_id,
      jsonb_build_object(
        'consumed_at', NEW.consumed_at,
        'consent_id',  NEW.consent_id
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lykn_audit_oauth_authz_codes_ins
  ON lykn_oauth_authorization_codes;
CREATE TRIGGER lykn_audit_oauth_authz_codes_ins
  AFTER INSERT ON lykn_oauth_authorization_codes
  FOR EACH ROW EXECUTE FUNCTION lykn_audit_oauth_authorization_codes();

DROP TRIGGER IF EXISTS lykn_audit_oauth_authz_codes_upd
  ON lykn_oauth_authorization_codes;
CREATE TRIGGER lykn_audit_oauth_authz_codes_upd
  AFTER UPDATE OF consumed_at ON lykn_oauth_authorization_codes
  FOR EACH ROW EXECUTE FUNCTION lykn_audit_oauth_authorization_codes();


-- D2. lykn_oauth_refresh_tokens — mint + rotate
CREATE OR REPLACE FUNCTION lykn_audit_oauth_refresh_tokens()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lykn_security_audit (
      event_type, target_table, target_id, user_id, client_id, metadata
    ) VALUES (
      'oauth_refresh_minted',
      'lykn_oauth_refresh_tokens',
      NEW.id::TEXT,
      NEW.user_id,
      NEW.client_id,
      jsonb_build_object(
        'expires_at',      NEW.expires_at,
        'scope',           NEW.scope,
        'consent_id',      NEW.consent_id,
        'access_token_id', NEW.access_token_id
      )
    );
  ELSIF TG_OP = 'UPDATE'
        AND OLD.replaced_by IS DISTINCT FROM NEW.replaced_by
        AND NEW.replaced_by IS NOT NULL THEN
    INSERT INTO lykn_security_audit (
      event_type, target_table, target_id, user_id, client_id, metadata
    ) VALUES (
      'oauth_refresh_rotated',
      'lykn_oauth_refresh_tokens',
      NEW.id::TEXT,
      NEW.user_id,
      NEW.client_id,
      jsonb_build_object(
        'replaced_by_id', NEW.replaced_by,
        'consumed_at',    NEW.consumed_at
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lykn_audit_oauth_refresh_ins
  ON lykn_oauth_refresh_tokens;
CREATE TRIGGER lykn_audit_oauth_refresh_ins
  AFTER INSERT ON lykn_oauth_refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION lykn_audit_oauth_refresh_tokens();

DROP TRIGGER IF EXISTS lykn_audit_oauth_refresh_upd
  ON lykn_oauth_refresh_tokens;
CREATE TRIGGER lykn_audit_oauth_refresh_upd
  AFTER UPDATE OF replaced_by ON lykn_oauth_refresh_tokens
  FOR EACH ROW EXECUTE FUNCTION lykn_audit_oauth_refresh_tokens();


-- D3. lykn_mcp_tokens — mint + status change (revoke / expire)
CREATE OR REPLACE FUNCTION lykn_audit_mcp_tokens()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lykn_security_audit (
      event_type, target_table, target_id, user_id, client_id, metadata
    ) VALUES (
      'mcp_token_minted',
      'lykn_mcp_tokens',
      NEW.id::TEXT,
      NEW.user_id,
      NEW.oauth_client_id,
      jsonb_build_object(
        'client_kind',      NEW.client_kind,
        'scopes',           NEW.scopes,
        'oauth_consent_id', NEW.oauth_consent_id,
        'expires_at',       NEW.expires_at,
        'token_prefix',     NEW.token_prefix
      )
    );
  ELSIF TG_OP = 'UPDATE'
        AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO lykn_security_audit (
      event_type, target_table, target_id, user_id, client_id, metadata
    ) VALUES (
      'mcp_token_status_changed',
      'lykn_mcp_tokens',
      NEW.id::TEXT,
      NEW.user_id,
      NEW.oauth_client_id,
      jsonb_build_object(
        'old_status',  OLD.status,
        'new_status',  NEW.status,
        'revoked_at',  NEW.revoked_at
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lykn_audit_mcp_tokens_ins
  ON lykn_mcp_tokens;
CREATE TRIGGER lykn_audit_mcp_tokens_ins
  AFTER INSERT ON lykn_mcp_tokens
  FOR EACH ROW EXECUTE FUNCTION lykn_audit_mcp_tokens();

DROP TRIGGER IF EXISTS lykn_audit_mcp_tokens_upd
  ON lykn_mcp_tokens;
CREATE TRIGGER lykn_audit_mcp_tokens_upd
  AFTER UPDATE OF status ON lykn_mcp_tokens
  FOR EACH ROW EXECUTE FUNCTION lykn_audit_mcp_tokens();


-- ─────────────────────────────────────────────────────────────────────────────
-- End of migration 065.
-- ─────────────────────────────────────────────────────────────────────────────
