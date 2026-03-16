-- ============================================
-- Enable Row Level Security on all tables
-- Migration: 014_enable_rls_all_tables.sql
--
-- Without RLS, anyone with the anon key can
-- read/write any user's data. This locks each
-- table down to the owning user.
-- ============================================

-- =====================
-- NOTES
-- =====================
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notes"
  ON notes FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notes"
  ON notes FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notes"
  ON notes FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own notes"
  ON notes FOR DELETE USING (auth.uid() = user_id);

-- =====================
-- OMNIA_BOARDS
-- =====================
ALTER TABLE omnia_boards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own boards"
  ON omnia_boards FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own boards"
  ON omnia_boards FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own boards"
  ON omnia_boards FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own boards"
  ON omnia_boards FOR DELETE USING (auth.uid() = user_id);

-- =====================
-- OMNIA_BOARD_STATES
-- (no user_id — access via board ownership)
-- =====================
ALTER TABLE omnia_board_states ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own board states"
  ON omnia_board_states FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM omnia_boards
      WHERE omnia_boards.id = omnia_board_states.board_id
      AND omnia_boards.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own board states"
  ON omnia_board_states FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM omnia_boards
      WHERE omnia_boards.id = omnia_board_states.board_id
      AND omnia_boards.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete own board states"
  ON omnia_board_states FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM omnia_boards
      WHERE omnia_boards.id = omnia_board_states.board_id
      AND omnia_boards.user_id = auth.uid()
    )
  );

-- =====================
-- OMNIA_PROJECTS
-- =====================
ALTER TABLE omnia_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own projects"
  ON omnia_projects FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own projects"
  ON omnia_projects FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects"
  ON omnia_projects FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects"
  ON omnia_projects FOR DELETE USING (auth.uid() = user_id);

