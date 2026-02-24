-- ============================================
-- Performance hardening for memory notes feed
-- Migration: 009_notes_user_updated_at_index.sql
-- ============================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notes'
      AND column_name = 'user_id'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notes'
      AND column_name = 'updated_at'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_notes_user_updated_at
      ON public.notes (user_id, updated_at DESC);
  END IF;
END
$$;

