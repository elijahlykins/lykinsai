-- ============================================
-- LYKN — middle tier "project state" (the AI's git-style working memory)
-- Migration: 045_lykn_projects.sql
-- ============================================
-- Three-tier synthesis layer:
--   • Core beliefs       → governance, slow, ratified  (lykn_beliefs)
--   • Project state      → THIS FILE, working memory   (lykn_project_state)
--   • Identity facts     → background, light-weight    (lykn_user_model_facts)
--
-- The middle tier solves a specific problem: when a user works on a project
-- across multiple AI clients (Claude Desktop on Tuesday, Cursor on
-- Wednesday, Claude Code on Thursday), each tool currently starts from
-- zero context. They re-explain "we're using Streamable HTTP MCP, no
-- SDK, here's what's done so far" every single time.
--
-- Project state is a per-user, per-project key/value store with replacement
-- semantics — newer pushes at the same `state_key` supersede older ones.
-- Think `git push` for working memory: each push is timestamped, attributed
-- to the client that made it (claude-desktop, cursor, lykn-chat, ...), and
-- the latest non-superseded value at each key forms the project's current
-- "state of the world."
--
-- Lifecycle:
--   • Inferred — Claude/Cursor calls `lykn_setActiveProject({ name, description })`
--     when it detects a topic shift; the user can rename later in LYKN.
--   • Auto-update — every meaningful decision becomes a push:
--       lykn_pushProjectState({ state_key: 'mcp_protocol',
--                               state_value: 'Streamable HTTP, hand-rolled' })
--   • Auto-include — `lykn_getContextBlock` injects the active project's
--     state alongside beliefs/rules, so even tools that don't call
--     getProjectState directly inherit the working context for free.
--   • Decay — non-active projects auto-archive after 30 days of no pushes
--     (handled by application code, not a trigger — easier to tune).
--
-- This sits NEXT to lykn_user_model_facts, not on top of it. Facts (kind=
-- 'focus') describe what someone is working on at an identity level
-- ("Building LYKN"); project state describes what's *true* about that
-- project right now ("MCP tools renamed to underscore namespace today"
-- via Cursor). Different lifecycle, different blast radius, different
-- table.

-- ---------------------------------------------------------------------------
-- 1. Projects (the named container)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Human-readable, free-form. AI-inferred at first ("LYKN MCP integration"),
  -- user can rename in the UI. Trimmed to 120 chars on insert by the tool.
  name TEXT NOT NULL,

  -- Lowercased, whitespace-collapsed `name` used for dedup. Two pushes at
  -- "LYKN MCP" and "lykn  mcp" should collide on the same project.
  name_key TEXT NOT NULL,

  -- Optional one-line description from the AI. Helps the user remember
  -- what this project is about when reviewing.
  description TEXT,

  -- 'active'   — the user is currently working on this; eligible for
  --              auto-inclusion in getContextBlock.
  -- 'archived' — completed or abandoned. Doesn't ship in context, but
  --              state history is preserved for retrospective queries.
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),

  -- The client that first inferred this project (claude-desktop, cursor,
  -- lykn-chat, claude-code, ...). Useful provenance signal in the UI.
  created_by_client TEXT,

  -- Bumped by every pushProjectState. Drives "most recent" sort order
  -- and the 30-day auto-archive heuristic.
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lykn_projects_unique_name_per_user UNIQUE (user_id, name_key)
);

CREATE INDEX IF NOT EXISTS idx_lykn_projects_user_active
  ON lykn_projects (user_id, status, last_active_at DESC);

ALTER TABLE lykn_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own projects"
  ON lykn_projects FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own projects"
  ON lykn_projects FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own projects"
  ON lykn_projects FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own projects"
  ON lykn_projects FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 2. Project state (the kv-store with supersession history)
-- ---------------------------------------------------------------------------
-- Every push appends a row. The latest non-superseded row at each
-- (user_id, project_id, state_key) is the current value. When a new value
-- arrives, the application code stamps `superseded_at` on the prior row
-- and inserts the new one. Audit trail is preserved (you can ask "what
-- did we say `tech_stack` was yesterday?") without making the read path
-- of the kv-store any slower.
--
-- We do NOT use ON CONFLICT here on purpose. Supersession is more useful
-- than overwrite for an AI working memory: if Claude says one thing on
-- Tuesday and Cursor pushes a contradictory thing on Wednesday, the user
-- can later see both AND who said which. UPSERT would lose that.
CREATE TABLE IF NOT EXISTS lykn_project_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES lykn_projects(id) ON DELETE CASCADE,

  -- Slug-shaped key. Examples:
  --   'tech_stack', 'current_blocker', 'next_milestone',
  --   'open_questions', 'design_decision_logging'
  -- The AI is expected to pick stable keys on its own and reuse them
  -- across pushes; the tool description coaches it to do so.
  state_key TEXT NOT NULL CHECK (length(state_key) BETWEEN 1 AND 80),

  -- The actual state. Free-form prose, capped to 2000 chars to stop
  -- runaway dumps. Long-form notes belong in the vault.
  state_value TEXT NOT NULL CHECK (length(state_value) <= 2000),

  -- Provenance: which AI client pushed this row?
  --   'claude-desktop' | 'cursor' | 'claude-code' | 'lykn-chat' | 'other'
  set_by_client TEXT,

  -- Optional anchor in the source conversation (host-provided id).
  -- Lets the UI render "set in conversation X" without parsing chat logs.
  set_in_message_id TEXT,

  -- Optional one-sentence justification. Helps the user understand why
  -- the AI thought this was worth recording. Capped at 320 chars.
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 320),

  -- NULL while this row is the current value. Stamped to `now()` by the
  -- application reconciler the moment a newer push arrives at the same
  -- (user_id, project_id, state_key). Indexed-WHERE NULL is the read
  -- path's hot index.
  superseded_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot path: latest current state for a project. Partial index on
-- "non-superseded rows only" keeps the index tiny relative to history.
CREATE INDEX IF NOT EXISTS idx_lykn_project_state_current
  ON lykn_project_state (user_id, project_id, state_key)
  WHERE superseded_at IS NULL;

-- Audit/history queries.
CREATE INDEX IF NOT EXISTS idx_lykn_project_state_history
  ON lykn_project_state (user_id, project_id, state_key, created_at DESC);

ALTER TABLE lykn_project_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own project state"
  ON lykn_project_state FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own project state"
  ON lykn_project_state FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own project state"
  ON lykn_project_state FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users delete own project state"
  ON lykn_project_state FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. Wire active project onto the synthesis profile
-- ---------------------------------------------------------------------------
-- Single source of truth for "what project is the user currently in?"
-- Lives on the existing profile row. Nullable — most users won't have an
-- active project at first; we don't want to force creation. ON DELETE SET
-- NULL because we never want a profile-row delete to cascade from project
-- deletion (project cascade should NOT take the profile with it).
ALTER TABLE lykn_user_synthesis_profile
  ADD COLUMN IF NOT EXISTS active_project_id UUID
    REFERENCES lykn_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lykn_profile_active_project
  ON lykn_user_synthesis_profile (active_project_id)
  WHERE active_project_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------
COMMENT ON TABLE lykn_projects IS
  'Middle-tier synthesis container. Each project groups working state that AI clients push as decisions accumulate; auto-inferred by Claude/Cursor on topic shift, renameable by the user.';
COMMENT ON TABLE lykn_project_state IS
  'Append-only kv-store with supersession. Latest non-superseded row at (user_id, project_id, state_key) is the current value; older rows preserved for audit.';
COMMENT ON COLUMN lykn_projects.name_key IS
  'Lowercase + whitespace-collapsed name; collisions reuse the existing project.';
COMMENT ON COLUMN lykn_project_state.superseded_at IS
  'Stamped by the application reconciler when a newer push arrives at the same (user_id, project_id, state_key). NULL = currently authoritative.';
COMMENT ON COLUMN lykn_user_synthesis_profile.active_project_id IS
  'The project context that lykn_getContextBlock injects into outside-AI prompts. Auto-set by lykn_setActiveProject.';
