-- ============================================
-- Admin Usage Dashboard: live (last N minutes) RPC
-- Migration: 042_admin_usage_live.sql
-- ============================================
-- Apply this AFTER 040_admin_usage_rpcs.sql.
--
-- Powers the "Live" section of the /admin/usage dashboard. Returns rich
-- last-N-minutes data in a single round-trip:
--   - totals (requests, spend, active users, guest requests)
--   - per_minute series (one row per minute, gap-filled to N minutes)
--   - by_action breakdown
--   - top_users (highest spend in window, with email)
--   - recent (last 50 rows in window, newest first, with email)
-- ============================================

CREATE OR REPLACE FUNCTION admin_usage_live(p_minutes int)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  result      jsonb;
  v_minutes   int := greatest(1, least(coalesce(p_minutes, 60), 360));
  v_since     timestamptz := now() - make_interval(mins => v_minutes);
BEGIN
  SELECT jsonb_build_object(
    'minutes', v_minutes,
    'since',   v_since,
    'now',     now(),
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
      WHERE created_at >= v_since
    ),
    'per_minute', (
      -- Gap-fill so the chart has a row per minute even when there's no
      -- activity. Uses a generate_series spine left-joined to bucketed logs.
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.minute ASC), '[]'::jsonb) FROM (
        SELECT
          spine.minute                     AS minute,
          coalesce(b.calls, 0)             AS calls,
          coalesce(b.cost_usd, 0)::numeric AS cost_usd,
          coalesce(b.tokens, 0)            AS tokens
        FROM (
          SELECT generate_series(
            date_trunc('minute', v_since),
            date_trunc('minute', now()),
            interval '1 minute'
          ) AS minute
        ) spine
        LEFT JOIN (
          SELECT
            date_trunc('minute', created_at) AS minute,
            count(*)                          AS calls,
            round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd,
            coalesce(sum(total_tokens), 0)    AS tokens
          FROM ai_usage_logs
          WHERE created_at >= v_since
          GROUP BY date_trunc('minute', created_at)
        ) b ON b.minute = spine.minute
      ) t
    ),
    'by_action', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.cost_usd DESC), '[]'::jsonb) FROM (
        SELECT
          coalesce(action_type, 'unknown') AS action_type,
          count(*)                          AS calls,
          coalesce(sum(total_tokens), 0)    AS tokens,
          round(coalesce(sum(cost_usd), 0)::numeric, 6) AS cost_usd
        FROM ai_usage_logs
        WHERE created_at >= v_since
        GROUP BY action_type
      ) t
    ),
    'top_users', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.cost_usd DESC), '[]'::jsonb) FROM (
        SELECT
          l.user_id,
          coalesce(u.email, '(deleted user)') AS email,
          count(*)                              AS calls,
          coalesce(sum(l.total_tokens), 0)      AS tokens,
          round(coalesce(sum(l.cost_usd), 0)::numeric, 6) AS cost_usd,
          max(l.created_at)                     AS last_request
        FROM ai_usage_logs l
        LEFT JOIN auth.users u ON u.id = l.user_id
        WHERE l.created_at >= v_since AND l.user_id IS NOT NULL
        GROUP BY l.user_id, u.email
        ORDER BY sum(l.cost_usd) DESC NULLS LAST
        LIMIT 10
      ) t
    ),
    'recent', (
      SELECT coalesce(jsonb_agg(row_to_json(t) ORDER BY t.created_at DESC), '[]'::jsonb) FROM (
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
          l.credits_used
        FROM ai_usage_logs l
        LEFT JOIN auth.users u ON u.id = l.user_id
        WHERE l.created_at >= v_since
        ORDER BY l.created_at DESC
        LIMIT 50
      ) t
    )
  )
  INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION admin_usage_live(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_usage_live(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION admin_usage_live(int) TO service_role;
