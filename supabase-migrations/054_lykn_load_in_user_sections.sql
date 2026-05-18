-- ============================================
-- LYKN load-in greeting — user-authored sections
-- Migration: 054_lykn_load_in_user_sections.sql
-- ============================================
-- Lets a user add their own sections to the daily load-in briefing
-- alongside the auto-built lanes (calendar, productivity, health,
-- approvals, project updates, etc.). Typical use cases:
--
--   • "Today's focus" — a one-paragraph reminder the user wants
--     re-surfaced every time they open the app.
--   • "Mantras" — a list of daily principles the user wants pinned to
--     the top of every briefing.
--   • "Open loops" — todo-ish bullets they want to see until they're
--     ready to action / delete them.
--
-- Each row is one section. The briefing renderer fetches every row
-- for the current user (ordered by sort_order, then created_at) and
-- appends them to the structured `sections` array right before the
-- "Connect the rest" fallback. The user manages the list via the
-- inline editor at the bottom of the load-in greeting bubble.
--
-- Schema choices:
--   • `body` is markdown so the user can paste bullets / links / etc.
--     We render it through the same ReactMarkdown pipeline the rest
--     of the chat uses.
--   • `sort_order` is an int so we can reorder via drag-and-drop later
--     without renumbering every row (gap-friendly default of 1000).
--   • No `pinned` column — sort_order = 0 already pins to the top.
--   • RLS: strictly user-scoped. Service role bypasses (lykn server-
--     side jobs may want to seed a "welcome to LYKN" first section).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS lykn_load_in_user_sections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  heading     TEXT NOT NULL CHECK (char_length(heading) BETWEEN 1 AND 120),
  body        TEXT NOT NULL DEFAULT '' CHECK (char_length(body) <= 4000),
  sort_order  INTEGER NOT NULL DEFAULT 1000,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One index per common access pattern. The chat surface always reads
-- "every row for the current user, ordered by sort_order then
-- created_at", so a composite index covers both the WHERE and the
-- ORDER BY in one shot.
CREATE INDEX IF NOT EXISTS lykn_load_in_user_sections_user_sort_idx
  ON lykn_load_in_user_sections (user_id, sort_order ASC, created_at ASC);

-- Keep updated_at honest without relying on the client to send it.
CREATE OR REPLACE FUNCTION lykn_load_in_user_sections_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lykn_load_in_user_sections_touch_updated_at_trg
  ON lykn_load_in_user_sections;
CREATE TRIGGER lykn_load_in_user_sections_touch_updated_at_trg
  BEFORE UPDATE ON lykn_load_in_user_sections
  FOR EACH ROW
  EXECUTE FUNCTION lykn_load_in_user_sections_touch_updated_at();

ALTER TABLE lykn_load_in_user_sections ENABLE ROW LEVEL SECURITY;

-- Strict per-user policies. Service role bypasses RLS automatically;
-- no need to grant it explicit policies.
CREATE POLICY lykn_load_in_user_sections_select_own
  ON lykn_load_in_user_sections
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY lykn_load_in_user_sections_insert_own
  ON lykn_load_in_user_sections
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY lykn_load_in_user_sections_update_own
  ON lykn_load_in_user_sections
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY lykn_load_in_user_sections_delete_own
  ON lykn_load_in_user_sections
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

COMMENT ON TABLE lykn_load_in_user_sections IS
  'User-authored sections appended to the daily load-in briefing. One row per section, markdown body, per-user RLS.';
