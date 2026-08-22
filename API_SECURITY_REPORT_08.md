# API_SECURITY_REPORT_08 — HTTP API Surface Review

**Status:** LOW risk overall — no CRITICAL or HIGH findings. Two LOW findings, both now **FIXED** (2026-08-21). Several confirmed-clean areas.
**Date:** 2026-08-21
**Scope:** `server.js` (195 routes), `oauth-server.js`, `lib/exterior/ssrfGuard.js`, `lib/customConnections/`, `validateSecrets.js`, cron/webhook/voice auth paths.
**Method:** Enumerated every `app.{get,post,put,patch,delete}` route, classified each by its auth middleware, and hand-traced the exceptions. Cross-checked authorization scoping against `supabase-migrations/` RLS policies and `SECURITY DEFINER` RPC bodies.

## Summary

The HTTP surface is in good shape. Every mutating endpoint is behind one of a small, well-defined set of gates — `requireAuth` (Supabase JWT), `requireAdmin` (email allowlist), a timing-safe cron bearer, or Stripe HMAC — and the handful of routes with no standard middleware each carry a purpose-built check that I verified. The controls that are easy to get wrong are all present and correct: CORS is a strict exact-match allowlist (not origin reflection), SSRF is guarded by a DNS-resolving private-IP blocker on the fetch paths that take external URLs, guest AI has layered per-IP limits plus a global hourly kill switch, and the production error handler never ships `err.message` or stack frames to clients.

The two findings below are both LOW: a small number of route-local `catch` blocks that echo an error string straight to the client (bypassing the safe global handler), and one cron endpoint whose destructive mode is gated correctly but worth a second control. Neither is cross-tenant or auth-bypassing.

This review is API-layer only. It builds on `SECURITY_REPORT_07.md` (the `supabaseAdmin`/RLS architecture), whose F-07-01 and F-07-02 are now fixed — the client-ordering flip from that report’s P2 is reflected here and does not introduce any new gap (verified: every flipped path either scopes by `user_id` in code or resolves under an owner-checked RLS policy / `auth.uid()` RPC).

## Findings

### F-08-01 — Route-local error handlers leak upstream/internal error strings (LOW) — FIXED

The global error handler (`server.js:~27950`) is correct — in production it returns a user-safe string and never `err.message` or `err.stack`. But several route `catch` blocks return before reaching it, echoing a raw error string to the client:

| Site | Returned to client |
|---|---|
| `server.js:13006` | `err?.message` from `/api/vault/reconcile` (cron-authed, so operator-only) |
| `server.js:24727`, `:24844` | `error?.message` from `/api/vault/save-image` and the generic file-save variant (authed users) |
| `server.js:25402`, `:25767` | `error?.message` from admin diagnostics / MCP admin (admin-only) |
| `server.js:23526` | `errText.slice(0, 2000)` — raw OpenAI upstream body from the ElevenLabs custom-LLM proxy |
| `server.js:23661`–`:23679` | `details: error.message` — raw YouTube API error strings on `/api/youtube/*` |

**Why LOW:** most sit behind `requireAuth`, `requireAdmin`, or the cron bearer, so the audience is already trusted, and the strings are upstream-API messages (OpenAI/YouTube) or app-level codes rather than stack traces or secrets. The residual risk is minor internal-detail disclosure (library versions, upstream request shapes) that could aid reconnaissance.

**Fix:** return a stable user-safe string and log the detail server-side, matching the global handler. For the two upstream proxies (`:23526`, `:23661`), forward a generic status message and keep the upstream body in `console.error` only.

**Remediation (done).** Added a `safeErr(err, fallback)` helper (`server.js:~1007`) that mirrors the global handler's prod/dev split — production callers get `fallback` only, dev keeps `err.message`, neither gets a stack. Applied it to all 12 route-local `catch` blocks that returned a raw message (the vault, admin, diagnostics, MCP-admin, and voice-screen routes). The ElevenLabs custom-LLM proxy (`:23526`) now returns `{ error: 'Upstream model request failed.' }` on the upstream status while still logging the OpenAI body and stashing it in the authed `_debug` endpoint. The YouTube handlers (`:23661`) dropped the `details` / `fullError` fields, keeping only the app-authored message and `videoId`. A static regression test (`lib/securityRegressions.test.mjs`) fails if any raw-message echo or `details:/fullError: data` forward reappears.

### F-08-02 — Vault reconciler’s delete mode relies on a single env flag (LOW / hardening) — FIXED

`/api/vault/reconcile` (`server.js:12974`) is correctly gated by the timing-safe `verifyBackfillSecret` cron bearer, and its destructive path is double-gated: `deleteLeaked` requires **both** the request body flag **and** `VAULT_RECONCILER_DELETE_ENABLED=1` in the environment. That’s a reasonable design. The note is that a permanent-delete capability reachable over HTTP rests entirely on one shared cron secret plus one env var — if the `BACKFILL_SECRET` ever leaks (it also authorizes `/api/synthesis/backfill`), an attacker with `VAULT_RECONCILER_DELETE_ENABLED` already set in prod could trigger deletion.

**Why LOW:** not reachable by a normal user, secret is 32-char timing-safe, and the delete flag defaults off. Pure defense-in-depth.

**Fix (optional):** give the reconciler its own secret distinct from `BACKFILL_SECRET`, or require a signed one-time nonce for the delete mode, so a single leaked bearer can’t both read and destroy.

**Remediation (done).** Destructive deletion now requires **three** independent conditions instead of two: the `deleteLeaked` request flag, the `VAULT_RECONCILER_DELETE_ENABLED=1` env, and a valid dedicated secret `VAULT_RECONCILER_DELETE_SECRET` presented in the `X-Reconciler-Delete-Token` header (verified timing-safe via the new `verifyReconcilerDeleteSecret`, ≥32 chars, fails closed when unset). The endpoint bearer stays `BACKFILL_SECRET`, but a leak of it alone can no longer trigger deletion — the request returns 403 without the delete token. The new secret is registered as optional-but-length-checked in `validateSecrets.js`, and a regression test asserts the three-way gate stays wired.

## Verified clean

**Route auth coverage.** All 195 routes classified. Every `:id` mutation route I sampled (`/api/beliefs/:id/*`, `/api/rules/:id/*`, `/api/custom-connections/:id`, `/api/feeds/:id/*`, `/api/connections/:id/*`, `/api/usage/session/:id`, `/api/v1/concepts/:id/*`, `/api/steward/items/:id`) scopes the lookup by `user_id` — either inline (`.eq('id', id).eq('user_id', userId)`) or inside a helper (`updateCustomConnection`, `deleteCustomConnection`, `getSessionWithLogs`) that does. No walk-up IDOR found.

**`SECURITY DEFINER` concept RPCs.** `concept_links` and `merge_concepts` are `SECURITY DEFINER` (they bypass RLS), but both authorize internally against `auth.uid()`: `concept_links` gates every branch on an `owner_ok` CTE plus per-row `user_id = auth.uid()`, and `merge_concepts` raises `not authorized` unless both concept ids belong to the caller. Under the service-role fallback `auth.uid()` is null, so they fail closed rather than open.

**CORS.** `server.js:705-800` — exact-match allowlist from `ALLOWED_ORIGINS`, dev-only loopback escape hatch disabled in prod, and Vercel previews pinned to LYKN’s own project regex (not a broad `*.vercel.app`). CORS headers are sent only inside the allow branch.

**SSRF.** `lib/exterior/ssrfGuard.js` resolves the hostname via DNS and rejects RFC-1918, loopback, and link-local (incl. `169.254.169.254` metadata), and re-checks on each redirect hop. Used by `safeFetch`/`assertUrlSafe` on the external-URL paths: RSS ingest (`rss-service.js`), custom connections (`customConnections.js:505,603`), web-fetch and image capabilities. The remaining raw `fetch()` calls target fixed provider hosts (Supabase REST, `googleapis.com`, Stripe) or connector APIs with a fixed base — not user-controlled origins.

**Cron / webhook / voice auth.** All three cron bearers (`verifyBackfillSecret`, `verifyAdminIngestSecret`, `verifyDiscoverIngestSecret`) use `crypto.timingSafeEqual`, enforce a 32-char minimum, and fail closed when unset. Stripe webhook verifies via `stripe.webhooks.constructEvent` on the raw body mounted before `express.json`. The ElevenLabs custom-LLM bearer and the voice session token (`verifyLyknVoiceToken`) are both HMAC/timing-safe with expiry; `VOICE_SESSION_SECRET` throws at boot in production if unset.

**MCP / OAuth tokens.** Stored as SHA-256 hashes, looked up by `token_hash` with `expires_at` / `revoked_at` checks (`oauth-server.js`). PKCE challenge verified with SHA-256. Per-token rate limiting keyed on `tokenId`.

**Body limits & rate limiting.** Global `express.json({ limit: '1mb' })`, 12mb only on image-bearing AI routes, 10kb on the client-log route. `trust proxy` set to 1 so IP-keyed limiters see the real client IP. Guest AI has per-minute/hour/day per-IP limits plus a server-wide hourly ceiling (`GUEST_AI_GLOBAL_HOURLY_MAX`, default 4000) as a bill-protection kill switch.

**Info disclosure.** Global error handler is production-safe. `/api/ai/models` exposes only boolean `enabled` flags, never key values. The ElevenLabs `_debug` endpoint requires the bearer and returns only counters. Service-role key confirmed not client-reachable in `SECURITY_REPORT_07`.

**Input sanitization.** Guest and chat prompt paths run `sanitizeUserContentWithCount` to strip tool-call / system-prompt-injection syntax before the prompt-builder, with a length cap; page context is sanitized and truncated before use.

## Residual unknowns

- **Production RLS parity.** The client-ordering flip (SECURITY_REPORT_07 P2) makes several server-only tables (`lykn_synthesis_chunks`, `lykn_user_model_facts`, `lykn_beliefs`, `lykn_rules`) depend on their prod RLS policies being live. The migrations define them; a read-only `pg_policies` check before/after deploy is the confirming step (already flagged in report 07).
- **`ALLOWED_ORIGINS` in prod.** The allowlist is correct as written, but its effective value is an env var. Worth confirming the deployed value matches the intended origin set and hasn’t been widened.
- **Rate-limiter store.** Limiters are in-memory (`express-rate-limit` default). On a multi-instance deploy each instance keeps its own counters, so effective limits scale with instance count. Fine for a single Render instance; revisit if horizontally scaled.
