-- ============================================
-- Optimize omnia_board_states performance
-- Migration: 015_optimize_board_states.sql
--
-- Fixes:
-- 1. Add composite index for the most common query pattern (board_id + created_at DESC)
-- 2. Add user_id column so RLS can avoid expensive JOIN to omnia_boards
-- 3. Backfill user_id from omnia_boards
-- 4. Replace expensive EXISTS-based RLS with direct user_id check
-- 5. One-time prune: keep only 5 most recent states per board
-- ============================================

-- Step 1: Add composite index for "latest state per board" queries
CREATE INDEX IF NOT EXISTS idx_board_states_board_created
  ON omnia_board_states (board_id, created_at DESC);

-- Step 2: Add user_id column (nullable first for backfill)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'omnia_board_states' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE omnia_board_states ADD COLUMN user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Step 3: Backfill user_id from omnia_boards
UPDATE omnia_board_states bs
SET user_id = ob.user_id
FROM omnia_boards ob
WHERE bs.board_id = ob.id
  AND bs.user_id IS NULL;

-- Step 4: Add index on user_id for RLS performance
CREATE INDEX IF NOT EXISTS idx_board_states_user_id
  ON omnia_board_states (user_id);

-- Step 5: Drop old expensive RLS policies and replace with direct user_id check
DO $$
BEGIN
  -- Drop existing policies if they exist
  DROP POLICY IF EXISTS "Users can view own board states" ON omnia_board_states;
  DROP POLICY IF EXISTS "Users can insert own board states" ON omnia_board_states;
  DROP POLICY IF EXISTS "Users can delete own board states" ON omnia_board_states;
END $$;

CREATE POLICY "Users can view own board states"
  ON omnia_board_states FOR SELECT USING (
    user_id = auth.uid()
  );

CREATE POLICY "Users can insert own board states"
  ON omnia_board_states FOR INSERT WITH CHECK (
    user_id = auth.uid()
  );

CREATE POLICY "Users can delete own board states"
  ON omnia_board_states FOR DELETE USING (
    user_id = auth.uid()
  );

-- Step 6: Prune old states — keep only 5 most recent per board
DELETE FROM omnia_board_states
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY created_at DESC) AS rn
    FROM omnia_board_states
  ) ranked
  WHERE rn > 5
);

-- Step 7: Add composite index on omnia_boards for common query pattern
CREATE INDEX IF NOT EXISTS idx_omnia_boards_user_updated
  ON omnia_boards (user_id, updated_at DESC);
