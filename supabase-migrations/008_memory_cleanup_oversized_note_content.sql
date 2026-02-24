-- ============================================
-- Memory cleanup: remove oversized inline blobs in notes.content
-- Migration: 008_memory_cleanup_oversized_note_content.sql
-- ============================================

-- Audit table for one-time cleanup visibility
CREATE TABLE IF NOT EXISTS memory_notes_cleanup_audit (
  id BIGSERIAL PRIMARY KEY,
  note_id TEXT NOT NULL,
  old_size INTEGER NOT NULL,
  new_size INTEGER NOT NULL,
  cleaned_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Replace large inline data URLs with a compact placeholder.
-- This keeps the note readable while removing payloads that can stall list loading.
WITH candidates AS (
  SELECT
    id::text AS note_id,
    content AS old_content,
    regexp_replace(
      content,
      'data:[^\\s\\]\\)\"'']+',
      '[BLOB_REMOVED]',
      'gi'
    ) AS new_content
  FROM notes
  WHERE content IS NOT NULL
    AND length(content) > 120000
    AND content ~* 'data:'
),
updates AS (
  UPDATE notes n
  SET content = c.new_content
  FROM candidates c
  WHERE n.id::text = c.note_id
  RETURNING
    c.note_id,
    length(c.old_content) AS old_size,
    length(c.new_content) AS new_size
)
INSERT INTO memory_notes_cleanup_audit (note_id, old_size, new_size)
SELECT note_id, old_size, new_size
FROM updates;

