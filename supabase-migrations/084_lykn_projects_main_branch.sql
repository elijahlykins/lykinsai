-- ============================================================================
-- 084 — Project hierarchy (main + branch) and user-only creation
-- ============================================================================
-- Projects are containers the USER creates in the synthesis layer (main
-- repos). Branches are optional child projects (exploratory threads) that
-- inherit context from a main. Any AI client may READ and UPDATE any
-- project via MCP, but only the user may CREATE projects.

ALTER TABLE lykn_projects
  ADD COLUMN IF NOT EXISTS parent_project_id UUID
    REFERENCES lykn_projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'user'
    CHECK (created_by IN ('user', 'agent'));

COMMENT ON COLUMN lykn_projects.parent_project_id IS
  'NULL = main/standalone project. Non-null = branch of that main (GitHub-style). Branches share the main''s namespace of work but hold their own working memory.';

COMMENT ON COLUMN lykn_projects.created_by IS
  'user = created in LYKN synthesis UI. agent = legacy AI-created row. New projects must be user-created only.';

-- Backfill: synthesis UI and explicit user paths → user; MCP/chat inference → agent
UPDATE lykn_projects
SET created_by = 'user'
WHERE created_by_client IN ('lykn-synthesis', 'user')
   OR created_by_client IS NULL;

UPDATE lykn_projects
SET created_by = 'agent'
WHERE created_by = 'user'
  AND created_by_client IS NOT NULL
  AND created_by_client NOT IN ('lykn-synthesis', 'user');

CREATE INDEX IF NOT EXISTS idx_lykn_projects_parent
  ON lykn_projects (user_id, parent_project_id)
  WHERE parent_project_id IS NOT NULL;
