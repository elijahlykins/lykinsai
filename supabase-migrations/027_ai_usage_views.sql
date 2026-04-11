-- ============================================
-- AI Usage Reporting Views (service-role only)
-- Migration: 027_ai_usage_views.sql
-- ============================================
-- These views sit on top of ai_usage_logs and are only readable
-- via the service_role key (Supabase dashboard / admin API).
-- Regular authenticated users cannot see cross-user data.

-- ---------------------------------------------------------------------------
-- 1. Per-user monthly rollup
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_usage_by_user_month AS
WITH totals AS (
  SELECT
    user_id,
    date_trunc('month', created_at) AS month,
    count(*)                             AS request_count,
    coalesce(sum(input_tokens), 0)       AS total_input_tokens,
    coalesce(sum(output_tokens), 0)      AS total_output_tokens,
    coalesce(sum(total_tokens), 0)       AS total_tokens,
    round(coalesce(sum(cost_usd), 0), 4) AS total_cost_usd,
    coalesce(sum(credits_used), 0)       AS total_credits
  FROM ai_usage_logs
  GROUP BY user_id, date_trunc('month', created_at)
),
per_provider AS (
  SELECT
    sub.user_id,
    sub.month,
    jsonb_object_agg(sub.prov, sub.prov_cost) AS cost_by_provider
  FROM (
    SELECT
      user_id,
      date_trunc('month', created_at) AS month,
      coalesce(provider, 'unknown')    AS prov,
      round(coalesce(sum(cost_usd), 0), 4) AS prov_cost
    FROM ai_usage_logs
    GROUP BY user_id, date_trunc('month', created_at), provider
  ) sub
  GROUP BY sub.user_id, sub.month
)
SELECT
  t.user_id,
  t.month::date        AS month,
  t.request_count,
  t.total_input_tokens,
  t.total_output_tokens,
  t.total_tokens,
  t.total_cost_usd,
  t.total_credits,
  pp.cost_by_provider
FROM totals t
LEFT JOIN per_provider pp USING (user_id, month)
ORDER BY t.month DESC, t.total_cost_usd DESC;

REVOKE ALL ON v_usage_by_user_month FROM PUBLIC;
REVOKE ALL ON v_usage_by_user_month FROM authenticated;

-- ---------------------------------------------------------------------------
-- 2. Per-model stats
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_usage_by_model AS
SELECT
  coalesce(model, 'unknown')             AS model,
  coalesce(provider, 'unknown')          AS provider,
  count(*)                               AS call_count,
  coalesce(sum(total_tokens), 0)         AS total_tokens,
  round(coalesce(avg(total_tokens), 0))  AS avg_tokens_per_call,
  round(coalesce(sum(cost_usd), 0), 4)   AS total_cost_usd,
  min(created_at)                        AS first_used,
  max(created_at)                        AS last_used
FROM ai_usage_logs
GROUP BY model, provider
ORDER BY total_cost_usd DESC;

REVOKE ALL ON v_usage_by_model FROM PUBLIC;
REVOKE ALL ON v_usage_by_model FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3. Per-action-type stats
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_usage_by_action AS
SELECT
  action_type,
  count(*)                               AS call_count,
  coalesce(sum(total_tokens), 0)         AS total_tokens,
  round(coalesce(sum(cost_usd), 0), 4)   AS total_cost_usd,
  coalesce(sum(credits_used), 0)         AS total_credits,
  round(coalesce(avg(cost_usd), 0), 6)   AS avg_cost_per_call,
  min(created_at)                        AS first_seen,
  max(created_at)                        AS last_seen
FROM ai_usage_logs
GROUP BY action_type
ORDER BY total_cost_usd DESC;

REVOKE ALL ON v_usage_by_action FROM PUBLIC;
REVOKE ALL ON v_usage_by_action FROM authenticated;

-- ---------------------------------------------------------------------------
-- 4. Daily time-series (for trend monitoring)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_usage_daily AS
SELECT
  created_at::date                       AS day,
  count(*)                               AS request_count,
  count(DISTINCT user_id)                AS active_users,
  coalesce(sum(total_tokens), 0)         AS total_tokens,
  round(coalesce(sum(cost_usd), 0), 4)   AS total_cost_usd,
  coalesce(sum(credits_used), 0)         AS total_credits
FROM ai_usage_logs
GROUP BY created_at::date
ORDER BY day DESC;

REVOKE ALL ON v_usage_daily FROM PUBLIC;
REVOKE ALL ON v_usage_daily FROM authenticated;

-- ---------------------------------------------------------------------------
-- 5. Top users by spend (current calendar month)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_top_users AS
SELECT
  user_id,
  count(*)                               AS request_count,
  coalesce(sum(total_tokens), 0)         AS total_tokens,
  round(coalesce(sum(cost_usd), 0), 4)   AS total_cost_usd,
  coalesce(sum(credits_used), 0)         AS total_credits,
  max(created_at)                        AS last_request
FROM ai_usage_logs
WHERE created_at >= date_trunc('month', now())
GROUP BY user_id
ORDER BY total_cost_usd DESC;

REVOKE ALL ON v_top_users FROM PUBLIC;
REVOKE ALL ON v_top_users FROM authenticated;
