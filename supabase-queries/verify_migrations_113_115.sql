-- Verification companion for supabase-migrations/113, 114, 115.
-- All statements are read-only SELECTs — safe to run against production
-- at any time (SQL editor as service role / postgres).
--
-- ── PRE-APPLY AUDIT (run 2026-07-16 against live project yxntfqgbkxjiyesewyoz) ──
--
-- 113 (account deletion cascade):
--   * 59 of the 62 targeted (table, column) pairs ALREADY carry an FK to
--     auth.users — a previous partial application. The DO block's
--     idempotency guard skips them; only three tables will be touched:
--         vault_items          (924 rows)
--         lykn_chat_states     (837 rows)
--         lykn_security_audit  (7,160 rows)
--   * Orphan counts on those three tables: 0 / 0 / 0, and 0 NULL user_ids —
--     the "destructive pre-step" purge deletes NOTHING as of the audit date.
--     (Re-run section A below just before applying; orphans can appear if an
--     account is deleted between audit and apply.)
--   * `notes` and `sessions` resolve to VIEWS (relkind 'v') — correctly
--     skipped by the relkind = 'r' guard.
--   * The only inbound FK into the three tables is
--     concept_notes.note_id → vault_items, already ON DELETE CASCADE, so
--     neither the orphan purge nor the auth.users cascade chain can be
--     blocked by a restricting child.
--   * Lock impact: ADD CONSTRAINT takes ACCESS EXCLUSIVE on each table for
--     the validation scan; at ≤7,160 rows per table this is milliseconds.
--     No NOT VALID / VALIDATE two-step needed.
--
-- 114 (lykn_apple_tokens): table does not exist in production (SQLSTATE
--   42P01 confirmed). Schema matches server.js exactly — upsert of
--   { user_id, refresh_token, updated_at } with onConflict: 'user_id'
--   (user_id is the PK), and the delete path selects refresh_token by
--   user_id. RLS-on/no-policies is correct: only the service role touches
--   this table.
--
-- 115 (lykn_client_metrics): table does not exist in production. Schema
--   matches server.js POST /api/metrics/ingest — insert of
--   { user_id, payload } with identity PK and received_at default.
--
-- Verdict: 113/114/115 apply cleanly to production as-is, in order.
-- Take a backup first regardless (113's purge is conditional-destructive).

-- ═══════════════════════════════════════════════════════════════════════
-- A. PRE-APPLY: re-check orphans on the three tables 113 will alter.
--    Expect orphans = 0 everywhere. Any non-zero rows are data belonging
--    to already-deleted accounts and WILL be purged by 113 — eyeball them
--    first (they are exactly what Guideline 5.1.1(v) says must go).
-- ═══════════════════════════════════════════════════════════════════════
SELECT 'vault_items' AS tbl, count(*) AS total,
       count(*) FILTER (WHERE user_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM auth.users u WHERE u.id = vault_items.user_id)) AS orphans
FROM public.vault_items
UNION ALL
SELECT 'lykn_chat_states', count(*),
       count(*) FILTER (WHERE user_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM auth.users u WHERE u.id = lykn_chat_states.user_id))
FROM public.lykn_chat_states
UNION ALL
SELECT 'lykn_security_audit', count(*),
       count(*) FILTER (WHERE user_id IS NOT NULL AND NOT EXISTS
         (SELECT 1 FROM auth.users u WHERE u.id = lykn_security_audit.user_id))
FROM public.lykn_security_audit;

-- ═══════════════════════════════════════════════════════════════════════
-- B. POST-APPLY 113: every user-scoped table must now cascade from
--    auth.users. Expect this to return ZERO rows (any row listed is a
--    public table with a uuid user_id/owner_id column that still lacks a
--    cascading FK to auth.users — `notes`/`sessions` views won't appear).
-- ═══════════════════════════════════════════════════════════════════════
SELECT c.table_name, c.column_name
FROM information_schema.columns c
JOIN pg_class pc ON pc.relname = c.table_name AND pc.relnamespace = 'public'::regnamespace
WHERE c.table_schema = 'public'
  AND c.column_name IN ('user_id', 'owner_id')
  AND c.data_type = 'uuid'
  AND pc.relkind = 'r'
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint fk
    JOIN pg_attribute pa ON pa.attrelid = fk.conrelid AND pa.attnum = ANY (fk.conkey)
    WHERE fk.contype = 'f'
      AND fk.conrelid = pc.oid
      AND fk.confrelid = 'auth.users'::regclass
      AND fk.confdeltype = 'c'          -- ON DELETE CASCADE
      AND pa.attname = c.column_name
  )
ORDER BY c.table_name;

-- Spot-check the three FKs 113 adds (expect 3 rows, confdeltype = 'c'):
SELECT conname, conrelid::regclass::text AS tbl, confdeltype
FROM pg_constraint
WHERE contype = 'f'
  AND confrelid = 'auth.users'::regclass
  AND conrelid IN ('public.vault_items'::regclass,
                   'public.lykn_chat_states'::regclass,
                   'public.lykn_security_audit'::regclass);

-- ═══════════════════════════════════════════════════════════════════════
-- C. POST-APPLY 114 + 115: tables exist, RLS is on with no policies, and
--    both carry a cascading FK to auth.users. Expect 2 rows, each with
--    rls_enabled = true, policy_count = 0, cascade_fk = true.
-- ═══════════════════════════════════════════════════════════════════════
SELECT pc.relname AS tbl,
       pc.relrowsecurity AS rls_enabled,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = pc.oid) AS policy_count,
       EXISTS (
         SELECT 1 FROM pg_constraint fk
         WHERE fk.contype = 'f' AND fk.conrelid = pc.oid
           AND fk.confrelid = 'auth.users'::regclass AND fk.confdeltype = 'c'
       ) AS cascade_fk
FROM pg_class pc
WHERE pc.relnamespace = 'public'::regnamespace
  AND pc.relname IN ('lykn_apple_tokens', 'lykn_client_metrics');

-- ═══════════════════════════════════════════════════════════════════════
-- D. END-TO-END SMOKE (manual, after apply):
--    1. Fresh SIWA sign-in on device → expect a row:
--         SELECT user_id, created_at FROM public.lykn_apple_tokens;
--    2. Next-day (or crash) MetricKit flush → expect rows:
--         SELECT count(*) FROM public.lykn_client_metrics;
--    3. Delete a THROWAWAY account via the app → its rows vanish from
--       vault_items / lykn_apple_tokens / lykn_client_metrics:
--         SELECT count(*) FROM public.vault_items WHERE user_id = '<uid>';
-- ═══════════════════════════════════════════════════════════════════════
