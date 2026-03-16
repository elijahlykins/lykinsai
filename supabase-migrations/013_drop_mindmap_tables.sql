-- ============================================
-- Drop unused mindmap tables
-- Migration: 013_drop_mindmap_tables.sql
--
-- The mindmap feature was replaced by the Connections view.
-- These tables are no longer referenced in the codebase.
-- ============================================

DROP TABLE IF EXISTS omnia_mindmap_links CASCADE;
DROP TABLE IF EXISTS omnia_mindmap_nodes CASCADE;
DROP TABLE IF EXISTS omnia_project_mindmaps CASCADE;
