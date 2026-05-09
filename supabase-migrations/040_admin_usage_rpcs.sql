-- ============================================
-- Admin Usage Dashboard: schema tweaks + service-role RPCs
-- Migration: 040_admin_usage_rpcs.sql
-- ============================================
-- Apply this AFTER 027_ai_usage_views.sql.
--
-- 1. Allow guest (unauthenticated) AI calls to be logged. Guest rows have
--    user_id = NULL and a stable guest_session_id so they aggregate.
-- 2. Add an index that helps the per-action-type rollups the dashboard runs.
-- 3. Add SECURITY DEFINER RPCs the Express service-role calls so the
--    /admin/usage page can join ai_usage_logs to auth.users (different schema)
--    without granting the API role direct access to auth.users.
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Schema tweaks for guest logging
-- ---------------------------------------------------------------------------

ALTER TABLE ai_usage_logs ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE ai_usage_logs
  ADD COLUMN IF NOT EXISTS guest_session_id text;

CREATE INDEX IF NOT EXISTS idx_usage_logs_action_created
  ON ai_usage_logs (action_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_logs_guest_created
  ON ai_usage_logs (guest_session_id, created_at DESC)
  WHERE guest_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usage_logs_created
  ON ai_usage_logs (created_at DESC);

-- The existing 019 RLS insert policy requires auth.uid() = user_id which
-- blocks user_id IS NULL for authenticated callers. Service role already
-- bypasses RLS, so guest rows inserted server-side work fine. We do NOT
-- add a permissive policy for NULL user_id rows because we never want
-- authenticated end-users inserting null-user logs from the browser.

-- ---------------------------------------------------------------------------
-- 2. Admin RPCs (SECURITY DEFINER, service-role only)
-- ---------------------------------------------------------------------------
-- These run as the table owner (typically `postgres`) so they can read
-- auth.users from the public schema. EXECUTE is granted only to service_role.

-- ---- 2a. Per-user totals + email, since a given timestamp ----

CREATE OR REPLACE FUNCTION admin_users_with_usage(p_since timestamptz)
RETURNS TABLE (
  user_id          uuid,
  email            text,
  request_count    bigint,
  total_input_tokens  bigint,
  total_output_tokens bigint,
  total_tokens     bigint,
  total_cost_usd   numeric,
  total_credits    bigint,
  last_request     timestamptz,
  first_request    timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    l.user_id,
    coalesce(u.email, '(deleted user)') AS email,
    count(*)::bigint AS request_count,
    coalesce(sum(l.input_tokens), 0)::bigint  AS total_input_tokens,
    coalesce(sum(l.output_tokens), 0)::bigint AS total_output_tokens,
    coalesce(sum(l.total_tokens), 0)::bigint  AS total_tokens,
    round(coalesce(sum(l.cost_usd), 0)::numeric, 6) AS total_cost_usd,
    coalesce(sum(l.credits_used), 0)::bigint  AS total_credits,
    max(l.created_at) AS last_request,
    min(l.created_at) AS first_request
  FROM ai_usage_logs l
  LEFT JOIN auth.users u ON u.id = l.user_id
  WHERE l.created_at >= p_since
    AND l.user_id IS NOT NULL
  GROUP BY l.user_id, u.email
  ORDER BY total_cost_usd DESC;
$$;

REVOKE ALL ON FUNCTION admin_users_with_usage(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_users_with_usage(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_users_with_usage(timestamptz) TO service_role;

-- ---- 2b. Single-user drilldown (totals + breakdowns + recent rows) ----

CREATE OR REPLACE FUNCTION admin_user_drilldown(p_user uuid, p_since timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'user', (
      SELECT jsonb_build_object(
        'user_id', u.id,
        'email',   u.email,
        'created_at', u.created_at
      )
      FROM auth.users u WHERE u.id = p_user
    ),
    'totals', (
      SELECT jsonb_build_object(
        'request_count', count(*),
        'total_tokens',  coalesce(sum(total_tokens), 0),
        'total_input_tokens',  coalesce(sum(input_tokens), 0),
        'total_output_tokens', coalesce(sum(output_tokens), 0),
        'total_cost_usd', round(coalesce(sum(cost_usd), 0)::numeric, 6),
        'total_credits',  coalesce(sum(credits_used), 0),
        'first_request',  min(created_at),
        'last_request',   max(created_at)
      )
      FROM ai_usage_logs
      WHERE user_id = p_user AND created_at >= p_since
    ),
    'by_action', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.cost_usd DESC), '[]'::jsonb) FROM (
        SELECT
          coalesce(action_type, 'unknown') AS action_type,
          count(*)                          AS calls,
          coalesce(sum(total_tokens), 0)    AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd,
          coalesce(sum(credits_used), 0)    AS credits
        FROM ai_usage_logs
        WHERE user_id = p_user AND created_at >= p_since
        GROUP BY action_type
      ) t
    ),
    'by_model', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.cost_usd DESC), '[]'::jsonb) FROM (
        SELECT
          coalesce(model, 'unknown')    AS model,
          coalesce(provider, 'unknown') AS provider,
          count(*)                       AS calls,
          coalesce(sum(total_tokens), 0) AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd
        FROM ai_usage_logs
        WHERE user_id = p_user AND created_at >= p_since
        GROUP BY model, provider
      ) t
    ),
    'by_provider', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.cost_usd DESC), '[]'::jsonb) FROM (
        SELECT
          coalesce(provider, 'unknown') AS provider,
          count(*)                       AS calls,
          coalesce(sum(total_tokens), 0) AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd
        FROM ai_usage_logs
        WHERE user_id = p_user AND created_at >= p_since
        GROUP BY provider
      ) t
    ),
    'daily', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.day ASC), '[]'::jsonb) FROM (
        SELECT
          created_at::date AS day,
          count(*)         AS calls,
          coalesce(sum(total_tokens), 0) AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd
        FROM ai_usage_logs
        WHERE user_id = p_user AND created_at >= p_since
        GROUP BY created_at::date
      ) t
    ),
    'recent_logs', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::jsonb) FROM (
        SELECT
          id, created_at, action_type, model, provider,
          input_tokens, output_tokens, total_tokens,
          round(cost_usd::numeric, 6) AS cost_usd,
          credits_used, metadata
        FROM ai_usage_logs
        WHERE user_id = p_user AND created_at >= p_since
        ORDER BY created_at DESC
        LIMIT 100
      ) t
    )
  )
  INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION admin_user_drilldown(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_user_drilldown(uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_user_drilldown(uuid, timestamptz) TO service_role;

-- ---- 2c. Cross-user overview (totals, by action, by provider, daily) ----

CREATE OR REPLACE FUNCTION admin_usage_overview(p_since timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'totals', (
      SELECT jsonb_build_object(
        'request_count',  count(*),
        'active_users',   count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL),
        'guest_requests', count(*) FILTER (WHERE user_id IS NULL),
        'total_tokens',   coalesce(sum(total_tokens), 0),
        'total_cost_usd', round(coalesce(sum(cost_usd), 0)::numeric, 6),
        'total_credits',  coalesce(sum(credits_used), 0)
      )
      FROM ai_usage_logs
      WHERE created_at >= p_since
    ),
    'today', (
      SELECT jsonb_build_object(
        'request_count', count(*),
        'active_users',  count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL),
        'total_cost_usd', round(coalesce(sum(cost_usd), 0)::numeric, 6)
      )
      FROM ai_usage_logs
      WHERE created_at >= date_trunc('day', now())
    ),
    'all_time', (
      SELECT jsonb_build_object(
        'request_count',  count(*),
        'total_cost_usd', round(coalesce(sum(cost_usd), 0)::numeric, 6),
        'total_tokens',   coalesce(sum(total_tokens), 0)
      )
      FROM ai_usage_logs
    ),
    'by_action', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.cost_usd DESC), '[]'::jsonb) FROM (
        SELECT
          coalesce(action_type, 'unknown') AS action_type,
          count(*)                          AS calls,
          coalesce(sum(total_tokens), 0)    AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd,
          coalesce(sum(credits_used), 0)    AS credits
        FROM ai_usage_logs
        WHERE created_at >= p_since
        GROUP BY action_type
      ) t
    ),
    'by_provider', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.cost_usd DESC), '[]'::jsonb) FROM (
        SELECT
          coalesce(provider, 'unknown') AS provider,
          count(*)                       AS calls,
          coalesce(sum(total_tokens), 0) AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd
        FROM ai_usage_logs
        WHERE created_at >= p_since
        GROUP BY provider
      ) t
    ),
    'by_model', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.cost_usd DESC), '[]'::jsonb) FROM (
        SELECT
          coalesce(model, 'unknown')    AS model,
          coalesce(provider, 'unknown') AS provider,
          count(*)                       AS calls,
          coalesce(sum(total_tokens), 0) AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd
        FROM ai_usage_logs
        WHERE created_at >= p_since
        GROUP BY model, provider
        ORDER BY sum(cost_usd) DESC NULLS LAST
        LIMIT 25
      ) t
    ),
    'daily', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.day ASC), '[]'::jsonb) FROM (
        SELECT
          created_at::date  AS day,
          count(*)          AS calls,
          count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS active_users,
          coalesce(sum(total_tokens), 0) AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd
        FROM ai_usage_logs
        WHERE created_at >= p_since
        GROUP BY created_at::date
      ) t
    )
  )
  INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION admin_usage_overview(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_usage_overview(timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_usage_overview(timestamptz) TO service_role;

-- ---- 2d. Recent activity feed (joined to email) ----

CREATE OR REPLACE FUNCTION admin_recent_activity(p_limit int)
RETURNS TABLE (
  id              uuid,
  created_at      timestamptz,
  user_id         uuid,
  email           text,
  guest_session_id text,
  action_type     text,
  model           text,
  provider        text,
  input_tokens    integer,
  output_tokens   integer,
  total_tokens    integer,
  cost_usd        numeric,
  credits_used    integer,
  metadata        jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT
    l.id,
    l.created_at,
    l.user_id,
    coalesce(u.email, CASE WHEN l.user_id IS NULL THEN '(guest)' ELSE '(deleted user)' END) AS email,
    l.guest_session_id,
    l.action_type,
    l.model,
    l.provider,
    l.input_tokens,
    l.output_tokens,
    l.total_tokens,
    round(l.cost_usd::numeric, 6) AS cost_usd,
    l.credits_used,
    l.metadata
  FROM ai_usage_logs l
  LEFT JOIN auth.users u ON u.id = l.user_id
  ORDER BY l.created_at DESC
  LIMIT greatest(1, least(p_limit, 500));
$$;

REVOKE ALL ON FUNCTION admin_recent_activity(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_recent_activity(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_recent_activity(int) TO service_role;
