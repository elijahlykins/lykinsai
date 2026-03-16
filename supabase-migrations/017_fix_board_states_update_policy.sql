-- ============================================
-- Fix: omnia_board_states UPSERT requires UPDATE permission
-- Migration: 017_fix_board_states_update_policy.sql
--
-- The upsert in saveSnapshot uses ON CONFLICT (board_id) DO UPDATE,
-- which requires an UPDATE RLS policy. Migration 015 only created
-- SELECT, INSERT, and DELETE policies.
-- ============================================

DROP POLICY IF EXISTS "Users can update own board states" ON omnia_board_states;

CREATE POLICY "Users can update own board states"
  ON omnia_board_states FOR UPDATE USING (
    user_id = auth.uid()
  );
