# Internal note — anon-callable admin RPC info disclosure

**Status:** patched — `supabase-migrations/068_lock_down_anon_functions.sql` + `069_pin_function_search_path.sql` applied to production. Regression gate live in CI (`.github/workflows/security.yml` → `anon-permission-probe`).

**Severity:** Critical (unauthenticated information disclosure of PII at scale).

**Class:** CWE-732 (Incorrect Permission Assignment for Critical Resource), specifically the Supabase-Postgres trap where `REVOKE … FROM PUBLIC` does not remove the `anon` role's privileges because Supabase's bootstrap grants `anon` directly via `ALTER DEFAULT PRIVILEGES`, not via `PUBLIC`.

This note exists so that if anyone (the team, an auditor, a user, regulator) asks what happened, the answer is reconstructible without mining chat logs or commit history later under pressure.

---

## What was exposed

Anyone holding the public Supabase anon JWT (which ships in the iOS binary, every web bundle, and every OAuth consent page) could call the following endpoints directly via PostgREST and receive real data:

| Endpoint                                          | What it returned                                                                  |
| ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `POST /rest/v1/rpc/admin_users_with_usage`        | Every user's `auth.users.email` joined to their AI spend, token totals, last seen |
| `POST /rest/v1/rpc/admin_recent_activity`         | Up to 500 most-recent `ai_usage_logs` rows incl. emails + `metadata` jsonb        |
| `POST /rest/v1/rpc/admin_usage_overview`          | Aggregate spend / tokens / actives across the whole project                       |
| `POST /rest/v1/rpc/admin_user_drilldown`          | Per-user spend + recent log rows once a uuid was known                            |
| `POST /rest/v1/rpc/admin_usage_live`              | Last-N-minutes activity feed incl. emails                                         |
| `GET  /rest/v1/v_usage_by_user_month` (and 4 more) | Reporting views that bypassed RLS via owner-side execution                        |

Two write RPCs were also anon-reachable but their internal `auth.uid()` guards or no-op semantics mean no data mutation has been observed:

- `merge_concepts(uuid, uuid)` — would have been a no-op for anon because the function's owner-check matches no rows when `auth.uid()` is `NULL`.
- `rls_auto_enable()` — only iterates `pg_class` and turns RLS *on* for tables that lack it; cannot turn RLS *off*.

## What was confirmed leaked

22 user emails (4 admin accounts + 18 non-admin users) plus their associated spend patterns and AI activity metadata. Direct extraction reproduced via `~/lykn-anon-probe.sh` against production with only the public anon JWT.

## Exposure window

- **Opened:** when migration `040_admin_usage_rpcs.sql` was applied to production. Confirm the exact date by checking the Supabase migration history table (`supabase_migrations.schema_migrations`) or the deploy log — fill that in here once confirmed: `<TIMESTAMP_MIGRATION_040_APPLIED>`.
- **Closed:** when migration `068_lock_down_anon_functions.sql` was applied to production. Fill in: `<TIMESTAMP_MIGRATION_068_APPLIED>`.

## Root cause

Postgres grants `EXECUTE` on every newly-created function to `PUBLIC` by default. The five admin RPCs were created with the half-correct boilerplate:

```sql
REVOKE ALL ON FUNCTION ... FROM PUBLIC;
REVOKE ALL ON FUNCTION ... FROM authenticated;
GRANT EXECUTE ON FUNCTION ... TO service_role;
```

In a vanilla Postgres setup that's sufficient. In Supabase it isn't: the project's bootstrap runs

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
```

…which gives `anon` a *direct* `EXECUTE` grant on every new function, not a grant inherited via `PUBLIC`. `REVOKE … FROM PUBLIC` doesn't touch direct grants. The same trap applies to tables and views — which is why `v_usage_by_user_month` and friends were also readable by anon despite their `REVOKE … FROM PUBLIC` boilerplate. The Supabase advisor flagged this 24 times; the warnings were not actioned at the time of those migrations.

## Why the fix was structured this way

Two migrations and a CI gate, in that order:

1. **`068_lock_down_anon_functions.sql`** — explicit `REVOKE EXECUTE … FROM anon, authenticated` on every affected function, plus `DROP VIEW` on the five reporting views (chosen over `ALTER VIEW … SET (security_invoker = true)` because nothing in app code reads them — only `supabase-queries/ai_usage_dashboard.sql`, a manual SQL Editor cheatsheet — and dropping is unambiguous).
2. **`069_pin_function_search_path.sql`** — `ALTER FUNCTION … SET search_path` on every function the advisor flagged as having mutable search_path. Defense-in-depth against a future `CREATE` privilege grant on schema `public`. Per-function pinning rather than blanket `pg_catalog, public` because some functions (e.g. `search_files_by_embedding`) use the `extensions` schema.
3. **`scripts/anon-permission-probe.mjs` + CI job** — re-runs the exploit attempt on every PR / push to main, asserting denial. Treat any future failure as P0.

`omnia_shared_board_record_view(text)` deliberately retains anon `EXECUTE` because the `/s/<token>` public board-share viewer (`src/lib/grid/sharedGrids.ts:199`) calls it with the anon client to record an unauthenticated view. The probe asserts this stays anon-callable so we can't accidentally break public sharing while tightening other RPCs.

## What did NOT fix the bug

Rotating the anon JWT was considered and rejected. The anon JWT is not a credential — it's a public claim of "I am the anonymous role." Rotating it doesn't change the attack surface; it just invalidates every signed-out client. The fix is the `REVOKE`, not the rotation.

## Disclosure decision

Under GDPR Art. 33, the threshold for notifying users is "high risk to rights and freedoms." Exposed data was email + spend pattern + recent AI action metadata. There is no evidence of password, payment, or content-of-conversation exposure. Our reading is that this does not clear the "high risk" bar.

**Decision:** no proactive user notification; document internally; respond to any data-subject access request transparently if asked. Re-evaluate if the forensics in `2026-05-anon-rpc-leak-forensics.sql` (or the Supabase API request logs) surface evidence of automated scraping in the exposure window — that would shift the calculus.

If your DPA / counsel disagrees with this read, escalate before we ship a follow-up product change that could imply otherwise.

## Follow-ups still owed

| #   | Item                                                                                                         | Status                                                |
| --- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 1   | Review Supabase Dashboard → Logs → API for anon hits on `/rest/v1/rpc/admin_*` during the exposure window    | open                                                  |
| 2   | Run `docs/security/2026-05-anon-rpc-leak-forensics.sql` for second-order anomaly signals                     | open                                                  |
| 3   | Toggle `auth_leaked_password_protection` ON (Supabase Dashboard → Authentication → Policies)                 | open                                                  |
| 4   | Consider Cloudflare/WAF in front of the Supabase REST URL via custom domain — limits anon abuse going forward | tracked in `security_open_items` LYKN project state   |
| 5   | Add a project convention: `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;` so future migrations don't reintroduce the pattern | proposed; needs decision before next admin-RPC ships |

## Appendix — verifying the fix

```bash
# 1. Apply migrations
psql "$DATABASE_URL" -f supabase-migrations/068_lock_down_anon_functions.sql
psql "$DATABASE_URL" -f supabase-migrations/069_pin_function_search_path.sql

# 2. Reload PostgREST cache so the function exposure drops immediately
psql "$DATABASE_URL" -c "NOTIFY pgrst, 'reload schema';"

# 3. Run the regression probe locally and confirm all PASS
VITE_SUPABASE_URL="$VITE_SUPABASE_URL" \
VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" \
  node scripts/anon-permission-probe.mjs
```

The CI job re-runs (3) on every PR and on a daily schedule, so any regression surfaces within 24 hours of merge — not at the next pen-test.
