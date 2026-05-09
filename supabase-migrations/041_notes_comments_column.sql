-- Add comments column to notes table for quick-note comment threads.
-- Stores an array of { id, text, created_at } objects per note. Mirrors
-- the existing per-attachment notes shape (attachments[idx].notes) but
-- lives on the row itself so it works for quick notes (which have no
-- attachment to attach to).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notes'
      AND column_name = 'comments'
  ) THEN
    ALTER TABLE public.notes
      ADD COLUMN comments jsonb NOT NULL DEFAULT '[]'::jsonb;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_notes_comments
  ON public.notes USING GIN (comments);
