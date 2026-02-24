-- ============================================
-- Omnia Boards: Default Title
-- Migration: 005_omnia_boards_default_title.sql
-- ============================================

ALTER TABLE omnia_boards
ALTER COLUMN title SET DEFAULT 'New Board';
