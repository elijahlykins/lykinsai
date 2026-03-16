-- ============================================
-- Prune historical omnia_board_states rows (BATCHED)
-- Migration: 010_prune_old_board_states.sql
--
-- Run each batch separately in the SQL Editor.
-- Keep running Batch 2 until it reports 0 rows deleted.
-- ============================================

-- =========== BATCH 1: Check the damage ===========
-- Run this first to see how big the table is:

SELECT
  count(*) AS total_rows,
  pg_size_pretty(pg_total_relation_size('omnia_board_states')) AS table_size
FROM omnia_board_states;


-- =========== BATCH 2: Delete 500 old rows at a time ===========
-- Run this REPEATEDLY until it says "0 rows affected".
-- Each run only deletes 500 rows so it won't time out.

DELETE FROM omnia_board_states
WHERE id IN (
  SELECT id FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (PARTITION BY board_id ORDER BY created_at DESC) AS rn
    FROM omnia_board_states
  ) ranked
  WHERE rn > 5
  LIMIT 500
);


-- =========== BATCH 3: After all old rows are gone ===========
-- Run this once at the end to reclaim disk space:

-- VACUUM omnia_board_states;
