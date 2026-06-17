-- 105_vault_why_column.sql
--
-- Phase 4 of the Vault Normalization Program.
--
-- Adds the single "why" field to every vault item: a short, free-text
-- (Unicode/UTF-8) note from the user about WHY they saved this item. This is
-- distinct from the existing `comments` jsonb thread (041_notes_comments_column)
-- which is a list of timestamped comment objects — `why` is one scalar string
-- the save flows capture up front and the AI surfaces as intent ("they saved
-- this because…").
--
-- The table is still named `notes` here; the rename to `vault_items` happens in
-- a later phase (Phase 5).
--
-- Idempotent: safe to run more than once.

ALTER TABLE public.notes ADD COLUMN IF NOT EXISTS why text;

COMMENT ON COLUMN public.notes.why IS
  'User''s reason for saving this vault item (the single "why" field). UTF-8 free text. Distinct from the comments jsonb thread. Phase 4 of Vault Normalization.';

NOTIFY pgrst, 'reload schema';
