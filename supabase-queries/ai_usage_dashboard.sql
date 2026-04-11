-- ============================================
-- LYKN AI Usage Dashboard
-- Paste this entire block into Supabase SQL Editor and hit Run.
-- ============================================

-- 1. TOTAL SPEND SUMMARY (all-time)
SELECT
  '💰 TOTAL SPEND' AS report,
  count(*)::text AS total_requests,
  sum(total_tokens)::text AS total_tokens,
  '$' || round(sum(cost_usd)::numeric, 4)::text AS total_cost_usd,
  sum(credits_used)::text AS total_credits
FROM ai_usage_logs;

-- 2. SPEND BY PROVIDER (all-time)
SELECT
  coalesce(provider, 'unknown') AS provider,
  count(*) AS calls,
  sum(total_tokens) AS tokens,
  round(sum(cost_usd)::numeric, 4) AS cost_usd,
  round(avg(cost_usd)::numeric, 6) AS avg_cost_per_call
FROM ai_usage_logs
GROUP BY provider
ORDER BY cost_usd DESC;

-- 3. SPEND BY MODEL (most expensive first)
SELECT * FROM v_usage_by_model;

-- 4. SPEND BY ACTION TYPE (chat, image gen, TTS, transcription, etc.)
SELECT * FROM v_usage_by_action;

-- 5. DAILY SPEND (last 30 days)
SELECT * FROM v_usage_daily WHERE day >= now() - interval '30 days';

-- 6. TOP USERS THIS MONTH
SELECT
  t.user_id,
  coalesce(u.email, 'unknown') AS email,
  t.request_count,
  t.total_tokens,
  t.total_cost_usd,
  t.total_credits,
  t.last_request
FROM v_top_users t
LEFT JOIN auth.users u ON u.id = t.user_id
ORDER BY t.total_cost_usd DESC;

-- 7. PER-USER MONTHLY ROLLUP (with email + provider breakdown)
SELECT
  m.user_id,
  coalesce(u.email, 'unknown') AS email,
  m.month,
  m.request_count,
  m.total_tokens,
  m.total_cost_usd,
  m.total_credits,
  m.cost_by_provider
FROM v_usage_by_user_month m
LEFT JOIN auth.users u ON u.id = m.user_id
ORDER BY m.month DESC, m.total_cost_usd DESC;

-- 8. MOST EXPENSIVE INDIVIDUAL REQUESTS (top 25)
SELECT
  l.created_at,
  coalesce(u.email, 'unknown') AS email,
  l.action_type,
  l.model,
  l.provider,
  l.input_tokens,
  l.output_tokens,
  l.total_tokens,
  round(l.cost_usd::numeric, 6) AS cost_usd,
  l.metadata
FROM ai_usage_logs l
LEFT JOIN auth.users u ON u.id = l.user_id
ORDER BY l.cost_usd DESC
LIMIT 25;

-- 9. CACHE HIT STATS (description cache)
SELECT
  'Description Cache' AS cache,
  count(*) AS cached_items,
  count(DISTINCT user_id) AS users_with_cache,
  min(created_at) AS oldest_entry,
  max(created_at) AS newest_entry
FROM ai_description_cache
UNION ALL
SELECT
  'Transcription Cache' AS cache,
  count(*) AS cached_items,
  count(DISTINCT user_id) AS users_with_cache,
  min(created_at) AS oldest_entry,
  max(created_at) AS newest_entry
FROM ai_transcription_cache;

-- 10. RECENT ACTIVITY (last 50 requests)
SELECT
  l.created_at,
  coalesce(u.email, 'unknown') AS email,
  l.action_type,
  l.model,
  l.total_tokens,
  round(l.cost_usd::numeric, 6) AS cost_usd
FROM ai_usage_logs l
LEFT JOIN auth.users u ON u.id = l.user_id
ORDER BY l.created_at DESC
LIMIT 50;
