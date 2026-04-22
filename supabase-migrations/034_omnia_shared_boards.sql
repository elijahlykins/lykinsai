-- ============================================
-- Omnia Shared Boards (Tier 0: view-only share links)
-- Migration: 034_omnia_shared_boards.sql
--
-- A share is an opaque URL-safe token that grants
-- unauthenticated read access to a single board and
-- its latest state snapshot. Owners can revoke or
-- set an optional expiry. Media files stored in
-- Supabase Storage still require owner-signed URLs,
-- so images may not render for anon viewers in v1.
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS omnia_shared_boards (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token          TEXT UNIQUE NOT NULL,
  board_id       UUID NOT NULL REFERENCES omnia_boards(id) ON DELETE CASCADE,
  owner_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMP WITH TIME ZONE,
  expires_at     TIMESTAMP WITH TIME ZONE,
  view_count     INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_omnia_shared_boards_token    ON omnia_shared_boards(token);
CREATE INDEX IF NOT EXISTS idx_omnia_shared_boards_board    ON omnia_shared_boards(board_id);
CREATE INDEX IF NOT EXISTS idx_omnia_shared_boards_owner    ON omnia_shared_boards(owner_id);

-- ============================================
-- RLS
-- ============================================
ALTER TABLE omnia_shared_boards ENABLE ROW LEVEL SECURITY;

-- All CREATE POLICY statements below are wrapped in DROP IF EXISTS / CREATE
-- so this migration is safely re-runnable.

-- Owners manage their own shares.
DROP POLICY IF EXISTS "Owners manage own shares" ON omnia_shared_boards;
CREATE POLICY "Owners manage own shares"
  ON omnia_shared_boards FOR ALL
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- Anyone (anon + authed) may resolve a token → board_id, but ONLY when the
-- share is still active. The token itself is the unguessable secret.
DROP POLICY IF EXISTS "Public can resolve active share tokens" ON omnia_shared_boards;
CREATE POLICY "Public can resolve active share tokens"
  ON omnia_shared_boards FOR SELECT
  USING (
    revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > NOW())
  );

-- ============================================
-- Open up read access to the shared board's data
-- (additive — does NOT loosen the existing "owner
-- can view own boards" policies; it just adds a
-- second path that's gated by a live share row.)
-- ============================================

DROP POLICY IF EXISTS "Public can read boards with an active share" ON omnia_boards;
CREATE POLICY "Public can read boards with an active share"
  ON omnia_boards FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM omnia_shared_boards sb
      WHERE sb.board_id = omnia_boards.id
        AND sb.revoked_at IS NULL
        AND (sb.expires_at IS NULL OR sb.expires_at > NOW())
    )
  );

DROP POLICY IF EXISTS "Public can read board states with an active share" ON omnia_board_states;
CREATE POLICY "Public can read board states with an active share"
  ON omnia_board_states FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM omnia_shared_boards sb
      WHERE sb.board_id = omnia_board_states.board_id
        AND sb.revoked_at IS NULL
        AND (sb.expires_at IS NULL OR sb.expires_at > NOW())
    )
  );

-- ============================================
-- View counter — incrementing via an RPC avoids
-- requiring anon UPDATE permission on the table.
-- ============================================
CREATE OR REPLACE FUNCTION omnia_shared_board_record_view(p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE omnia_shared_boards
     SET view_count     = view_count + 1,
         last_viewed_at = NOW()
   WHERE token          = p_token
     AND revoked_at     IS NULL
     AND (expires_at IS NULL OR expires_at > NOW());
END;
$$;

REVOKE ALL ON FUNCTION omnia_shared_board_record_view(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION omnia_shared_board_record_view(TEXT) TO anon, authenticated;
