-- ============================================
-- Usage Tracking: Sessions + AI Usage Logs
-- Migration: 019_usage_tracking.sql
-- ============================================

-- Sessions: tracks a user's activity window on a board
CREATE TABLE IF NOT EXISTS sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  board_id uuid REFERENCES omnia_boards(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  total_cost numeric(12,6) NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  total_credits integer NOT NULL DEFAULT 0
);

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own sessions"
  ON sessions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own sessions"
  ON sessions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own sessions"
  ON sessions FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX idx_sessions_user_active
  ON sessions (user_id, last_activity_at DESC)
  WHERE ended_at IS NULL;

CREATE INDEX idx_sessions_user_created
  ON sessions (user_id, started_at DESC);

-- AI Usage Logs: one row per AI action
CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action_type text NOT NULL,
  model text,
  provider text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  credits_used integer NOT NULL DEFAULT 0,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own usage logs"
  ON ai_usage_logs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own usage logs"
  ON ai_usage_logs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_usage_logs_user_created
  ON ai_usage_logs (user_id, created_at DESC);

CREATE INDEX idx_usage_logs_session
  ON ai_usage_logs (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX idx_usage_logs_user_action
  ON ai_usage_logs (user_id, action_type, created_at DESC);
