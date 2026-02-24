-- ============================================
-- Omnia Boards: Link to Projects
-- Migration: 004_omnia_boards_project.sql
-- ============================================

ALTER TABLE omnia_boards
ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES omnia_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_omnia_boards_project_id ON omnia_boards(project_id);
