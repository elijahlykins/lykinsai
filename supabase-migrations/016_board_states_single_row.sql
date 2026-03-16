-- ============================================
-- Board states: single row per board (UPSERT)
-- Migration: 016_board_states_single_row.sql
--
-- 1. Prune all but the latest state per board
-- 2. Add UNIQUE constraint on board_id
-- 3. Add updated_at column for tracking
-- ============================================

-- Step 1: Keep only the most recent state per board
DELETE FROM omnia_board_states
WHERE id NOT IN (
  SELECT DISTINCT ON (board_id) id
  FROM omnia_board_states
  ORDER BY board_id, created_at DESC
);

-- Step 2: Add updated_at column if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'omnia_board_states' AND column_name = 'updated_at'
  ) THEN
    ALTER TABLE omnia_board_states
      ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $$;

-- Step 3: Add unique constraint on board_id so upsert works
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'omnia_board_states_board_id_unique'
  ) THEN
    ALTER TABLE omnia_board_states
      ADD CONSTRAINT omnia_board_states_board_id_unique UNIQUE (board_id);
  END IF;
END $$;
