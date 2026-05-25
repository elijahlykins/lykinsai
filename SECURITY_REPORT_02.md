# SECURITY_REPORT_02 — Authentication & Session Security

## Summary

LYKN's authentication surface was audited end-to-end and hardened in four targeted spots that fit the actual architecture (Supabase-Auth-fronted end-user identity + a hand-rolled OAuth 2.1 provider for outside MCP clients + per-user `lkn_live_…` PATs), not the self-rolled-Google-OAuth shape the original Agent 02 brief assumed. Two cron-secret comparisons were switched from variable-time `!==` to `crypto.timingSafeEqual`, the Supabase JWT middleware now fails closed in production when its env is missing, the connector OAuth callback popup now `postMessage`s only to the trusted frontend origin instead of `*`, and `signOut` gained an opt-in `everywhere: true` mode that calls Supabase's `scope: 'global'` for compromise-recovery use. No CRITICAL findings emerged: the userId trust boundary is clean (zero `req.body.userId` / `req.query.userId` patterns reach a data query in the production paths), every data-handling route is auth-gated, and the LYKN-as-OAuth-Provider flow already implements PKCE+S256, exact `redirect_uri` match, single-use auth codes, refresh rotation, and replay detection to spec.

## Authentication flow map (current state after changes)

**End-user login (Supabase, including Google):**

1. User clicks "Continue with Google" or submits email+password in `src/pages/Login.jsx`.
2. SPA calls `signInWithOAuth('google', ...)` or `signInWithEmail(...)` from `src/lib/SupabaseAuth.jsx`. The first delegates the entire OAuth round-trip — state, nonce, ID token validation, audience check, signature verification — to Supabase Auth. LYKN never sees a Google authorization code or ID token.
3. Supabase issues a session (access token ~1h, refresh token rotated by Supabase) and stores it in `localStorage` via the `@supabase/supabase-js` PKCE flow (or implicit flow on Safari, per `src/lib/supabase.ts`).
4. SPA's `onAuthStateChange('INITIAL_SESSION')` picks up the session and sets `user` state.
5. Every backend call attaches `Authorization: Bearer <supabase-jwt>`. `requireAuth` (`server.js:801`) calls Supabase `/auth/v1/user` to verify; on success `req.user.id` is the canonical userId for downstream queries. **After this pass:** if `SUPABASE_URL` / `SUPABASE_ANON_KEY` are missing, the middleware returns 503 in production instead of silently bypassing auth.

**MCP client login (LYKN as OAuth provider, in `oauth-server.js`):**

1. External client (Cursor, Claude.ai, ChatGPT) DCR-registers at `POST /oauth/register` (per-IP rate-limited, 30/hr).
2. Client redirects user's browser to `GET /oauth/authorize?...&code_challenge=...&code_challenge_method=S256`. PKCE is mandatory; non-S256 is rejected.
3. LYKN validates `client_id`, exact `redirect_uri` match, `response_type=code`, `code_challenge` length, scope intersection — then 302s to the SPA `/oauth/consent` page.
4. SPA shows the approve/deny UI to the (Supabase-authenticated) user, POSTs to `/oauth/authorize/decide` with the Supabase JWT.
5. On approve: server upserts a row in `lykn_oauth_consents` and inserts a single-use `lykn_oauth_authorization_code` (60s TTL, hashed at rest, bound to `(client, user, redirect_uri, code_challenge)`).
6. Client redeems at `POST /oauth/token` with `code` + `code_verifier`. Server PKCE-verifies (`crypto.timingSafeEqual`), mints an access token via `createMcpToken` (row in `lykn_mcp_tokens` with `oauth_client_id` + `oauth_consent_id` populated, 1h TTL) and — if `offline_access` was granted — a refresh token (30d TTL).
7. Refresh: `POST /oauth/token` with `grant_type=refresh_token` rotates both tokens; double-redemption outside a 10s grace window triggers `revokeRefreshFamily` (per RFC 6749 §10.4).

**PAT-style MCP token login:**

1. Logged-in user mints a token at `POST /api/v1/synthesis/tokens` (Supabase JWT only). Plaintext shown once; only SHA-256 hash persisted in `lykn_mcp_tokens`.
2. External client sends `Authorization: Bearer lkn_live_<random>`. `requireAuthOrMcpToken` (`mcp-service.js`) hashes, looks up by `token_hash`, sets `req.user.id` and `req.mcpAuth = { tokenId, scopes, clientKind, label }`.

**Authenticated request flow (post-auth):**

1. Auth middleware sets `req.user.id`.
2. Handler reads `req.user.id` and scopes every Supabase query / RPC by `user_id = req.user.id`. The MCP / REST mirror builds `ctx` via `buildToolCtx` / `buildContext` (server.js:6308 / mcp-server.js:207) — both pull from `req.user.id`, never from request input.

## Route audit

I enumerated every route registration in `server.js` (100 top-level matches) and `oauth-server.js`. Categorisation below.

`[AUTH]` — gated by `requireAuth` (Supabase JWT only):

- `/api/synthesis/{reindex,purge,refresh-profile,profile/status,intake,profile/facts,profile/facts/:id/feedback,profile/learn-now,profile/revisions}`
- `/api/account/{preferences (GET, PATCH),(DELETE /api/account)}`
- `/api/learned`, `/api/learned/auto`
- `/api/beliefs` (GET), `/api/beliefs/promote`, `/api/beliefs/:id/{ratify,retire}`, `/api/beliefs/:id` (PATCH), `/api/beliefs/manual`, `/api/beliefs/:id/propose-rules`
- `/api/rules/:id/{ratify,retire}`, `/api/rules/:id` (PATCH)
- `/api/applied`, `/api/applied/:id/feedback`
- `/api/v1/synthesis/{tokens (POST, GET, DELETE :id),activity}`
- `/api/v1/concepts` (GET, POST), `/api/v1/concepts/:id/links`, `/api/v1/concepts/:id` (PATCH), `/api/v1/concepts/:id/{merge,link}`
- `/api/discover/feed`
- `/api/vault/enrich-note`
- `/api/ai/{invoke,stream,vault-search,describe-image,transcribe,summarize-conversation,name-grid,name-chat,tts}`
- `/api/storage/signed-url`
- `/api/youtube/{search,video,transcript,transcript-priority,localize,retranscribe-segment,answer}`
- `/api/whisper/transcribe`
- `/api/{search,scrape,unfurl}`
- `/api/files/{extract-text,parse-spreadsheet,process,search}`
- `/api/feedback`
- `/api/usage/{me,session/:id,history}`
- `/api/admin/usage/{overview,users,users/:userId,recent,live,diagnostics,mcp}` (also gated by `requireAdmin` email allowlist)
- `/api/billing/{me,checkout,portal,waitlist (GET, POST)}`
- `/api/feeds` (GET, POST), `/api/feeds/discover`, `/api/feeds/:id` (PATCH, DELETE), `/api/feeds/:id/refresh`
- `/api/connections` (GET), `/api/connections/:provider/{start,connect-info,connect-token}`, `/api/connections/:id/{sync,(:id PATCH, DELETE)}`
- `/oauth/authorize/decide`

`[AUTH]` — gated by `requireAuthOrMcpToken` (JWT or `lkn_live_…` PAT):

- `/mcp` (POST + GET stream)
- `/api/v1/synthesis/{beliefs,rules,facts,vault/search,connections,neuron,context-block,projects/state,projects,activity,preferences (GET, POST),neurons/load,projects/:project_id/neurons,project/neurons,vault,attributions,beliefs/proposals,facts/proposals,projects/active,projects/state,projects/update,projects/delete,projects/neurons/{add,remove},links (GET, POST),concepts/touch}`

`[PUBLIC] — intentional`:

- `/api/client-error` — error reporter, idempotent log sink. Reason: must accept reports from anywhere, including pre-auth crashes.
- `/api/ai/models` — public model catalog used by the landing page.
- `/api/ai/stream-guest` — guest-mode demo. Has its own per-IP rate limiters (`guestAiGlobalLimiter`, `guestAiLimiter`, `guestAiHourlyLimiter`, `guestAiDailyLimiter`).
- `/api/stripe/webhook` — Stripe HMAC signature verified via `stripe.webhooks.constructEvent`. Mounted before `express.json` so the raw body bytes survive.
- `/api/discover/ingest` — gated by `verifyDiscoverIngestSecret` (already `crypto.timingSafeEqual`).
- `/api/synthesis/backfill` — gated by `verifyBackfillSecret` (already `crypto.timingSafeEqual`).
- `/api/feeds/poll-due` — **after this pass:** gated by `verifyAdminIngestSecret` (`crypto.timingSafeEqual`).
- `/api/connections/poll-due` — **after this pass:** gated by `verifyAdminIngestSecret`.
- `/oauth/callback/:provider` — connector OAuth landing. State CSRF validated server-side by `consumeOAuthState` (single-use, hashed lookup against `social_oauth_states`).
- `/oauth/{register,authorize,token,revoke,introspect,userinfo}` — RFC-compliant OAuth provider endpoints; intentionally public per spec, with their own auth gates (PKCE / `client_secret_basic` / token introspection requires confidential client).
- `/.well-known/{oauth-authorization-server,oauth-protected-resource,oauth-protected-resource/mcp,mcp.json}` — discovery documents.

`[CRITICAL]` — handles user data with no auth: **none**.

`[INFO]` — special cases:

- `/api/admin/usage/users/:userId` accepts a userId from the URL — that is the entire point (it is admin cross-user lookup), and is correctly gated by `requireAuth` + `requireAdmin` (email allowlist).
- `/api/synthesis/backfill` accepts `body.userId` to filter backfill — operator endpoint, gated by `BACKFILL_SECRET`. Accepted as service-layer behaviour.

## Changes made

| File | Change | CIA | Principle | Severity fixed |
|---|---|---|---|---|
| `server.js` | Added `verifyAdminIngestSecret` helper (`crypto.timingSafeEqual` against `ADMIN_INGEST_SECRET` ‖ `DISCOVER_INGEST_SECRET`); replaced plain `provided !== expected` checks in `/api/feeds/poll-due` (was line 14412) and `/api/connections/poll-due` (was line 14437). | Confidentiality, Integrity | KISS, SbD | HIGH (H1) |
| `server.js` | `requireAuth` (line ~801) now refuses with 503 in `NODE_ENV=production` when `SUPABASE_URL` / `SUPABASE_ANON_KEY` are missing, instead of silently calling `next()`. Dev fallback retained with a louder warn log. | Confidentiality | SbD ("private by default") | MEDIUM (M2) |
| `server.js` | `/oauth/callback/:provider` HTML now `postMessage`s the success/failure event to `new URL(CONNECTOR_FRONTEND_BASE).origin` instead of `'*'`. Falls back to `'*'` only if `CONNECTOR_FRONTEND_BASE` is malformed (with a console.warn), so misconfigured environments still ship the message rather than strand the popup. | Integrity, Confidentiality | LP, DiD | MEDIUM (M1) |
| `src/lib/SupabaseAuth.jsx` | `signOut` now accepts `{ everywhere = false }`. Default behaviour unchanged (`scope: 'local'`, current call sites are zero-arg and continue to get device-local sign-out). `signOut({ everywhere: true })` calls Supabase with `scope: 'global'` to revoke every refresh token across all of the user's devices. UI surface for this is intentionally not wired in this pass — capability first, button later. | Confidentiality | DiD, SoD | MEDIUM (M3) |

## Findings by severity

**CRITICAL:** none.

**HIGH:**

- **H1 — fixed.** `/api/feeds/poll-due` and `/api/connections/poll-due` used variable-time string compare (`!==`) on a long-lived shared cron secret. Switched to `crypto.timingSafeEqual` via the new `verifyAdminIngestSecret` helper, mirroring `verifyBackfillSecret` / `verifyDiscoverIngestSecret`.

**MEDIUM:**

- **M1 — fixed.** Connector OAuth callback popup `postMessage(payload, '*')` → pinned to the trusted frontend origin.
- **M2 — fixed.** `requireAuth` dev fallback was fail-open in production; switched to fail-closed in `NODE_ENV=production`, dev fallback retained with louder log.
- **M3 — fixed.** `signOut` left the in-flight access token valid until natural ~1h Supabase TTL because `scope: 'local'` only revokes the local refresh token. Added `signOut({ everywhere: true })` opt-in that calls `scope: 'global'`. Default unchanged so device-isolated sign-out still works as users expect.

**LOW:**

- **L1 — accepted, not changed.** OAuth-issued access tokens have a 1-hour TTL, exceeding the brief's 15-minute target. Kept because every Cursor / Claude.ai batched-tool burst would otherwise hit refresh on every nth call — 1h + replay-protected refresh is the more honest trade-off and matches Supabase's own default.

**INFO (out-of-scope-for-this-pass / handed off):**

- **INFO 1.** No HttpOnly / Secure / SameSite=Strict cookies — Supabase SDK uses `localStorage`. Switching to cookie-bound sessions is a major architecture change (would require a backend session-issue endpoint, browser hard-reload integration, and SDK fork or rip-and-replace), not a hardening pass. Documented for future architectural work.
- **INFO 2 — explicitly deferred.** `requireAuth` calls Supabase `/auth/v1/user` on every authenticated request: extra RTT per call, plus a single-point-of-failure for the API (Supabase outage → API auth dies). Proper fix is local JWT verification using the Supabase project's JWT secret with `/auth/v1/user` only as a signature-failure fallback. **Deferred at the project owner's direction** — touches every authenticated route and deserves its own focused PR with thorough integration testing, not a rider on a hardening pass.
- **INFO 3.** PKCE challenge round-trips through the SPA URL in the LYKN-as-OP flow. Compromised SPA could swap it; Agent 01's `script-src 'self'` CSP makes that impractical. Acceptable.
- **INFO 4.** `/oauth/userinfo` returns sub-only on email-fetch failure. Spec-compliant.

## CIA triad coverage

**Confidentiality:**

- Cron-secret extraction via timing side channel closed (H1).
- Production config-failure no longer fails open into "no auth on any route" (M2).
- Connector OAuth callback success/failure no longer leaks to arbitrary cross-origin pages (M1).
- Compromise-recovery sign-out path now exists end-to-end (M3).
- userId trust boundary verified clean: every `mcp-tools/*.js` reads `ctx.userId`, not `args.userId`; the only client-controlled userId in the codebase is `/api/admin/usage/users/:userId` which is admin-allowlisted, and `/api/synthesis/backfill` body.userId which is operator-secret-gated.

**Integrity:**

- Cron-secret comparison now timing-safe — secret can no longer be progressively recovered to forge poll-due requests.
- Connector OAuth `postMessage` origin pinned — third-party page can no longer be the recipient of a forged or replayed connection-success event.
- All OAuth provider endpoints already enforce: PKCE-S256 only, exact `redirect_uri` match, single-use auth codes, single-use refresh tokens with replay detection. Verified, not modified.

**Availability:**

- Production fail-closed (M2) explicitly trades one rare class of bug ("requests succeed when they should be 401-ing") for a more honest one ("503 with a clear error log"). The right call: a silent auth bypass is a reputational and regulatory event; a 503 is a paging signal that gets the on-call to look.
- `signOut({ everywhere: true })` adds a recovery lever the user previously had to file a support ticket for — net positive for legitimate-user availability after a credential-theft scare.

## Open items — need your review before Agent 03 starts

- **None blocking.** All four approved changes shipped. No new CRITICAL or HIGH findings outstanding.

Items to track but not block on:

- `INFO 2` (local JWT verification) is a real performance and resilience win when LYKN is ready to fold it in. Recommend its own PR.
- `M3` (`signOutEverywhere`) capability is wired but has no UI button. Recommend the Settings / Account page owner add a "Sign out of all devices" action that calls `signOut({ everywhere: true })`. Trivial follow-up.

## Findings for other agents

**Agent 03 (Data & DB):**

- Verify RLS on the OAuth provider tables: `lykn_oauth_clients`, `lykn_oauth_authorization_codes`, `lykn_oauth_refresh_tokens`, `lykn_oauth_consents`. These should be service-role-only with no `authenticated` role read access — even leaking hashed codes + PKCE challenges to the browser bundle would be embarrassing. `lykn_mcp_tokens` (migration 044) is correctly RLS'd today: SELECT/UPDATE/DELETE for `auth.uid() = user_id`, no INSERT policy (server-only mints).
- `supabaseAdmin` (service-role client) bypasses RLS by definition — every `supabaseAdmin.from(...)` call relies on the surrounding handler having scoped the query to `req.user.id`. This audit confirmed application-layer scoping is consistent in the auth-related code paths; the rest of the codebase still wants a sweep.
- The 8-character minimum length check in `verifyBackfillSecret` / `verifyDiscoverIngestSecret` / `verifyAdminIngestSecret` is too low — the production runbook should mandate ≥32 chars. Noted under Agent 05 as well.

**Agent 04 (API & App):**

- `/oauth/token` and `/oauth/register` are not protected by `express-rate-limit`. `/oauth/register` has its own per-IP cap (`MAX_REGISTRATIONS_PER_IP_PER_HOUR = 30` in `oauth-server.js`), but `/oauth/token` has nothing. Add a rate limiter keyed on `req.ip` (now truthful thanks to Agent 01's `trust proxy = 1`) to slow refresh-token brute-forcing and PKCE-verifier guessing.
- The brief asked for refresh-endpoint replay detection — already implemented in `oauth-server.js` (`revokeRefreshFamily`). No action needed beyond rate-limiting the surrounding route.
- Fail-closed `requireAuth` (M2) means a Supabase-env-misconfigured deploy returns 503 — make sure your synthetic checks don't false-positive that as a generic "API down" alert; 503 here means "auth provider unreachable" which is a different page than "API panicked".

**Agent 05 (Secrets & Supply Chain):**

- Cron secrets (`ADMIN_INGEST_SECRET`, `DISCOVER_INGEST_SECRET`, `BACKFILL_SECRET`) are accepted at minimum 8 chars. Production runbook should require ≥32 chars and document the rotation cadence. The minimum check should ideally be raised in code too, but only after the runbook is refreshed and rotated secrets are in place — bumping it without coordination would lock out any deploy still running an 8-char dev secret.
- `SUPABASE_SERVICE_ROLE_KEY` rotation cadence — Agent 01 confirmed it never appears in `VITE_*` env vars or `dist/`, but rotation discipline is yours.
- The OAuth client_secret hashing path (`oauth-server.js`'s `client_secret_hash`) uses bare SHA-256, not argon2 / bcrypt. Fine for a server-managed secret with high entropy (32 bytes), but document the rationale so a future contributor doesn't assume bcrypt-style hashing is in place.

**Agent 06 (Observability):**

- Auth events to log into a dedicated audit stream (not just `console.warn`):
  - Token mint (`POST /api/v1/synthesis/tokens`) — userId, tokenId, clientKind.
  - Token revoke (`DELETE /api/v1/synthesis/tokens/:id`) — userId, tokenId.
  - Refresh-token replay detection (`oauth-server.js`'s `revokeRefreshFamily` path) — currently a `console.error`; should be a structured row so Agent 06 can alert on it.
  - Failed `requireAuth` calls (currently `console.warn`).
  - The new fail-closed branch in `requireAuth` (M2) — currently `console.error`; alert on this immediately if it ever fires in production.
  - The new `verifyAdminIngestSecret` rejections — currently silent (returns 401). Adding a counter on these would surface a misconfigured cron or a probe.
- The `postMessage` origin-pin (M1) means a misconfigured `CONNECTOR_FRONTEND_BASE` will start console-warning. Pipe that warn-log into your alerting so a deploy with a typo'd env var gets caught.
