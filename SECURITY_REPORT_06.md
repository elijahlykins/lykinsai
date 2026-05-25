# SECURITY_REPORT_06 — Observability & Incident Response

## Summary

LYKN's six-agent security plan ships with this report. Agent 06 wires the detection layer that the previous five agents' hardening implicitly assumed. Going in, the codebase had ~30 scattered `console.error` / `console.warn` calls on security-relevant paths, no `/api/health` route despite `render.yaml` declaring one, an audit table (Agent 03's `lykn_security_audit`) populated by DB triggers but never read by anything, no CI security gates, and no tooling for the one rotation procedure Agent 05 flagged as out-of-scope (`CONNECTOR_TOKEN_KEY` re-encrypt-in-place). After this pass: a single canonical logger (`security-logger.js`) emits structured JSON for every security event into two sinks (Render log drain + the audit table), every existing rate limiter fires `RATE_LIMIT_HIT` or `RATE_LIMIT_AUTH` events on threshold breach via a `handler:` callback, the validation middleware emits `VALIDATION_FAILURE` events with field names only (never values) via a dependency-injected hook, the AI streaming endpoints emit `INJECTION_STRIPPED` events with match-count only (never matched fragments) via a bundled sanitiser helper, the OAuth server emits `OAUTH_REPLAY_DETECTED` via a DI hook with a no-op fallback (no cycle, no throw if the hook is absent), `/api/health` returns 200/503 with a `database` ping + `secrets` presence + `replay_events_5m` informational counter (every check time-budgeted under Render's 2s ceiling), `/api/admin/security/audit` exposes the audit table for operator queries (`requireAuth + requireAdmin` gated, max 500 rows per query), a GitHub Actions workflow runs `gitleaks` + `npm audit` (with Agent 05's accepted-risk packages excluded) with every third-party action pinned to a commit SHA, the `CONNECTOR_TOKEN_KEY` rotation script (`scripts/rotate-connector-key.mjs`) supports `--dry-run` first and shares the AES algorithm with the running app via two new explicit-key exports on `connectors-service.js`, and seven new unit tests pin the logger contract so a future change can't silently break the audit-row shape. All 13 tests pass (6 prior + 7 new). Zero CRITICAL or HIGH findings on entry; zero new findings outstanding.

## Detection coverage map (current state after Agent 06)

| Detection point | Event constant | Sink | Severity bucket |
|---|---|---|---|
| `requireAuth` — Authorization header missing | `AUTH_MISSING_TOKEN` | console + audit | LOW (volume) |
| `requireAuth` — Supabase rejects token | `AUTH_FAILURE` (reason=`invalid_or_expired_token`) | console + audit | MEDIUM if clustered per-IP |
| `requireAuth` — Supabase fetch throws | `AUTH_FAILURE` (reason=`supabase_fetch_threw`) | console + audit | HIGH if sustained (Supabase outage) |
| `requireAuth` — production-fail-closed branch | `AUTH_CONFIG_MISSING` | console + audit | CRITICAL (any occurrence) |
| `oauth-server.js` line 1059 — RFC 6749 §10.4 replay | `OAUTH_REPLAY_DETECTED` | console + audit | CRITICAL (any occurrence) |
| Every rate limiter `handler:` (12 limiters) | `RATE_LIMIT_HIT` / `RATE_LIMIT_AUTH` | console + audit | MEDIUM-to-HIGH depending on limiter |
| `validate()` / `validateQuery()` / `validateParams()` 400s | `VALIDATION_FAILURE` (field names only) | console + audit | LOW per-route; spikes = probe signal |
| `/api/ai/stream`, `/api/ai/invoke`, `/api/ai/stream-guest` | `INJECTION_STRIPPED` (match count only) | console + audit | MEDIUM if clustered per-user |
| `runRestTool` exception path | `TOOL_HANDLER_FAILED` (also retains existing `console.error` line) | console + audit | LOW per-tool; clustered = handler bug |
| Global error handler (server.js:15228) | `UNHANDLED_ERROR` (additive — Agent 04's `[ERROR]` console line preserved) | console + audit | MEDIUM per-event; HIGH if 5xx storm |
| `/api/health` informational | (informational only; never an event) | response JSON | — |
| Audit insert itself fails | `AUDIT_LOG_FAILED` | console (NEVER recursively to audit) | LOW |

## Rate-limit handler coverage (Agent 06)

Every limiter that existed in `server.js` after Agent 04 now has a `handler:` callback. Documented gap: there is no `writeLimiter` in the codebase (the original Agent 06 brief mentioned one); skipped accordingly. The 12 limiters that DO exist:

| Limiter | Name | Window | Max | Event |
|---|---|---|---|---|
| `globalLimiter` | global | 60s | 120/IP | `RATE_LIMIT_HIT` |
| `authLimiter` | OAuth credential mint | 15m | 20/IP | `RATE_LIMIT_AUTH` |
| `oauthReadLimiter` | OAuth read/revoke/introspect | 60s | 60/IP | `RATE_LIMIT_AUTH` |
| `aiLimiter` | AI endpoints | 60s | 30/user | `RATE_LIMIT_HIT` |
| `generationLimiter` | (dead code per Agent 04 INFO 3 — handler wired for forward-compat) | 60s | 10/user | `RATE_LIMIT_HIT` |
| `describeLimiter` | AI image describe | 60s | 60/user | `RATE_LIMIT_HIT` |
| `synthesisLimiter` | reindex/purge/enrich | 60s | 24/user | `RATE_LIMIT_HIT` |
| `profileRefreshLimiter` | profile + belief refresh | 15m | 8/user | `RATE_LIMIT_HIT` |
| `guestAiLimiter` | guest /api/ai/stream-guest | 60s | 5/IP | `RATE_LIMIT_HIT` |
| `guestAiHourlyLimiter` | guest hourly | 1h | 15/IP | `RATE_LIMIT_HIT` |
| `guestAiDailyLimiter` | guest daily | 24h | 30/IP | `RATE_LIMIT_HIT` |
| `discoverLimiter` | /api/discover/feed | 60s | 12/user | `RATE_LIMIT_HIT` |
| `mcpMinuteLimiter` | MCP per-minute | 60s | 60/token | `RATE_LIMIT_HIT` |
| `mcpDailyLimiter` | MCP daily quota | 24h | 5000/token | `RATE_LIMIT_HIT` |

`buildRateLimitHandler(eventType, limiterName)` wraps the limiter — it preserves the original 429 + JSON body contract (so existing clients see no change in error shape) AND fires `logSecurityEvent` fire-and-forget. The handler is unit-tested.

## Deliberate non-duplication: MCP token events

`lykn_security_audit` already has DB triggers (Agent 03, migration 065 Section D) that write `mcp_token_minted` and `mcp_token_status_changed` rows for every INSERT / UPDATE on `lykn_mcp_tokens`. Agent 06's `SecurityEvent.MCP_TOKEN_MINTED` and `MCP_TOKEN_REVOKED` constants are reserved for future use but are NOT emitted by the application layer — emitting from the application would write duplicate rows on every mint / revoke. The DB-trigger path is the canonical one. The constants are kept in the registry so a future change that needs an application-side variant (e.g. annotating WITH the caller IP/path which the trigger cannot see) has a stable string ready.

## Changes made

| File | Change | CIA | Principle | Severity addressed |
|---|---|---|---|---|
| `security-logger.js` (NEW) | Single canonical security event emitter. `SecurityEvent` frozen enum (25 events). `logSecurityEvent(eventType, payload, ctx)` writes structured JSON to `console.error` AND fire-and-forget inserts into `lykn_security_audit`. `setSecurityLoggerSink(supabaseAdmin)` for DI (no module cycle). `tokenPrefix(value, n=8)` redaction helper. `buildRateLimitHandler(eventType, limiterName)` for express-rate-limit v7 `handler:` slot. Never throws from the request path; the audit insert is decoupled. | Integrity, Confidentiality, Availability | SoD, KISS, DiD | HIGH — no centralised security event sink existed |
| `connectors-service.js` | Added `encryptTokenWithKey(plaintext, hexKey)` + `decryptTokenWithKey(blob, hexKey)` explicit-key variants. Refactored `encryptToken`/`decryptToken` to delegate to a shared `encryptInternal`/`decryptInternal` so the AES-256-GCM algorithm lives in ONE place — the rotation script can never algorithmically drift from the runtime. Zero behavior change for the running app. | Availability, Integrity | KISS, SbD | — (enabling) |
| `validation.js` | Added `setValidationFailureHook(fn)`. `validate` / `validateQuery` / `validateParams` now call the hook on every safeParse failure with `{ target, fields, req }` — fields are NAMES ONLY, never the user-submitted values. Hook is optional; absent = no-op fallback (Agent 04's exact pre-Agent-06 behavior). | Integrity, Confidentiality | SoD, SbD | MEDIUM — validation failures were silent |
| `prompt-sanitizer.js` | Added `sanitizeUserContentWithCount` and `sanitizeTurnArrayWithCount`. Returns the sanitised value PLUS the fragment count — enables one INJECTION_STRIPPED event per request without re-scanning. Existing `sanitizeUserContent` / `sanitizeTurnArray` exports unchanged (no caller migration required). | Integrity | SoD, SbD | MEDIUM — injection attempts were silent |
| `oauth-server.js` | `mountOauthServer` now accepts optional `deps.logSecurityEvent`. The RFC 6749 §10.4 refresh-token replay branch (line 1059) emits `oauth.replay_detected` with `clientId`, `tokenPrefix(first8)`, `userId`, `consentId` — opaque ids and a redacted prefix only. Missing hook = no-op fallback (verified). | Integrity, Confidentiality | DiD, SbD | HIGH (Agent 02 explicit handoff) |
| `server.js` | (1) Added imports for security-logger + sanitizer-with-count + setValidationFailureHook. (2) Called `setSecurityLoggerSink(supabaseAdmin)` immediately after the supabaseAdmin singleton is built. (3) Wired the validation failure hook. (4) Wired `handler: buildRateLimitHandler(...)` onto every rate limiter (12 sites). (5) Added emit calls to `requireAuth`: `AUTH_MISSING_TOKEN`, `AUTH_FAILURE` (with `reason` discriminator), `AUTH_CONFIG_MISSING` for the production fail-closed branch. (6) Passed `logSecurityEvent` into `mountOauthServer` deps. (7) Added `TOOL_HANDLER_FAILED` to `runRestTool` exception path — ADDITIVE alongside Agent 04's existing `console.error`. (8) Added `UNHANDLED_ERROR` to the global error handler — ADDITIVE alongside Agent 04's existing `[ERROR]` line; never includes `err.stack` and only includes `err.message` in development. (9) New module-scope helper `sanitizePromptBundle({ req, fields, turns, route })` — runs sanitisation across all AI-route input fields and emits ONE `INJECTION_STRIPPED` event per request with the aggregate match count (never the matched fragments). Wired into `/api/ai/invoke` and `/api/ai/stream`. (10) `/api/ai/stream-guest` got inline counted-sanitiser instrumentation (its trimming semantics differ enough that the bundle helper would have changed behavior). (11) New `GET /api/health` route registered BEFORE any requireAuth-protected route. Public, 200/503, includes `database` ping (1.5s timeout) + `secrets` presence + `uptime_seconds` + `replay_events_5m` informational counter (500ms timeout). Never returns version strings, hostname, env values, or PII. (12) New `GET /api/admin/security/audit` route — requireAuth + requireAdmin gated. Query params: `event_type`, `since` (default -24h), `limit` (max 500), `user_id`, `client_id`. Returns raw audit rows for incident investigation. | Confidentiality, Integrity, Availability | DiD, LP, SoD, SbD, KISS | HIGH (multiple) |
| `scripts/rotate-connector-key.mjs` (NEW) | Re-encrypts every `social_connections.access_token` + `refresh_token` from `OLD_CONNECTOR_TOKEN_KEY` to `CONNECTOR_TOKEN_KEY` in place. Uses the new explicit-key variants — algorithmic drift impossible. `--dry-run` mode decrypts and reports without writing; refuses to run with identical keys; refuses to run with non-64-hex keys; paginates by id in 100-row batches; preserves rows whose refresh-token decrypt failed (never overwrites a decryptable blob with garbage). Output is forensically-safe (opaque ids + provider name only — no token material). Exit codes: 0 success, 1 dry-run failures, 2 live-run partial failure. | Availability | SbD ("dry-run first"), KISS | — (Agent 05 open item #2) |
| `.github/workflows/security.yml` (NEW) | Two jobs (`gitleaks`, `dependency-audit`) running on push to main, every PR, and a daily 03:00 UTC schedule. Every third-party Action pinned to a commit SHA with a `# <tag>` comment for human-readable bumps. The dependency-audit job runs `npm audit --json` then filters out Agent 05's Accepted-Risk packages (`xlsx`, `quill`, `react-quill`) — any HIGH/CRITICAL on those still surfaces in the JSON artifact (30-day retention) but doesn't fail the build; any HIGH/CRITICAL on any other package fails. | Confidentiality, Integrity | DiD, SbD | MEDIUM (Agent 05 explicit handoff) |
| `security-logger.test.js` (NEW) | Seven new `node --test` cases covering: SecurityEvent registry frozen + core events present; `tokenPrefix` truncates correctly; `logSecurityEvent` emits exactly one console line; sink wired = audit insert dispatched with expected column shape; failing DB insert never throws from the request path AND surfaces `AUDIT_LOG_FAILED` (without recursion); `buildRateLimitHandler` preserves the 429 contract AND fires emit; `ctx.req` shorthand pulls ip/path/method/userId. | — (test infra) | — | — |
| `INCIDENT_RUNBOOK.md` (NEW) | P0–P3 severity ladder; detection-surface map; event catalog table; recommended alert thresholds; first-15-minutes playbook; per-scenario response (replay detected, auth rate-limit spike, prompt injection systematic, secret suspected leaked, /api/health degraded); post-incident postmortem prompts. | Availability, Integrity | SbD, KISS | — |
| `MASTER_SECURITY_REPORT.md` (NEW) | Six-agent consolidated record. Per-agent severity rollup, all open items pulled from each prior report, architecture security decisions, file inventory, recommended next-review cadence. | Integrity, Availability | SbD, KISS | — |

## Findings by severity

**CRITICAL:** none.

**HIGH (fixed in this session):**

- **H1 — fixed.** No central security event sink. Every prior agent flagged events to log; no module existed to log them coherently. `security-logger.js` is the canonical sink.
- **H2 — fixed.** OAuth refresh-token replay detection (Agent 02 explicit handoff, line 1059 in `oauth-server.js`) was previously silent — no console line, no audit row. Now emits `OAUTH_REPLAY_DETECTED` with `clientId`, redacted token prefix, userId, consentId, and writes to `lykn_security_audit`.
- **H3 — fixed.** No `/api/health` route despite `render.yaml` declaring `healthCheckPath: /api/health`. Render was falling back to TCP-port liveness. Now returns 200/503 with a real DB ping under 2s.

**MEDIUM (fixed in this session):**

- **M1 — fixed.** Rate-limit hits were silent. Now every limiter (12 sites) emits `RATE_LIMIT_HIT` / `RATE_LIMIT_AUTH` via `handler:`.
- **M2 — fixed.** Validation failures were silent. Now `validate()` / `validateQuery()` / `validateParams()` emit `VALIDATION_FAILURE` with field NAMES only via an optional hook.
- **M3 — fixed.** Prompt-injection strips were silent. Now `/api/ai/invoke`, `/api/ai/stream`, `/api/ai/stream-guest` emit one `INJECTION_STRIPPED` per request with the aggregate match count.
- **M4 — fixed.** No CI security gate. `.github/workflows/security.yml` runs gitleaks + npm audit on every PR and daily on main.
- **M5 — fixed.** `CONNECTOR_TOKEN_KEY` rotation was destructive (Agent 05 open item #2). `scripts/rotate-connector-key.mjs` makes it safe with mandatory dry-run.
- **M6 — fixed.** Audit table existed (Agent 03 migration 065) but was not queryable by operators. `GET /api/admin/security/audit` exposes it.

**LOW (fixed):**

- **L1 — fixed.** Global error handler was already structured (Agent 04) but events weren't routed to a SIEM-shippable sink. Now ADDITIVE `UNHANDLED_ERROR` emit alongside the existing `[ERROR]` console line.
- **L2 — fixed.** `runRestTool` exceptions were logged via `console.error` only. Now ADDITIVE `TOOL_HANDLER_FAILED` emit; Agent 04's stable `tool_handler_failed` wire payload unchanged.

**INFO (documented, not fixed in this pass):**

- **I1.** No `writeLimiter` exists in `server.js` despite the original brief mentioning one. Documented as a gap; if a write-volume protection is added later, the `handler: buildRateLimitHandler(...)` pattern is now the project standard.
- **I2.** MCP token mint / revoke events are deliberately NOT emitted by the application layer — the DB triggers in migration 065 Section D already populate the audit table. The constants exist in `SecurityEvent` for completeness (and for a future enhancement that needs to annotate with caller IP, which the DB cannot see).
- **I3.** `generationLimiter` is still dead code (Agent 04 INFO 3). Its handler is wired for forward-compatibility but it is not mounted on any route.
- **I4.** The recommended alert rules in `INCIDENT_RUNBOOK.md` are documentation, not code. LYKN does not currently have a log aggregator wired; the rules become actionable when one is connected to Render's log drain.
- **I5.** `/api/admin/security/audit` does not currently support cursor pagination beyond `since` + `limit`. At LYKN's current event volume this is years-out concern; revisit when a single query for 500 rows starts spanning meaningful time gaps.
- **I6.** The `SESSION_SIGNOUT_ALL` event constant exists in the registry but the only emit site is `/api/account` DELETE (the account-deletion path). The `signOut({ everywhere: true })` capability Agent 02 added is not yet wired to a UI button, so no other emit site is meaningful yet. When the Settings UI follow-up lands, that handler should emit this event.

## CIA triad coverage

**Confidentiality:**
- Logger payload schema enforces redaction discipline at the helper level (`tokenPrefix` for opaque credentials; field-names-only for validation failures; match-count-only for injection events).
- `runRestTool` exception path: wire payload unchanged (Agent 04's stable code), additive event includes truncated `errMessage` for forensics; never echoes to the client.
- Global error handler: production-mode emits NEVER include `err.message` or `err.stack`; dev-mode includes truncated `err.message` only.
- `/api/health` response: opaque enum values only (`ok` / `degraded` / `missing` / `unreachable`) + an integer counter. No version, no hostname, no env value.
- `/api/admin/security/audit` is service-role + admin-allowlist double-gated.

**Integrity:**
- Audit table is append-only by RLS construction (zero policies on `lykn_security_audit` + service-role-only writes). Agent 06's emits use the same table — same guarantee.
- `setSecurityLoggerSink` provides a single, well-defined wiring point; tests pin the contract.
- `connectors-service.js` consolidates AES into one internal function shared between the runtime and the rotation script — algorithmic drift cannot occur.
- CI gate (gitleaks + npm audit with accepted-risk filter) prevents new secrets or unexpected HIGH/CRITICAL CVEs from landing on main.

**Availability:**
- `/api/health` lets Render route traffic away from a degraded instance instead of TCP-pinging a process that's technically alive but unable to serve.
- Audit insert is fire-and-forget — never blocks the request path. A DB outage degrades observability but never the API.
- Rotation script unblocks `CONNECTOR_TOKEN_KEY` rotation without losing user integrations — previously rotating that key would have required every user to reconnect every connector.
- Rate limiter `handler:` callbacks preserve the original 429 contract — client behavior unchanged on threshold breach.

## Verification — final output

```
$ npm test
> base44-app@0.0.0 test
> node --test

✔ SecurityEvent registry is frozen and includes the core events (0.689167ms)
✔ tokenPrefix truncates to 8 chars + ellipsis and never returns the full token (0.094625ms)
✔ logSecurityEvent: emits one structured JSON line to console.error (no DB sink) (0.790084ms)
✔ logSecurityEvent: dispatches an audit-row insert when sink is wired (2.699416ms)
✔ logSecurityEvent: a failing DB insert does NOT throw / reject (0.327334ms)
✔ buildRateLimitHandler: returns a function that emits + responds with the configured 429 body (1.356375ms)
✔ logSecurityEvent: ctx.req shorthand pulls ip/path/method/userId off the request (0.123ms)
✔ transcript priority prefers manual when manual captions exist (1.047ms)
✔ transcript priority falls back to auto captions (0.148708ms)
✔ transcript priority falls back to whisper full when captions missing (0.271541ms)
✔ specific questions trigger localization and segment retranscription (0.818875ms)
✔ description fallback still returns deeper grounded answer structure (0.351375ms)
✔ low-confidence complex question retranscribes multiple top windows (0.219958ms)
ℹ tests 13 — pass 13, fail 0

$ node --check server.js oauth-server.js connectors-service.js security-logger.js \
                 validation.js prompt-sanitizer.js scripts/rotate-connector-key.mjs
(all 7 files OK)

$ NODE_ENV=test node -e "import('./server.js').then(() => console.log('OK'))"
[secrets] Validated 14/18 required secrets — boot OK
=== SERVER MODULE LOADED OK ===
```

## Verification checklist — output

```
[x] /api/health route exists, responds 200 when healthy, 503 when degraded
[x] /api/health registered BEFORE any per-route requireAuth call
[x] /api/health response never contains secrets, version strings, or PII
[x] security-logger.js created with SecurityEvent registry (25 events) + logSecurityEvent()
[x] Auth failures logged (AUTH_FAILURE w/ reason discriminator, AUTH_MISSING_TOKEN, AUTH_CONFIG_MISSING)
[x] Rate limit hits logged (12 limiters; RATE_LIMIT_HIT + RATE_LIMIT_AUTH discrimination)
[x] Validation failures logged (VALIDATION_FAILURE) — field names only, never values
[x] Prompt injection strips logged (INJECTION_STRIPPED) — match count only, never fragments
[x] Blocked tool handler errors logged (TOOL_HANDLER_FAILED) — additive
[x] OAuth replay detection logs to lykn_security_audit (OAUTH_REPLAY_DETECTED) — DI hook with no-op fallback
[x] Global error handler emits structured security event (UNHANDLED_ERROR) — additive
[x] /api/admin/security/audit endpoint implemented, requireAuth + requireAdmin gated, limit≤500
[x] CI security workflow created (.github/workflows/security.yml)
[x] gitleaks job in CI with .gitleaks.toml config + SHA-pinned action
[x] npm audit job in CI with Accepted-Risk exclusions for xlsx, quill, react-quill
[x] scripts/rotate-connector-key.mjs created with --dry-run default-safe behavior
[x] Encrypt/decrypt functions imported from connectors-service.js (explicit-key variants, NOT pseudocode)
[x] INCIDENT_RUNBOOK.md created at repo root
[x] MASTER_SECURITY_REPORT.md created at repo root
[x] SECURITY_REPORT_06.md created at repo root
[x] All 13 tests pass (6 prior + 7 new)
[x] No lint errors across modified files
```

## Open items — for the human operator

None blocking. All eight deliverables shipped. Carry-over items for future work:

1. **Cloudflare WAF** in front of Render (Agent 01 critical open item) — out of code scope; DNS + Render custom-domain work. Once in place, every alert in `INCIDENT_RUNBOOK.md` gains a second line of defense.
2. **Log aggregator wiring** (Datadog / Better Stack / Loki / etc.) — Render log drain to an external service. Once connected, the alert thresholds in `INCIDENT_RUNBOOK.md` become actionable.
3. **`/api/ai/stream` + `/api/ai/invoke` full Zod conversion** (Agent 04 INFO 1) — would let `VALIDATION_FAILURE` events surface for these high-traffic routes too.
4. **Settings UI button for `signOut({ everywhere: true })`** (Agent 02 capability, no UI yet) — when added, wire `SESSION_SIGNOUT_ALL`.
5. **Per-call 8-char floor → 32 chars** on `verifyBackfillSecret` / `verifyDiscoverIngestSecret` / `verifyAdminIngestSecret` (Agent 05 open item #1) — once every prod deployment has rotated to 32-char values per `ROTATION_RUNBOOK.md`.
6. **xlsx → exceljs migration** (Agent 05 accepted risk #2) — closes 2 HIGH CVEs.
7. **react-quill → TipTap migration** (Agent 05 accepted risk #3) — closes 2 MODERATE CVEs.
8. **`VITE_ADMIN_EMAILS` policy decision** (Agent 05 INFO 1) — retain client-side flag vs. move to server-side `/api/account/me`.

## Findings for the human operator (post-handoff)

This is the final agent. There is no Agent 07. From here on:

- **Re-run this six-agent process every 6 months** or after any significant architecture change. The runbook + master report are the surface to update on each pass.
- **Wire a log aggregator** as soon as the operational budget allows. Until then, Render's log tail + `/api/admin/security/audit` are the detection surfaces.
- **Test the rotation script in staging** before the first real `CONNECTOR_TOKEN_KEY` rotation. Dry-run is mandatory, but a clean dry-run on production data is a different signal than a clean dry-run on staging — verify staging works first.
- **Watch for `auth.config_missing` and `secrets.validation_failure` events** — both are CRITICAL signals that a deploy is misconfigured. The pre-Agent-06 path failed silently in some configurations; the post-Agent-06 path emits.

---

*LYKN Security Plan — Agent 06 of 6 — Observability & Incident Response*
*Final agent. Six-agent plan complete.*
