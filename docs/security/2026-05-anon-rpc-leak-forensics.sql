-- ============================================================================
-- Forensics — anon-callable admin RPC info-disclosure (mig 068 / 069)
-- ============================================================================
--
-- IMPORTANT LIMITATION
-- --------------------
-- The exposed RPCs (admin_users_with_usage, admin_recent_activity,
-- admin_usage_overview, admin_user_drilldown, admin_usage_live, plus the
-- write-RPCs merge_concepts and rls_auto_enable) were callable by anyone
-- holding the anon JWT directly through Supabase's PostgREST endpoint.
-- That means:
--
--   • Calls did NOT pass through our Express server, so server logs
--     don't have them.
--   • Calls did NOT log a row to ai_usage_logs (that table only records
--     OUR AI provider calls; it isn't a generic RPC audit).
--   • Calls did NOT log a row to lykn_security_audit (that table is
--     scoped to OAuth + MCP token events; see migration 065 lines 263+).
--
-- The authoritative source for "did anyone hit these RPCs while exposed"
-- is the Supabase project's API request log:
--
--   Supabase Dashboard → Project → Logs → "API" (NOT "Postgres logs")
--   Filter:  path LIKE '/rest/v1/rpc/admin_%'
--                OR path LIKE '/rest/v1/rpc/merge_concepts'
--                OR path LIKE '/rest/v1/rpc/rls_auto_enable'
--                OR path LIKE '/rest/v1/v_usage%'
--                OR path LIKE '/rest/v1/v_top_users%'
--   Range:   migration 040 deploy date through migration 068 apply time
--
-- Also worth pulling: any 200 responses on those paths where the
-- `apikey` query param or `Authorization` header used the anon key
-- (look for the prefix that matches your VITE_SUPABASE_ANON_KEY).
-- The Supabase API log surfaces both ip address and user_agent, which
-- lets you tell automated scraping from the legitimate dashboard.
--
-- The queries below catch the SECOND-ORDER signals — anomalies in
-- application data that an exploit would have left behind. They are
-- complementary to the Dashboard log review, not a replacement for it.
--
-- USAGE
-- -----
-- Run each block independently in the Supabase SQL Editor with the
-- service-role context (the editor uses service role by default for
-- the project owner). Each block is annotated with the question it
-- answers and the threshold for "this is suspicious".
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. merge_concepts forensics
-- ----------------------------------------------------------------------------
-- merge_concepts(from_id, into_id) deletes the `from` concept and rewires
-- its concept_links to point at `into`. An attacker calling this from anon
-- would have either:
--
--   (a) Triggered an "auth.uid() IS NULL → no rows match" no-op (best case),
--       in which case the function returns 0 and nothing changed.
--   (b) Mutated rows if the function predates the auth.uid() guard or if
--       the guard has a bug.
--
-- Read migration 058 lines 355+ to confirm whether this function is
-- hard-scoped to auth.uid(). If yes, anon calls are safe no-ops — but
-- still worth a sanity check that no concept rows look orphaned.
-- ----------------------------------------------------------------------------

-- 1a. Concepts with no concept_links pointing at them (potentially
--     pre-merge state where the merge was interrupted or anon-called).
--     Adjust the time window to your exposure window.
SELECT
  c.id,
  c.user_id,
  c.title,
  c.created_at,
  c.last_touched_at,
  c.dismissed_at
FROM lykn_concepts c
LEFT JOIN lykn_concept_links cl ON cl.concept_id = c.id
WHERE cl.id IS NULL
  AND c.dismissed_at IS NULL
  AND c.created_at >= '2025-09-01'  -- ← migration 040 deploy date; adjust
ORDER BY c.created_at DESC
LIMIT 200;

-- 1b. concept_links pointing at a concept that no longer exists. If
--     merge_concepts was hijacked, the survivor concept could have been
--     deleted while links survived. This query should always return 0.
SELECT
  cl.id              AS link_id,
  cl.concept_id      AS dangling_concept_id,
  cl.target_kind,
  cl.target_id,
  cl.created_at
FROM lykn_concept_links cl
LEFT JOIN lykn_concepts c ON c.id = cl.concept_id
WHERE c.id IS NULL
ORDER BY cl.created_at DESC
LIMIT 200;

-- 1c. Concepts with an unusually high inbound-link count for their age.
--     A successful unauthorized merge would consolidate many links onto
--     a single survivor concept. Compare distributions before/after
--     the exposure window. The "since" date is the exposure window
--     start; tune to your project.
SELECT
  c.user_id,
  c.id              AS concept_id,
  c.title,
  count(cl.id)      AS inbound_links,
  c.created_at,
  max(cl.created_at) AS last_link_added
FROM lykn_concepts c
JOIN lykn_concept_links cl ON cl.concept_id = c.id
WHERE c.created_at >= '2025-09-01'  -- ← exposure window start
GROUP BY c.user_id, c.id, c.title, c.created_at
HAVING count(cl.id) > 50            -- ← tune. Most concepts have <10
ORDER BY inbound_links DESC
LIMIT 50;


-- ----------------------------------------------------------------------------
-- 2. rls_auto_enable forensics
-- ----------------------------------------------------------------------------
-- rls_auto_enable() was created out-of-band (Supabase advisor "auto-fix"
-- button). Its body iterates pg_class and runs ALTER TABLE ... ENABLE RLS
-- on any table that has RLS off. An anon attacker calling it could either:
--
--   (a) Be a no-op — every table that should have RLS on already does.
--   (b) Surface a previously-disabled-RLS table (which would reveal that
--       table's name in the function's return + system catalogs).
--
-- It does NOT disable RLS or alter policies. The threat is reconnaissance,
-- not data mutation. Verify the current state matches expectations:
-- ----------------------------------------------------------------------------

-- 2a. Every public-schema table and whether RLS is enabled. Anything
--     marked relrowsecurity=false is currently exposed to anon if the
--     anon role has SELECT on it (which it does by Supabase default
--     privileges on every new table — that's how this whole vuln class
--     works).
SELECT
  c.relname           AS table_name,
  c.relrowsecurity    AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY c.relrowsecurity ASC, c.relname ASC;

-- 2b. Tables with RLS enabled but ZERO policies. Service-role-only by
--     construction (this is the same pattern as lykn_security_audit).
--     Anything here is FINE — it's intentionally locked. Just lists
--     them so you can confirm the list matches your intent.
SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  count(p.polname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
GROUP BY c.relname, c.relrowsecurity
HAVING c.relrowsecurity = true
   AND count(p.polname) = 0
ORDER BY c.relname;


-- ----------------------------------------------------------------------------
-- 3. Admin-RPC read-only forensics
-- ----------------------------------------------------------------------------
-- The five admin_* RPCs are read-only — they leaked data but mutated
-- nothing. There is no DB-side artifact for "did anon read this", only
-- the Supabase API log (see header). What we CAN check is whether any
-- suspicious rows in ai_usage_logs were inserted in the exposure window
-- by guest sessions (rows with user_id IS NULL), since the exposure
-- window also contained migration 040's intentional guest-logging
-- feature. Ranks the top guest IPs / sessions by call volume so you
-- can spot scrapers vs. real anonymous web users.
-- ----------------------------------------------------------------------------

-- 3a. Top guest sessions by call count in the exposure window.
SELECT
  guest_session_id,
  count(*)                               AS calls,
  min(created_at)                        AS first_seen,
  max(created_at)                        AS last_seen,
  count(DISTINCT date_trunc('day', created_at)) AS distinct_days,
  round(extract(epoch FROM max(created_at) - min(created_at)) / 60, 1) AS span_minutes,
  array_agg(DISTINCT action_type)        AS action_types
FROM ai_usage_logs
WHERE user_id IS NULL
  AND created_at >= '2025-09-01'   -- ← exposure window start
GROUP BY guest_session_id
HAVING count(*) > 20                -- ← tune. Real guest traffic <5 calls
ORDER BY calls DESC
LIMIT 50;

-- 3b. Hourly histogram of guest activity. Sharp spikes outside business
--     hours suggest automated scraping. Compare to your real user
--     activity pattern.
SELECT
  date_trunc('hour', created_at) AS hour,
  count(*)                       AS guest_calls,
  count(DISTINCT guest_session_id) AS distinct_sessions
FROM ai_usage_logs
WHERE user_id IS NULL
  AND created_at >= '2025-09-01'   -- ← exposure window start
GROUP BY hour
ORDER BY hour DESC
LIMIT 200;


-- ----------------------------------------------------------------------------
-- 4. lykn_security_audit sanity (post-fix only)
-- ----------------------------------------------------------------------------
-- This won't surface admin-RPC abuse (those events aren't audited there).
-- It WILL surface OAuth / MCP token abuse, which is independent. Worth
-- running as a general "did anything else weird happen during the
-- exposure window" probe.
-- ----------------------------------------------------------------------------

-- 4a. Audit events grouped by type per day.
SELECT
  occurred_at::date AS day,
  event_type,
  count(*)          AS events,
  count(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS distinct_users
FROM lykn_security_audit
WHERE occurred_at >= '2025-09-01'   -- ← exposure window start
GROUP BY day, event_type
ORDER BY day DESC, events DESC;

-- 4b. Users who minted an unusually high number of OAuth codes /
--     refresh tokens. If anon-callable RPCs were one symptom of a
--     broader misconfiguration, this is where to spot the second one.
SELECT
  user_id,
  count(*) FILTER (WHERE event_type = 'oauth_code_minted')    AS codes_minted,
  count(*) FILTER (WHERE event_type = 'oauth_refresh_minted') AS refreshes_minted,
  count(*) FILTER (WHERE event_type = 'mcp_token_minted')     AS mcp_minted,
  min(occurred_at) AS first_event,
  max(occurred_at) AS last_event
FROM lykn_security_audit
WHERE occurred_at >= '2025-09-01'   -- ← exposure window start
  AND user_id IS NOT NULL
GROUP BY user_id
HAVING count(*) > 100               -- ← tune
ORDER BY count(*) DESC
LIMIT 50;
