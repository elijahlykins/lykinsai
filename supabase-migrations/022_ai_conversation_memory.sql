-- ============================================
-- AI Conversation Memory
-- Migration: 022_ai_conversation_memory.sql
-- ============================================
-- Persistent cross-surface conversation memory so the AI
-- recalls previous exchanges regardless of which grid,
-- project, or vault the user is currently on.

CREATE TABLE IF NOT EXISTS ai_conversation_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Where this exchange happened
  surface TEXT NOT NULL CHECK (surface IN ('grid', 'project', 'vault')),
  surface_id TEXT,            -- board_id or project_id (nullable for vault)
  surface_title TEXT,         -- human-readable label for context

  -- The exchange
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,

  -- Compact summary generated later for older rows (token-saving)
  summary TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE ai_conversation_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own memory"
  ON ai_conversation_memory FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own memory"
  ON ai_conversation_memory FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own memory"
  ON ai_conversation_memory FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Fast lookup: recent memory for a user
CREATE INDEX idx_ai_memory_user_recent
  ON ai_conversation_memory (user_id, created_at DESC);

-- Fast lookup: memory scoped to a specific surface
CREATE INDEX idx_ai_memory_surface
  ON ai_conversation_memory (user_id, surface, surface_id, created_at DESC);
