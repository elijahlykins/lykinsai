# SECURITY_REPORT_03 — Data & Database Security

## Summary

LYKN's database posture was audited end-to-end against the Agent 03 brief — every Supabase client construction, every `user_id`-scoped table's RLS shape, every `supabaseAdmin` call pattern, every `.rpc()` / `.from()` query, the Stripe webhook integrity path, and the migration history from 001 through 064. Going in, the picture was already strong: zero CRITICAL findings, zero HIGH findings, RLS broadly correct on every user-scoped table, Stripe webhook verified using raw bytes before `express.json()`, no SQL string interpolation anywhere, service-role key never reaching `VITE_*` env vars or the Vite bundle (Agent 01 already confirmed), and a clean `userId` trust boundary across all 100 backend routes (Agent 02 already confirmed). The work delivered in this pass tightens the surface in four targeted places — making the OAuth provider tables strictly service-role-only as the brief specified, dropping the unused authenticated-role policies on `lykn_mcp_tokens` so token hashes are server-only, writing explicit `WITH CHECK` clauses on every user-scoped UPDATE policy so a future contributor reading the policy understands the row-ownership invariant, and adding a service-role-only `lykn_security_audit` table fed by pure-pl/pgsql triggers on OAuth code / refresh / MCP token mutations so Agent 06 has structured rows to ship to a SIEM without any application-layer changes. All five sections (A through E) ship in a single idempotent migration: `supabase-migrations/065_security_rls_agent03.sql`.

## Supabase client map

| Client | Key | File:line | Used in |
|---|---|---|---|
| `supabaseAdmin` (module singleton) | `SUPABASE_SERVICE_ROLE_KEY` | `server.js:798` | All server-side data routes via `app.set('supabaseAdmin', …)`; injected into MCP tool ctx, OAuth server, connectors, Stripe webhook handler, billing routes, signed-URL routes, account-deletion route. |
| `createSynthesisUserClient(authHeader)` (factory) | `VITE_SUPABASE_ANON_KEY` + per-request user JWT | `server.js:1849` | Concept routes (preferred over admin), synthesis/beliefs/rules routes (admin preferred, falls back to user client when service-role is absent), `runUserProfileLlmAndUpsert`, `replaceSynthesisChunks`, prompt-assembly section fetchers in `/api/ai/stream`. |
| `supabase` (frontend SPA singleton) | `VITE_SUPABASE_ANON_KEY` | `src/lib/supabase.ts:16` | Every frontend page — auth, vault, boards, synthesis UI, RPC calls (`concepts_overview`, `get_belief_provenance`, etc.). PKCE flow (implicit on Safari). |
| `buildAdminClient()` return | `SUPABASE_SERVICE_ROLE_KEY` | `jobs/conceptsJob.js:68`, `jobs/synthesisJob.js:48` | Nightly concepts job, synthesis refresh job — no user context. |
| Five CLI scripts | `SUPABASE_SERVICE_ROLE_KEY` | `scripts/{backfill-concepts,purge-discover-junk,set-user-plan,fix-discover-thumbnails,diagnose-discover-images}.mjs` | One-shot operator scripts. |
| `usageTracking.js` (raw `fetch` to PostgREST) | `SUPABASE_SERVICE_ROLE_KEY` | `usageTracking.js:205+` | Per-request usage logging and admin usage RPCs — server-only. |

**Verified clean:** Every `SUPABASE_SERVICE_ROLE_KEY` reference is server-side. No `createClient(...)` in this repo is constructed with a `VITE_*`-prefixed service-role key (because no such env var exists). Frontend never sees the service-role key. The single anon client in `src/lib/supabase.ts` uses the public anon key only.

## RLS audit results

User-scoped tables — `[RLS ON + POLICIES COMPLETE]`:

- `notes` — SELECT / INSERT / UPDATE (now with WITH CHECK) / DELETE all `auth.uid() = user_id`.
- `omnia_boards`, `omnia_board_states`, `omnia_projects` — same pattern; UPDATE policies upgraded with explicit WITH CHECK in 065.
- `omnia_shared_boards` — `FOR ALL` with both `USING` and `WITH CHECK` on `owner_id`; plus a public SELECT for active share tokens (intentional, token-gated).
- `lykn_synthesis_chunks`, `lykn_user_synthesis_profile` — full CRUD on `auth.uid() = user_id`; UPDATE WITH CHECK added in 065.
- `rss_feeds`, `social_connections` (sans INSERT — server-only writes via OAuth flow), `lykn_user_model_facts`, `lykn_beliefs`, `lykn_rules`, `lykn_result_attributions`, `lykn_projects`, `lykn_project_state`, `lykn_concepts`, `concept_notes`, `concept_facts`, `concept_beliefs`, `concept_chats` — all scoped to `auth.uid() = user_id`; UPDATE WITH CHECK added in 065.
- `lykn_load_in_user_sections`, `lykn_user_preferences`, `lykn_user_links`, `lykn_project_neurons` — already shipped with explicit WITH CHECK in their original migrations.
- `ai_conversation_memory`, `ai_description_cache`, `ai_transcription_cache`, `lykn_discover_seen`, `rss_seen_entries` — RLS on; access scoped to owner (or owner via parent-feed FK).

User-scoped tables — `[RLS ON + GAPS — by design]`:

- `lykn_mcp_tokens` — INSERT policy omitted on purpose (server-only minting); after 065, **all** policies removed → service-role-only. PostgREST denied for both `anon` and `authenticated`.
- `social_connections` — no INSERT policy (OAuth flow inserts via service role).
- `user_billing` — SELECT-only for authenticated owner; writes via Stripe-webhook service role.
- `stripe_events`, `oauth_states` — RLS on, zero policies; service-role-only.
- `studio_max_waitlist`, `lykn_user_model_revisions`, `lykn_synthesis_runs` — append-only or cron-written; restricted policies by design.
- `ai_usage_logs` — SELECT + INSERT only for authenticated owner; append-only.
- `user_feedback` — SELECT + INSERT for authenticated owner; service-role writes anon feedback rows.

OAuth provider tables — `[RLS ON + ZERO POLICIES = service-role-only]` (post-065):

- `lykn_oauth_clients` — was: authenticated SELECT for `registered_by_user_id`. Now: no policies. Admin-pre-registered clients no longer visible via PostgREST; future admin UI uses `supabaseAdmin`.
- `lykn_oauth_consents` — was: authenticated S/U/D scoped to owner. Now: no policies. Server-side `/Connections` listing was the only legitimate reader and already goes through `supabaseAdmin`.
- `lykn_oauth_authorization_codes` — already had no policies; verified.
- `lykn_oauth_refresh_tokens` — already had no policies; verified.

System / billing tables:

- `user_billing` — SELECT for authenticated owner; writes via Stripe webhook (service role).
- `stripe_events` — RLS on, no policies; service-role-only idempotency table.

System / observability table — created in 065:

- `lykn_security_audit` — RLS on, ZERO policies (service-role-only by construction). Append-only. Written by SECURITY DEFINER triggers on `lykn_oauth_authorization_codes`, `lykn_oauth_refresh_tokens`, `lykn_mcp_tokens`. Read via `supabaseAdmin` only.

`[RLS OFF]` — **none** in the live schema. The single historical case (`memory_notes_cleanup_audit` created in 008, dropped in 011) is gone.

## Service-role usage audit

Structural pattern (every supabaseAdmin call falls into one of these):

- `[JUSTIFIED — background job]` — `jobs/conceptsJob.js`, `jobs/synthesisJob.js`, `makeRssPoller`, `makeConnectorPoller`. No user JWT available; iterates users; each per-user query scoped by `user_id`.
- `[JUSTIFIED — webhook]` — `handleStripeEvent` (`server.js:13979`). No user JWT; `event.data.object.metadata.user_id` and `customer` lookup are the only scoping inputs and are validated against `user_billing` before any write.
- `[JUSTIFIED — secret-gated cron HTTP]` — `/api/discover/ingest`, `/api/synthesis/backfill`, `/api/feeds/poll-due`, `/api/connections/poll-due`. All four use `crypto.timingSafeEqual` against env-var secrets (Agent 02 verified). Operator endpoints; no user JWT.
- `[JUSTIFIED — OAuth provider]` — `oauth-server.js` token mint, code mint, consent upsert, refresh rotation. RFC-mandated server-side state; no user JWT in the `/oauth/token` flow.
- `[JUSTIFIED — admin-gated]` — `/api/admin/usage/*` paths use `requireAdmin` allowlist; service-role is the right tool to read cross-user usage.
- `[JUSTIFIED — user route with explicit `.eq('user_id', req.user.id)`]` — MCP token CRUD, account preferences, connections, billing waitlist, signed URL, MCP/REST tool ctx. Every one of these was inspected; the `req.user.id` scoping filter is consistently present before any `.select`/`.update`/`.delete` of user-owned data.

`[NEEDS REVIEW]` cases — **none** found. No service-role call writing user data without a corresponding `user_id` filter or ownership precondition.

**Architectural observation (not a finding, but documented):** the dominant pattern in `server.js` user routes is `supabaseAdmin || createSynthesisUserClient(authHeader)` — service-role wins when configured. That means RLS is not the active line of defense on those routes; the application-layer `.eq('user_id', req.user.id)` filter is. This is correct by construction (Agent 01 + Agent 02 verified the userId trust boundary is clean) but it does mean the DB is doing less double-checking than it could. Migrating those routes to prefer the user JWT client would require RLS adjustments to grant `authenticated` what those handlers write (preferences upsert, MCP token CRUD, connection writes — some of which deliberately bypass RLS because the table has no INSERT policy). Flagged for a future hardening pass, not this one.

## Stripe webhook verification

`[VERIFIED CORRECT]`

- Mounted with `express.raw({ type: 'application/json' })` at `server.js:716–718`, **before** the global `app.use(express.json(...))` at `server.js:753`.
- `req.body` is therefore a `Buffer` at the time `stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], webhookSecret)` is called (`server.js:732`).
- Webhook secret comes from `process.env.STRIPE_WEBHOOK_SECRET` (no hardcoded fallback). Missing secret → `503 Webhook secret not configured`, never accepted as valid.
- `constructEvent` throwing → `400 Webhook Error: <msg>`, request rejected before any business logic runs (`server.js:737–740`).
- Idempotency layer: `handleStripeEvent` checks `stripe_events.id` before processing, inserts after; duplicate events are no-ops (`server.js:13986–13991`, `13993–14028`).
- Monotone-up billing logic in `syncSubscriptionToBilling` already in place (Agent 01 flagged this as a deliberate design decision; no change here).
- Handler errors → `500 handler_failed` so Stripe retries — correct behaviour.

No change made. The handler does the right thing exactly the way the brief specifies.

## Changes made

| File | Change | CIA | Principle | Severity fixed |
|---|---|---|---|---|
| `supabase-migrations/065_security_rls_agent03.sql` § A | Dropped `"Users read own consents"`, `"Users update own consents"`, `"Users delete own consents"` on `lykn_oauth_consents`; dropped `"Admins read clients they registered"` on `lykn_oauth_clients`. Re-asserted RLS enabled on all four OAuth tables. | Confidentiality | LP, SbD, DiD | MEDIUM |
| `supabase-migrations/065_security_rls_agent03.sql` § B | Dropped `"Users read own mcp tokens"`, `"Users update own mcp tokens"`, `"Users delete own mcp tokens"` on `lykn_mcp_tokens`. Server-only via `supabaseAdmin` now. | Confidentiality | LP, DiD | LOW |
| `supabase-migrations/065_security_rls_agent03.sql` § C | Rebuilt UPDATE policies with explicit `WITH CHECK (auth.uid() = user_id)` on: `notes`, `omnia_boards`, `omnia_board_states`, `omnia_projects`, `sessions`, `lykn_synthesis_chunks`, `lykn_user_synthesis_profile`, `rss_feeds`, `social_connections`, `lykn_user_model_facts`, `lykn_beliefs`, `lykn_rules`, `lykn_result_attributions`, `lykn_projects`, `lykn_project_state`, `lykn_concepts`, `concept_notes`, `concept_facts`, `concept_beliefs`, `concept_chats`. Tables that already shipped with explicit WITH CHECK left untouched. | Integrity | DiD, SbD | LOW |
| `supabase-migrations/065_security_rls_agent03.sql` § D | New table `lykn_security_audit` (RLS on, ZERO policies — service-role-only by construction). Three pl/pgsql trigger functions + six triggers covering INSERT and meaningful UPDATE events on `lykn_oauth_authorization_codes`, `lykn_oauth_refresh_tokens`, `lykn_mcp_tokens`. No plaintext secrets, hashes, or PKCE verifiers in the log — only opaque ids, owning user, client, and timestamps. | Integrity, Availability | DiD, SbD | INFO |

No application code (`server.js`, `oauth-server.js`, etc.) was modified in this pass. Migration 065 is the entire diff.

## Findings by severity

**CRITICAL:** none.

**HIGH:** none.

**MEDIUM (fixed in 065):**

- **M1.** `lykn_oauth_consents` had authenticated-role S/U/D policies, exposing the user's connected-OAuth-client list to any logged-in PostgREST consumer. Brief explicitly asked for service-role-only. Fixed.
- **M2.** `lykn_oauth_clients` had an authenticated-role SELECT policy for admin-pre-registered clients. No admin UI consumes it today; future admin UI can use `supabaseAdmin`. Fixed.

**LOW (fixed in 065):**

- **L1.** `lykn_mcp_tokens` exposed `token_hash` / `token_prefix` to the owning user via PostgREST. Crackability of SHA-256(32-byte secret) is infeasible, but no UI reads this table directly — closed for least-privilege.
- **L2.** UPDATE policies on ~20 user-scoped tables had `USING` only. Postgres defaults `WITH CHECK` to `USING` when omitted, so this was correct in practice, but the brief's deliverable 2 template wants both explicit. Made explicit.

**INFO (addressed or documented):**

- **I1.** No audit triggers on OAuth + MCP token mutations. Brief deliverable 7 said: add pure-SQL triggers if trivially addable, otherwise hand off to Agent 06. Added in 065 as `lykn_security_audit` + six triggers. Log shipping to a SIEM remains Agent 06's call.
- **I2.** `user_feedback.user_id`, `studio_max_waitlist.user_id`, `ai_usage_logs.user_id`, `lykn_oauth_clients.registered_by_user_id` are all NULL-able. All four are intentional (anonymous feedback, anonymous waitlist signups, guest-mode usage, DCR-registered clients with no owning admin). None bypass RLS — the relevant policies either include `IS NOT NULL`-aware predicates or are server-role-only. Documented; no change.
- **I3.** Service-role-first pattern in user routes — see "Service role usage audit" above. Not a finding; documented as future-hardening opportunity.

## CIA triad coverage

- **Confidentiality:**
  - OAuth consents + clients no longer enumerable via PostgREST (M1, M2 fixed).
  - MCP token hashes no longer exposed via PostgREST even to the owner (L1 fixed).
  - Every user-scoped table verified with `auth.uid() = user_id` SELECT scoping; no cross-user read path found via PostgREST.
  - Service-role key confirmed to never reach the browser bundle (already confirmed by Agent 01; re-verified during the audit).
- **Integrity:**
  - Every UPDATE policy on a user-scoped table now has explicit `WITH CHECK` — a row's `user_id` cannot be flipped to another user mid-UPDATE even via PostgREST (L2 fixed).
  - Stripe webhook signature verification confirmed against raw body Buffer with the secret from env (verified, not modified).
  - Zero SQL string interpolation found in the codebase; all queries parameterized via the Supabase JS SDK or PostgREST filter syntax with sanitized inputs.
  - Audit triggers in 065 give us tamper-evident records of OAuth code/refresh mints and MCP token state changes — service-role-only, append-only.
- **Availability:**
  - No new code paths in the hot request path. All migration work is at the DB layer; runtime impact is one extra `INSERT INTO lykn_security_audit` per OAuth-code mint / consume / refresh mint / rotate / MCP token mint / status change. Low single-digit rows per user per OAuth handshake.
  - RLS policies remain straightforward (no nested EXISTS in any policy added by 065) — no query-planner surprises.
  - No constraint changes that could fail in production on existing data.

## Open items — need your review before Agent 04 starts

- **None blocking.** All five approved sections (A through E) shipped in `supabase-migrations/065_security_rls_agent03.sql`. No new CRITICAL or HIGH findings outstanding.

Items to track but not block on:

- **Service-role-first pattern in user routes.** Migrating the ~20 routes in `server.js` that prefer `supabaseAdmin` over `createSynthesisUserClient` would let RLS actively double-check the application-layer `.eq('user_id', req.user.id)` filters. Requires per-route testing + likely RLS adjustments to grant `authenticated` what those handlers write today. Recommend its own PR.
- **`lykn_security_audit` retention policy.** No TRUNCATE or cron-purge yet. At current LYKN volume this is years-out concern, but Agent 06 should plumb a retention job when log shipping is wired up.
- **`lykn_oauth_clients.registration_ip` retention.** This audit log already captures DCR provenance per row; consider mirroring it into `lykn_security_audit` as an `oauth_client_registered` event in a future pass.

## Findings for other agents

**Agent 04 (API & App):**

- The Supabase JS SDK's parameterized-query guarantee means `.eq()` / `.in()` / `.match()` etc. are safe from injection. Your validation work should focus on (a) JSON-body shape validation (Zod / similar) on POST endpoints, (b) prompt-injection defense on AI streaming endpoints, (c) rate-limit additions on `/oauth/token` and `/oauth/register` (Agent 02 flagged), (d) request-size caps beyond the existing `'5mb'` body limit if any single endpoint genuinely needs more or less.
- `lykn_security_audit` rows are now generated server-side on every OAuth code mint / consume / refresh / rotate. If you add new high-value mutation endpoints (e.g. an admin-triggered consent revocation), prefer extending the trigger functions in 065 over writing application-layer audit code.

**Agent 05 (Secrets & Supply Chain):**

- No DB-connection-string secrets found outside env vars. Service-role key is confirmed env-only and never enters the Vite bundle (Agent 01 confirmed; re-verified during this pass).
- The `lykn_oauth_clients.client_secret_hash` column uses bare SHA-256 (Agent 02 noted). Fine for a server-managed 32-byte-random secret with no human-set passwords involved, but worth documenting in the secrets runbook so a future contributor doesn't assume bcrypt-style protection is in place.
- The 8-char minimum on `BACKFILL_SECRET` / `ADMIN_INGEST_SECRET` / `DISCOVER_INGEST_SECRET` (Agent 02 flagged) should be raised to ≥32 in the runbook before bumping the code check, to avoid locking out any deploy still running an 8-char dev secret.

**Agent 06 (Observability):**

- `lykn_security_audit` is the structured row source for OAuth + MCP token events you would have otherwise needed application-layer log shipping for. Polling pattern: `SELECT * FROM lykn_security_audit WHERE occurred_at > $1 ORDER BY occurred_at ASC LIMIT 1000` via `supabaseAdmin`, then ship to whatever log sink you stand up. Alert candidates:
  - High-rate `oauth_code_minted` from a single client_id → DCR-abuse probe.
  - `oauth_refresh_rotated` events where `metadata->>'replaced_by_id'` is the same id appearing twice (shouldn't happen given the UNIQUE constraint, but worth a guard).
  - `mcp_token_status_changed` with `old_status='active'` and `new_status='revoked'` clustered in time → possible user-noticed credential compromise.
  - `mcp_token_minted` with `metadata->>'client_kind'` shifting from one user's historical distribution → possible token-theft + replay from new client.
- Brief deliverable 7 also wants Supabase project-level log levels confirmed in the Dashboard → Settings → Logs. That's an out-of-code config item; not something this migration can express. Action: in the Supabase dashboard, confirm "API" and "Database" log levels are set to `info` (not `warn`) so 401/403/RLS denials show up in the queryable log stream.
- No `report-uri` / `report-to` on the frontend CSP yet (Agent 01 flagged) — when you stand up a telemetry endpoint, wiring it in gives you live signal on blocked requests, including any RLS-denial path that surfaces as a 401 vs. a 403.

---

*LYKN Security Plan — Agent 03 of 6 — Data & Database Security — handoff to Agent 04 (API & App).*
