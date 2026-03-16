-- ============================================
-- Drop unused tables, functions, triggers, and extensions
-- Migration: 011_drop_unused_tables.sql
--
-- These objects were part of the file storage + AI workspace
-- system (migration 001) that was never integrated into the app.
-- ============================================

-- Step 1: Drop triggers (must happen before dropping functions)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP TRIGGER IF EXISTS update_workspaces_updated_at ON workspaces;
DROP TRIGGER IF EXISTS update_folders_updated_at ON folders;
DROP TRIGGER IF EXISTS update_files_updated_at ON files;

-- Step 2: Drop functions
DROP FUNCTION IF EXISTS create_workspace_for_user();
DROP FUNCTION IF EXISTS get_user_workspace();
DROP FUNCTION IF EXISTS search_files_by_embedding(vector(1536), float, int, UUID);

-- Step 3: Drop tables (child tables first to respect FK constraints)
DROP TABLE IF EXISTS file_embeddings CASCADE;
DROP TABLE IF EXISTS chat_queries CASCADE;
DROP TABLE IF EXISTS files CASCADE;
DROP TABLE IF EXISTS folders CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;
DROP TABLE IF EXISTS memory_notes_cleanup_audit CASCADE;

-- Step 4: Drop pgvector extension (only used by file_embeddings)
DROP EXTENSION IF EXISTS vector;

-- Note: update_updated_at_column() is kept — it's generic and reusable.
-- Note: uuid-ossp extension is kept — used by all remaining tables.
