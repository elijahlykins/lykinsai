-- ============================================
-- Enforce NOT NULL on omnia_board_states.user_id
-- Migration: 021_board_states_user_id_not_null.sql
--
-- Ensures every board-state row has a user_id so
-- RLS policies (user_id = auth.uid()) never fail
-- due to NULL comparisons.
-- ============================================

-- Step 1: Re-run backfill for any rows still missing user_id
UPDATE omnia_board_states bs
SET user_id = ob.user_id
FROM omnia_boards ob
WHERE bs.board_id = ob.id
  AND bs.user_id IS NULL;

-- Step 2: Delete orphan rows that have no matching board (can't backfill)
DELETE FROM omnia_board_states
WHERE user_id IS NULL;

-- Step 3: Add NOT NULL constraint so this can't recur
ALTER TABLE omnia_board_states
  ALTER COLUMN user_id SET NOT NULL;
