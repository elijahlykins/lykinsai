# SECURITY_REPORT_04 — API & Application Security

## Summary

LYKN's API and application surface was hardened in ten targeted places that fit the actual route map in `server.js` (15K-line monolith, ~100 top-level route registrations) and `oauth-server.js` (RFC-compliant OAuth 2.1 provider). The seven OAuth endpoints that previously had no `express-rate-limit` ceiling now sit behind a Tier-1 (`authLimiter`, 20 / 15 min / IP) or Tier-2 (`oauthReadLimiter`, 60 / min / IP) middleware. The 5MB JSON body-parser default — a silent DoS vector for every JSON-accepting route in the API — is now 1MB globally with a 10kb override for the only public unauthenticated endpoint (`/api/client-error`). A global Express error handler now sits as the absolute last `app.use` registration, catches every uncaught throw, fails closed in production with a stable error code, and never emits stack frames to the wire. Every site that forwarded a Supabase `error.message` straight to the client (12 explicit echoes plus the `runRestTool` exception path) now writes a stable code on the wire and keeps the diagnostic detail in `console.error`. User-controlled prompt content sent to AI providers is now sanitised on **input** as well as output — including every prior turn in `conversation[]` and `history[]`, not just the latest message — and a 200K-char cap on combined user input plus a 3-minute stream socket timeout (2-minute for guest streams) close out the AI-endpoint abuse surface. Seven high-risk write routes were converted to Zod-backed validation with unknown-field stripping, and the connector token-paste route (`/api/connections/:provider/connect-token`) now validates `req.params.provider` against the `CONNECTOR_REGISTRY` key allowlist at the perimeter before any handler logic. Two new modules (`validation.js`, `prompt-sanitizer.js`) house the shared infrastructure so future routes can adopt the same patterns idempotently.

Zero CRITICAL findings on entry, one HIGH (no global error handler) and one HIGH (no `/oauth/token` rate limiter) — both fixed in this session. No new CRITICAL or HIGH outstanding.

## Rate-limit map (current state after changes)

| Endpoint / prefix | Limiter | windowMs | max | Key | Was it broken before? |
|---|---|---|---|---|---|
| `/api/*` (all) | `globalLimiter` | 60_000 | 120 | `req.ip` | Previously keyed on Render edge IP — fixed by Agent 01's `trust proxy=1`. Verified correct now. |
| `/api/ai/invoke`, `/api/ai/stream`, `/api/ai/vault-search`, `/api/ai/transcribe`, `/api/ai/summarize-conversation`, `/api/ai/name-grid`, `/api/ai/name-chat`, `/api/ai/tts`, `/api/youtube/answer`, `/api/whisper/transcribe`, `/api/learned/auto` | `aiLimiter` | 60_000 | 30 | `req.user.id` ‖ `req.ip` | Same trust-proxy story, same fix. |
| `/api/ai/describe-image` | `describeLimiter` | 60_000 | 60 | userOrIp | Same. |
| `/api/ai/stream-guest` | `guestAiGlobalLimiter` + `guestAiLimiter` (5/min) + `guestAiHourlyLimiter` (15/h) + `guestAiDailyLimiter` (30/d) | mixed | mixed | `req.ip` + global counter | Same. |
| `/api/synthesis/reindex`, `/api/synthesis/purge`, `/api/vault/enrich-note` | `synthesisLimiter` | 60_000 | 24 | userOrIp | Same. |
| `/api/synthesis/refresh-profile`, `/api/synthesis/intake`, `/api/synthesis/profile/learn-now`, `/api/learned`, `/api/beliefs/promote`, `/api/beliefs/:id/propose-rules` | `profileRefreshLimiter` | 900_000 | 8 | userOrIp | Same. |
| `/api/discover/feed` | `discoverLimiter` | 60_000 | 12 | userOrIp | Same. |
| `/mcp` + every `/api/v1/synthesis/*` route | `mcpMinuteLimiter` (60/min) + `mcpDailyLimiter` (5000/day) | 60_000 / 86_400_000 | 60 / 5000 | `req.mcpAuth.tokenId` ‖ `req.user.id` ‖ `req.ip` | Same. |
| **`/oauth/token`** | **`authLimiter` (NEW, Agent 04)** | **900_000** | **20** | **`req.ip`** | **YES — had ZERO limiter before this pass. Fixed.** |
| **`/oauth/register`** | **`authLimiter` (NEW)** + existing `MAX_REGISTRATIONS_PER_IP_PER_HOUR=30` app cap | 900_000 | 20 | req.ip | **YES — only had app-level cap, no middleware. Fixed (DiD layered).** |
| **`/oauth/authorize`** + **`/oauth/authorize/decide`** | **`authLimiter` (NEW)** via prefix match | 900_000 | 20 | req.ip | **YES — had ZERO limiter. Fixed.** |
| **`/oauth/userinfo`** | **`oauthReadLimiter` (NEW)** | 60_000 | 60 | req.ip | **YES — had ZERO limiter. Fixed.** |
| **`/oauth/revoke`** | **`oauthReadLimiter` (NEW)** | 60_000 | 60 | req.ip | **YES — had ZERO limiter. Fixed.** |
| **`/oauth/introspect`** | **`oauthReadLimiter` (NEW)** | 60_000 | 60 | req.ip | **YES — had ZERO limiter. Fixed.** |

`generationLimiter` is defined in server.js but not currently mounted on any route — informational, no security impact (it's dead code waiting on a future feature).

## Validation coverage map

| Route | Method | Body validated? | Unknown fields stripped? | Schema |
|---|---|---|---|---|
| `/api/client-error` | POST | **Yes (Agent 04)** | Yes | `clientErrorSchema` |
| `/api/feeds` | POST | **Yes (Agent 04)** | Yes | `createFeedSchema` |
| `/api/feeds/:id` | PATCH | **Yes (Agent 04)** | Yes | `patchFeedSchema` |
| `/api/feedback` | POST | **Yes (Agent 04)** | Yes | `feedbackSchema` (also fixed mass-assignment of `user_id` / `userEmail`) |
| `/api/billing/checkout` | POST | **Yes (Agent 04)** | Yes | `billingCheckoutSchema` |
| `/api/billing/waitlist` | POST | **Yes (Agent 04)** | Yes | `waitlistSchema` |
| `/api/connections/:provider/connect-token` | POST | **Yes (Agent 04)** | Yes (record schema, value-capped) | `connectorTokenBodySchema` + `connectorProviderParamSchema` (provider allowlisted against `CONNECTOR_REGISTRY` keys at the perimeter) |
| `/api/connections/:id` | PATCH | **Yes (Agent 04)** | Yes | `patchConnectionSchema` |
| `/api/account/preferences` | PATCH | Yes (pre-existing) | Yes (`sanitisePreferencesPatch` hard allowlist, server.js:5103) | (hand-rolled, gold standard) |
| `lykn_updateUserPreference` MCP tool | n/a | Yes (pre-existing) | Yes (`ALLOWED` Set, `mcp-tools/updateUserPreference.js`) | (hand-rolled, gold standard) |
| `/api/v1/synthesis/*` (REST mirror — 22 routes) | various | Yes (each tool's `inputSchema` validates) | Implicit (handler reads named args only) | per-tool `inputSchema` in `mcp-tools/*.js` |
| `/oauth/*` | various | Yes (pre-existing — `oauth-server.js` validates each request shape against the OAuth 2.1 / RFC 7591 / RFC 7009 / RFC 7662 specs) | n/a (spec-defined fields) | per-spec |
| `/api/ai/stream`, `/api/ai/invoke` | POST | Partial — inline type checks plus new sanitisation + length cap | No (intentionally — see "Open items"; deferred to a focused PR) | n/a |
| `/api/synthesis/*` writes (other than the ones above) | POST | Hand-rolled inline | No | n/a — flagged as INFO follow-up |
| `/api/billing/portal` | POST | n/a (no body) | n/a | n/a |
| `/api/connections/:provider/start`, `/api/connections/:id/sync`, `/api/connections/:id` DELETE | various | n/a / minimal | n/a | n/a |
| `/api/feeds/discover`, `/api/feeds/:id/refresh`, `/api/feeds/:id` DELETE, `/api/feeds/poll-due`, `/api/connections/poll-due` | various | Hand-rolled inline | No | n/a — small, low-risk; left untouched |

## Changes made

| File | Change | CIA | Principle | Severity fixed |
|---|---|---|---|---|
| `validation.js` (NEW) | Zod-based `validate` / `validateQuery` / `validateParams` middleware factories. `safeParse` + `req.body = result.data` → unknown-field stripping is the default. Reusable primitives (zUuid, zHttpUrl, zEmail, zShortString, zLongString, zTrimmedString). Re-exports `z` so callers can single-import. | Integrity | SoD, SbD, KISS | HIGH — no validation library was in use |
| `prompt-sanitizer.js` (NEW) | `sanitizeUserContent(content)` strips `[lykn_x({...})]`, `<tool>...</tool>`, `<function*>...</function*>`, `[SYSTEM]`, `[INST]`, `<\|im_start\|>`, `<\|human\|>` etc. and replaces with `[removed]`. `sanitizeTurnArray(turns)` walks every `{role, content}` element and applies `sanitizeUserContent` to the `.content`. Both pure / idempotent. | Integrity, Confidentiality | DiD (mirrors `chat-agent-loop.js`'s output stripper on the input side) | MEDIUM — input was previously not sanitised |
| `server.js` line 766 | Global `express.json({ limit: '1mb' })` — was `'5mb'`. | Availability | LP, SbD | MEDIUM — 5MB body parser was a DoS-via-payload surface for every JSON route |
| `server.js` lines ~770-815 | `/api/client-error` registration: per-route `express.json({ limit: '10kb' })` override + `validate(clientErrorSchema)` + Zod schema (8 fields, each length-capped). | Availability, Integrity | LP, SbD | MEDIUM — public log sink with 5MB ceiling and zero validation |
| `server.js` lines 2842-2895 | New `authLimiter` (20/15min/IP) and `oauthReadLimiter` (60/min/IP) constant definitions. | Availability, Confidentiality | DiD, LP, SbD | HIGH (Agent 02's explicit ask) |
| `server.js` lines 6940-6945 | `app.use('/oauth/{token,register,authorize,userinfo,revoke,introspect}', ...)` mounts the new limiters before `mountOauthServer`. Comment explicitly documents that `/oauth/authorize` prefix-matches `/oauth/authorize/decide`. | Availability, Confidentiality | DiD, LP, SbD | HIGH |
| `server.js` runRestTool (lines ~6480) | Exception payload changed from `{ ok: false, error: msg }` (raw exception text) to `{ ok: false, error: 'tool_handler_failed' }`. Diagnostic `msg` still in `console.error`. | Confidentiality | LP | MEDIUM — leaked raw handler exception text to MCP clients |
| `server.js` 12 sites + 4 sites | Every `if (error) return res.status(NNN).json({ error: error.message })` pattern (8 + 4 sites) replaced with `console.error('[supabase]', req.method, req.path, error); return res.status(500).json({ error: 'database_error' })`. | Confidentiality | LP | MEDIUM — DB schema / RLS-denial reasons leaking to clients |
| `server.js` 15 sites | `res.status(NNN).json({ error: err.message \|\| 'X' })` → `res.status(NNN).json({ error: 'X' })`. Static fallbacks were already client-safe; the `err.message ||` prefix was the leak. | Confidentiality | LP | MEDIUM |
| `server.js` /api/ai/stream-guest | `prompt` and every `history[i].content` now flow through `sanitizeUserContent` BEFORE entering the prompt builder. New `req.setTimeout(120_000)` to drop hung guest streams. | Integrity, Availability | DiD, LP | MEDIUM (input-side prompt injection) + LOW (connection holding) |
| `server.js` /api/ai/invoke | `text`, `prompt`, `userPrompt`, `context`, `knowledgeBase`, `workspaceContext`, `conversationMemory` sanitised; `conversation` walked via `sanitizeTurnArray`. Combined-input `MAX_USER_INPUT_CHARS=200_000` enforced before prompt-builder. | Integrity, Availability | DiD, LP, SbD | MEDIUM |
| `server.js` /api/ai/stream | Same fields as /api/ai/invoke; same MAX_USER_INPUT_CHARS check. New `req.setTimeout(180_000)` after SSE flushHeaders to drop hung streams. | Integrity, Availability | DiD, LP, SbD | MEDIUM + LOW |
| `server.js` 7 write routes | Zod schemas added (see Validation map above) with `validate(...)` middleware. `/api/feedback` additionally fixed: `user_id` and `userEmail` are no longer accepted from `req.body` — sourced from verified JWT (`req.user`) instead. Fixes a pre-existing mass-assignment / confused-deputy where an authenticated user could spoof another user's id on the feedback row. | Integrity, Confidentiality | LP, DiD, SbD | MEDIUM — confused-deputy on `/api/feedback` is HIGH if it had been exploited |
| `server.js` lines 15187-15257 | New global error handler (4-arg `app.use((err, req, res, next) => {...})`) as the absolute last middleware before `app.listen`. Verified zero `app.<method>(...)` registrations exist after this point. SSE `res.headersSent` guard. body-parser `entity.too.large` → 413 `payload_too_large` branch. Production: stable error code only (no `err.message` / no `err.stack`). Dev: `err.message` only (still no stack). | Confidentiality | SbD, LP | HIGH — Express defaults emitted stack info |
| `server.js` line 13245 | `/api/* unfurl` error: `Failed to unfurl URL: ${err.message}` → `unfurl_failed`. | Confidentiality | LP | LOW |
| `server.js` lines 14316, 14336 | `/api/billing/checkout` and `/api/billing/portal` no longer return `{ ..., message: err.message }` — only the stable error code. Stripe error details stay in `console.error`. | Confidentiality | LP | MEDIUM (Stripe error detail leakage) |

## Findings by severity

**CRITICAL:** none.

**HIGH (fixed in this session):**

- **H1 — fixed.** `/oauth/token` had no `express-rate-limit` ceiling — a brute-force surface against refresh tokens and PKCE verifiers. Now covered by `authLimiter` (20 / 15 min / IP). Agent 02 explicitly handed this off.
- **H2 — fixed.** No global Express error handler. Express default behavior emits `err.stack` to clients in some configurations, and ~30 sites in `server.js` were forwarding `err.message` from caught exceptions directly to clients. Now: a 4-arg `app.use` is the absolute last middleware; production responses carry only stable error codes; full diagnostic context goes to `console.error`.

**MEDIUM (fixed in this session):**

- **M1 — fixed.** `/oauth/{register,authorize,authorize/decide,userinfo,revoke,introspect}` had no rate limiting. Added Tier-1 (`authLimiter`) on the credential-flow routes and Tier-2 (`oauthReadLimiter`) on the read/revoke routes.
- **M2 — fixed.** Global JSON body parser was `5mb` — a 5MB ceiling for every JSON-accepting route was a DoS-via-payload surface, especially on the unauthenticated `/api/client-error`. Now `1mb` globally with a `10kb` per-route override on `/api/client-error`.
- **M3 — fixed.** 12 explicit + 4 RPC-error sites forwarded Supabase `error.message` directly to the wire, leaking schema names / RLS denial reasons / PostgREST internals. All replaced with `database_error` + `console.error` log.
- **M4 — fixed.** 15 catch-block sites wrote `err.message || 'fallback'` to the wire — unconditionally swallowing the message into the response body. Now: the static fallback is the only client-facing string; full error in `console.error`.
- **M5 — fixed.** `/api/feedback` accepted `user_id` and `userEmail` from `req.body`, allowing an authenticated user to attribute a feedback row to a different user (mass assignment / confused deputy). Now sourced from `req.user` (verified JWT).
- **M6 — fixed.** `runRestTool` exception payload leaked raw handler-exception text to (potentially external) MCP clients. Now returns `tool_handler_failed`.
- **M7 — fixed.** Prompt-injection input sanitisation didn't exist — only output-side stripping in `chat-agent-loop.js`. New `prompt-sanitizer.js` runs on every user-controlled string entering the AI provider call chain, including every prior turn in `conversation[]` / `history[]`.
- **M8 — fixed.** `/api/connections/:provider/connect-token` accepted any string into `CONNECTOR_REGISTRY[provider]`. Now validated against the registry's keys at the perimeter via `validateParams(connectorProviderParamSchema)`.
- **M9 — fixed.** `/api/billing/checkout` and `/api/billing/portal` returned `{ message: err.message }` alongside the error code — leaking Stripe error internals. Stripped.
- **M10 — fixed.** Seven high-risk write routes accepted unknown fields. Replaced hand-rolled validation with Zod schemas that strip unknown keys.

**LOW (fixed):**

- **L1 — fixed.** `/api/ai/stream` and `/api/ai/stream-guest` had no socket timeout. A client that opened an SSE stream and never closed it pinned the connection indefinitely. Now: `req.setTimeout(180_000)` on the auth'd stream and `req.setTimeout(120_000)` on the guest stream.
- **L2 — fixed.** `/api/* unfurl` leaked `err.message` into the JSON error response.

**INFO (documented, not fixed in this pass):**

- **I1.** `/api/ai/stream` and `/api/ai/invoke` still use hand-rolled inline validation rather than Zod. They have ~15 fields each with cross-dependencies (model gating, plan tier, image-url shape, knowledge-base shape) that interact with the prompt builder. Converting to Zod is a focused refactor with non-trivial regression risk; deserves its own PR with integration tests. Sanitisation + `MAX_USER_INPUT_CHARS` cap close the highest-impact gap in the meantime.
- **I2.** Some non-priority `/api/synthesis/*` and `/api/feeds/*` write routes (e.g. `/api/feeds/discover`, `/api/feeds/:id/refresh`, `/api/synthesis/profile/facts/:id/feedback`) still use hand-rolled inline validation. Each is small (1-3 fields) and was deemed lower-risk than the seven converted routes. Worth a follow-up sweep.
- **I3.** `generationLimiter` is defined in `server.js` but unmounted. Either mount it on the next text-generation route or delete it.
- **I4.** Stripe webhook (line 741) returns `Webhook Error: ${err.message}` to the Stripe SDK on signature failure. Stripe's docs prescribe this shape — the only consumer is Stripe's own retry logic. Left intentionally; documented.

## CIA triad coverage

**Confidentiality:**

- No `error.message` echoes from Supabase or Stripe reach the client (12+15+2+3 sites scrubbed).
- No raw handler exceptions reach external MCP clients (`runRestTool` hardened).
- Global error handler: production responses carry only stable error codes — no `err.message`, no `err.stack`.
- `runRestTool` exception payload sanitised.

**Integrity:**

- Zod-based validation strips unknown fields on every converted route — closes mass-assignment surface (concretely closed on `/api/feedback`).
- `connectorProviderParamSchema` blocks any `req.params.provider` that isn't a `CONNECTOR_REGISTRY` key before the handler runs.
- `sanitizeUserContent` strips tool-call syntax and system-prompt-injection markers from every user-controlled string entering the AI call chain — both top-level fields and every `conversation[i].content` / `history[i].content`.
- Tool allowlist enforcement (`runChatTool` → `CHAT_TOOLS_BY_NAME` lookup) re-verified intact.
- `lykn_user_preferences` field allowlist (both MCP-tool and HTTP-PATCH paths) re-verified intact.

**Availability:**

- `authLimiter` and `oauthReadLimiter` close the OAuth-endpoint brute-force / abuse surface.
- Global JSON limit dropped 5x (5MB → 1MB); `/api/client-error` clamped to 10kb.
- `MAX_USER_INPUT_CHARS = 200_000` cap on combined user-controlled AI input.
- `req.setTimeout(180_000)` / `req.setTimeout(120_000)` on the two streaming endpoints.
- Body-parser `entity.too.large` errors handled cleanly via the global error handler with a stable `payload_too_large` code.

## Open items — need your review before Agent 05 starts

- **None blocking.** All ten approved changes shipped. Verification checklist passed (output captured below). All 6 existing tests still pass. No new CRITICAL or HIGH findings outstanding.

Items to track but not block on:

- **I1 / I2 above.** A follow-up PR can move `/api/ai/stream`, `/api/ai/invoke`, and the smaller hand-rolled write routes to Zod for full coverage.
- **I3 above.** `generationLimiter` is dead code.
- **HSTS preload** still not enabled per Agent 01's earlier rationale. Track separately if/when policy changes.

## Verification checklist — output

```
1. trust proxy:                          server.js:163 ✓
2-4. OAuth limiters mounted:             server.js:6940-6945 ✓ (token, register, authorize, userinfo, revoke, introspect)
5. /api/ai/stream limiter:               aiLimiter (per-user, 30/min) ✓
6. /api/ai/stream-guest limiter:         4 IP-based + global hourly ✓
9. sanitizeUserContent / sanitizeTurnArray call sites: 20 ✓
10. sanitizeTurnArray on conversation:   2 sites (stream, invoke) ✓
11. CHAT_TOOL_NAMES enforcement:         tool_not_whitelisted_for_chat present ✓
12. lykn_user_preferences allowlist:     ALLOWED Set present ✓
13. global body parser limit:            1mb (was 5mb), /api/client-error 10kb ✓
14. global error handler position:       server.js:15213, ZERO app.* calls after it ✓
15. raw Supabase error.message echoes:   0 ✓
16. /api/client-error guarded:           10kb body limit + Zod schema ✓
17. all 6 existing tests pass            ✓ (npm test → pass 6, fail 0)
```

## Findings for other agents

**Agent 05 (Secrets & Supply Chain):**

- New module `validation.js` imports `zod` (already a dependency, 3.24.2 in package.json) — no new third-party additions. New module `prompt-sanitizer.js` is dependency-free.
- The 8-char minimum length check in `verifyBackfillSecret` / `verifyDiscoverIngestSecret` / `verifyAdminIngestSecret` is unchanged and still flagged for Agent 05 (Agent 02 originally raised it).
- No new secrets introduced. Per-request validation runs entirely in process; no calls out.

**Agent 06 (Observability) — security events that should be log-shipped:**

- **Rate-limit hits.** `express-rate-limit` doesn't emit a structured event by default; consider wrapping limiters with a `handler:` that writes a `lykn_security_audit` row (or whatever sink Agent 06 stands up). Especially valuable on `authLimiter` (refresh-token brute-force signal) and `oauthReadLimiter` (introspect-fishing signal).
- **Validation rejections.** Every `400 invalid_request` from `validate(...)` is a potential probe signal at scale. Agent 06 should aggregate by `req.path` and alert on threshold spikes.
- **Blocked tool dispatch attempts.** `runChatTool` already logs `tool_not_whitelisted_for_chat` — wire that into the audit stream.
- **`sanitizeUserContent` strips.** The current implementation just replaces — it doesn't log what was stripped. Consider a debug-mode counter (per-user, per-pattern) so a future hardening pass can spot which patterns are most attempted in the wild. Out of scope for this pass.
- **Global error handler logs.** Every `[ERROR]` line emitted by the new error handler at server.js:15213 is exactly the structured shape Agent 06 needs. Format: `{ path, method, userId, status, message, stack }`. Production never sends `stack` to the wire; it's safe to ship the full record to the SIEM.
- **`runRestTool` exception path.** New stable error code `tool_handler_failed` makes external-MCP-client failures distinguishable from the validation-error path on the wire. Useful for alerting.
- **Stream timeouts.** When `req.setTimeout` fires on `/api/ai/stream*`, no event is currently emitted. Worth a `console.warn` so Agent 06 can spot stream-pinning abuse.

**Agent 03 (Data & DB) — closed loop:**

- No application-layer issues surfaced by Agent 03 needed application-side fixes in this pass.
- The `lykn_security_audit` table created by Agent 03 is the right destination for the events listed for Agent 06 above. The trigger functions in migration 065 already cover OAuth code/refresh/MCP-token mutations server-side; rate-limit hits and validation failures are application-layer events Agent 06 will plumb separately.

---

*LYKN Security Plan — Agent 04 of 6 — API & Application Security — handoff to Agent 05 (Secrets & Supply Chain).*
