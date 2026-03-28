-- Add tags column to notes table if it doesn't already exist.
-- Stores an array of user-defined tag strings per note.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notes'
      AND column_name = 'tags'
  ) THEN
    ALTER TABLE public.notes ADD COLUMN tags text[] DEFAULT '{}';
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_notes_tags ON public.notes USING GIN (tags);
