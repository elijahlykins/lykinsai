-- ============================================
-- Omnia Boards + Board States
-- Migration: 002_omnia_boards.sql
-- ============================================

-- Ensure UUID extension exists
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- BOARDS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS omnia_boards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled board',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- BOARD STATES (SNAPSHOTS)
-- ============================================
CREATE TABLE IF NOT EXISTS omnia_board_states (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  board_id UUID REFERENCES omnia_boards(id) ON DELETE CASCADE NOT NULL,
  state JSONB NOT NULL,
  version INTEGER DEFAULT 1,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_omnia_boards_user_id ON omnia_boards(user_id);
CREATE INDEX IF NOT EXISTS idx_omnia_board_states_board_id ON omnia_board_states(board_id);
