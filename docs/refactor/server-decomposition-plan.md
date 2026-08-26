# server.js Decomposition Plan

**Status:** Analysis only — no code has been changed. This is the plan for a future refactor agent.
**Audited:** 2026-08-25, against `server.js` at 27,839 lines (working tree, unstaged frontend work by other agents present but no server changes).
**Absolute goal:** take `server.js` from ~27,800 lines to a small bootstrap/orchestration file with **zero runtime behavior change**.

---

## 1. Route count (exact)

- **160** routes registered directly on `app` in `server.js` (`app.get/post/patch/delete`, all at column 0, verified by anchored scan — the "~160" from the prior audit is exact).
- **+1** route registered via the existing `registerCustomModelRoutes(app, { requireAuth, supabaseAdmin })` call at line 10253 (`custom-models-routes.js` → `GET /api/v1/custom-models/published`).
- **7** `app.use(...)` mounts: artifacts-host gate (318), security headers (335), CORS (777), branching JSON parser (987), `app.use('/api/', globalLimiter)` (4662), global error handler (27641), plus `app.disable('x-powered-by')` / `app.set('trust proxy', 1)` settings.
- **~250 top-level functions** (229 `function` declarations + ~20 top-level arrow/const functions; the prior audit's ~310 includes nested ones).
- No `express.Router()` instances exist anywhere; everything is registered flat on `app`.
- No WebSockets in this file (realtime voice mints WebRTC/ElevenLabs session tokens; the media stream never touches this server).

---

## 2. Section map (verified against banners + actual code)

Line ranges are approximate ±5 lines; all verified by reading, not just banner-trusting.

| Lines | Contents |
|---|---|
| 1–290 | ~90 imports from ~50 local modules + npm; `validateSecrets()`; env-check boot logging |
| 292–397 | Perimeter hardening: `x-powered-by` off, `trust proxy 1`, artifacts-host gate (`app.use`), security headers CSP/HSTS/COOP (`app.use`, with `/oauth/` path relaxation), `PORT`, `upload` (multer, 50 MB memory storage) |
| 400–697 | Web-search/scrape intent heuristics, `classifyEnrichment`, `isTrivialTurn`, YouTube search enrichment |
| 699–808 | Manual CORS allowlist middleware (`app.use`), handles OPTIONS 204 |
| 810–954 | Stripe client init, price maps, comped-accounts set, **`POST /api/stripe/webhook` with `express.raw` — mounted BEFORE the JSON parser** |
| 956–1002 | Branching JSON parser (`standardJsonParser` 1 MB vs `imageJsonParser` 12 MB keyed on `IMAGE_BEARING_AI_ROUTES` set), `safeErr` |
| 1004–1070 | `POST /api/client-error` (public, own 10 kb parser + zod) |
| 1072–1158 | `GET /api/health` (public; render.yaml healthCheckPath) |
| 1160–1311 | **Auth core**: `supabaseAdmin` created (1167), security-logger sink + validation hook wiring, `sanitizePromptBundle`, `requireAuth` (1228), `app.set('supabaseAdmin', supabaseAdmin)` (1311) |
| 1313–1452 | File download proxy `GET /f/:token` (`FILE_PROXY_ROUTE`, HMAC-token auth, per-response header un-hardening), `POST /api/artifacts/react/rebuild` |
| 1454–1478 | `requireAdmin` (ADMIN_EMAILS allowlist) |
| 1480–1687 | Utilities: `sha256`, `memCache` factory (`_memCaches`), stale-surface sanitizer, `splitPromptForProvider`, Gemini context caching (`_geminiCacheInflight` Map) |
| 1689–1797 | Output token caps: `getProviderForModel`, `clampForProvider`, `pickOutputCap` |
| 1799–2932 | **Synthesis retrieval + embed/store**: query embedding, chunk-window expansion, BM25 vault rows, `fetchSynthesisRetrievalSection`, connected-source URL→vault lookup, Notion live re-fetch, `openAiEmbedMany`, `replaceSynthesisChunks` |
| 2934–3678 | **User synthesis profile**: 8 per-user module-level cache Maps (see §5), `fetch{UserModel,Belief,Project,ConnectedTools}Section`, `invalidate*Cache` fns, custom-model chat loaders, intake synthesis |
| 3680–4460 | User identity block, voice-mode opening lines, `gatherVoiceBriefingData` (~220 lines), `runUserProfileLlmAndUpsert` |
| 4461–4723 | **Rate limiting**: 12 limiters + `guestAiGlobalLimiter` (hand-rolled counter), `app.use('/api/', globalLimiter)` at 4662, `checkAiUsageLimit` (forward-references billing fns at 25671+ via hoisting) |
| 4725–4738 | SSRF wrapper `isUrlSafe` |
| 4740–5184 | Unhandled-rejection net, `internalHeaders`, **`MODEL_CATALOG`** (4753), fallback chain (`getFallbackModels`, `RETRYABLE_STATUSES`), `AI_TEMPORARY_FAILURE_TEXT` (4999, used by the global error handler at 27689), `extractPureUserMessage` |
| 5185–5336 | `GET /api/ai/models` |
| 5337–5838 | Memory-model intent gates (`messageWants*`, `resolveIntentChatToolNames`) |
| 5839–6427 | Static auth-chat persona (large template strings) |
| 6428–7565 | Response-length note, **`localToolStreams` Map** (6457) + register/release/resolve fns, chat tool guidance, artifact/image intent detection, `AI_BUDGETS` (8175 nearby) |
| 7566–8284 | `POST /api/ai/stream-guest` — ~720-line public SSE route |
| 8285–8529 | Synthesis routes: reindex, purge, refresh-profile, profile status/facts, intake, learn-now |
| 8531–8955 | Account: preferences GET/PATCH, night-shift briefs, steward items, `DELETE /api/account` |
| 8957–9021 | Apple SIWA token exchange, `POST /api/metrics/ingest` |
| 9023–9521 | Live learn: `POST /api/learned`, user-facts v2 CRUD, `/api/learned/auto` (`autoLearnVerdictCache`) |
| 9523–10125 | Belief window: beliefs/rules CRUD, `/api/v1/synthesis/activity`, applied-rule feedback, `/api/ai/feedback` |
| 10127–10543 | `buildToolCtx`, custom-connections CRUD, **`registerCustomModelRoutes(app, …)` call (10253)**, concepts v1 routes |
| 10545–12191 | **Discover**: ~1,650 lines — query planning, Serper news/organic/video fetchers, ranking, thumbnail backfill, cursors, `POST /api/discover/feed`, secret-gated `POST /api/discover/ingest` |
| 12193–12881 | Vault enrichment: `indexVaultNoteForSearch`, **`enrichVaultNoteSummary`** (12248; exported at 27710, lazily imported back by `connectors/notion.js`), secret verifiers (`timingSafeEqualStr`, `verifyBackfillSecret`), `POST /api/vault/enrich-note`, `/api/vault/reconcile`, `/api/synthesis/backfill` |
| 12882–14683 | **`POST /api/ai/invoke`** — ~1,800-line non-streaming chat route |
| 14684–14697 | `POST /api/ai/local-tool-result` (writes into `localToolStreams`) |
| 14698–18291 | **`POST /api/ai/stream`** — ~3,594-line SSE agent-loop route (per-request `stallCheck`/`heartbeat`/`attemptWatchdog` intervals) |
| 18292–18439 | `POST /api/ai/vault-search`, storage signed-url + file-proxy-url |
| 18441–18712 | Vault description backfill (`generateVaultItemDescription`, `POST /api/vault/backfill-descriptions`) |
| 18713–19647 | Media + assist AI: imagine-image, describe-image, transcribe, meeting-chunk (multer), summarize-conversation, clean-transcript, live-assist, meeting-notes, suggest, name-grid |
| 19648–21353 | **Desktop/Glass browser agent**: ~1,700 lines — browser-control planner helpers, agent-intent/browser-plan/agent-model/agent-ground/browser-plan-next/browser-report, desktop chats GET+save, name-chat |
| 21354–23341 | **Voice/realtime/ElevenLabs**: ~1,990 lines — TTS, realtime session + tool, tune-instructions, ElevenLabs signed-url/screen/voices, `voiceSessionGrounding` + `voiceScreenByUser` Maps (22875/22879), `sign/verifyLyknVoiceToken`, `elevenCustomLlmHandler` (OpenAI-compatible streaming proxy) registered at 3 paths + `_debug`, `customLlmStats` mutable object |
| 23342–23730 | YouTube QA: search, video, transcript, transcript-priority, localize, retranscribe-segment, answer, whisper/transcribe |
| 23731–24196 | `GET /api/search`, `GET /api/scrape`, `GET /api/unfurl` (~360-line route: oEmbed branches for YT/IG/FB/TikTok, OG scraping) |
| 24198–24663 | File text extraction (docx/xlsx/pptx/odt helpers), extract-text, parse-spreadsheet, vault save-image / save-file (both call `indexVaultNoteForSearch`), files process/search |
| 24665–25007 | Feedback (Resend client created at 24669), project invite, signup-start/resend/verify, password-reset start/confirm (delegate to `lib/auth/*` handler factories) |
| 25009–25062 | Usage: me, session/:id, history |
| 25063–25598 | **Admin**: usage overview/users/drilldown/recent/live/diagnostics, billing overview (Stripe MRR), MCP usage, security audit |
| 25599–26818 | **Billing**: `PLAN_IDS`, `userPlanCache`/`appAccessGrace`/`freeCreditsCache` Maps, `resolveUserPlan` (25671), `requireAppAccess` (25794), billing/me, checkout, credits, topup, stripe-config, trial-checkout, portal, waitlist, `handleStripeEvent` (26271, ~370 lines — called by the webhook route at line 946) |
| 26819–27117 | Feeds (RSS): discover, CRUD, refresh, + secret-gated poll-due trio (feeds / connections / cursor-builds), `verifyAdminIngestSecret` |
| 27119–27613 | Connector framework: OAuth start, `GET /oauth/callback/:provider` (HTML+inline-script response), connect-info, connections list/sync/patch/delete |
| 27615–27700 | **Global error handler** (`res.headersSent` SSE guard; uses `AI_TEMPORARY_FAILURE_TEXT`) |
| 27702–27839 | `HOST`, `export { app, enrichVaultNoteSummary }`, `app.listen` guarded by `NODE_ENV !== 'test'`; listen callback starts `startSessionCleanup()`, RSS poller, connector poller, Cursor-build poller (all gated on `supabaseAdmin` + serverless detection) |

---

## 3. Proposed route domains → router modules

Grouping by actual dependency clusters, not just banners:

| # | Domain module | Routes | Approx lines in server.js today |
|---|---|---|---|
| 1 | `youtube` | 8 (`/api/youtube/*`, `/api/whisper/transcribe`) | ~390 |
| 2 | `webtools` (search/scrape/unfurl) | 3 | ~465 |
| 3 | `files` (extract/parse/save/process/search) | 7 | ~465 |
| 4 | `authFlows` (signup, password reset, SIWA, feedback, project invite) | 9 | ~500 |
| 5 | `usage` | 3 | ~55 |
| 6 | `feeds` (RSS + poll-due cron trio) | 9 | ~300 |
| 7 | `connections` (custom-connections + concepts v1) | 10 | ~370 |
| 8 | `connectors` (OAuth framework) | 7 | ~495 |
| 9 | `admin` | 9 | ~535 |
| 10 | `account` (preferences, briefs, steward, delete, metrics ingest) | 8 | ~470 |
| 11 | `learning` (learned, user-facts, beliefs, rules, applied, ai/feedback, synthesis activity) | 22 | ~1,100 |
| 12 | `synthesis` (reindex/purge/profile/intake/backfill/enrich-note/reconcile) | 10 | ~950 + shared service ~1,900 |
| 13 | `discover` (feed + ingest) | 2 | ~1,650 |
| 14 | `vaultMedia` (signed-url, file-proxy-url, backfill-descriptions, imagine/describe image, vault-search) | 6 | ~600 |
| 15 | `assistAi` (transcribe, meeting-chunk, summarize, clean-transcript, live-assist, meeting-notes, suggest, name-grid, name-chat) | 9 | ~1,100 |
| 16 | `desktop` (Glass browser agent + desktop chats) | 9 | ~1,700 |
| 17 | `voice` (TTS, realtime, tune-instructions, ElevenLabs incl. custom-LLM proxy) | 12 | ~2,000 |
| 18 | `chatCore` (`/api/ai/invoke`, `/api/ai/stream`, `/api/ai/stream-guest`, `/api/ai/local-tool-result`, `/api/ai/models`) | 5 | ~6,300 routes + ~5,000 helper belt |
| 19 | `billing` (billing/*, stripe webhook) | 11 | ~1,600 |
| 20 | `platform` (health, client-error, file proxy `/f/:token`, artifacts rebuild) | 4 | ~400 |

Routes 160 + custom-models 1 = the 20 domains above cover all 161.

---

## 4. Dependency map per domain

### Shared service modules to create first (imported directly, not injected)

| Proposed module | Extracted from | Consumed by |
|---|---|---|
| `server/services/supabase.js` | line 1167 (`supabaseAdmin` singleton) | nearly every domain |
| `server/services/billingService.js` | 25599–26320 (`resolveUserPlan`, `requireAppAccess`, `handleStripeEvent`, plan caches, comped emails 880–911, Stripe client + price maps 810–877) | billing routes, `checkAiUsageLimit`, chatCore, admin |
| `server/services/modelCatalog.js` | 4740–5184 (`MODEL_CATALOG`, `getFallbackModels`, `getProviderForModel`, `clampForProvider`, `pickOutputCap`, `AI_TEMPORARY_FAILURE_TEXT`, `internalHeaders`) | chatCore, voice, assistAi, desktop, error handler |
| `server/services/promptSections.js` | 1799–4460 (synthesis retrieval, user model/belief/project/identity/connected-tools sections + their 8 cache Maps + `invalidate*` fns) | chatCore, voice, discover, learning, connections |
| `server/services/vaultEnrichment.js` | 12193–12658 + 18441–18560 (`enrichVaultNoteSummary`, `indexVaultNoteForSearch`, `generateVaultItemDescription`) | synthesis, files, connectors/notion.js |
| `server/services/webEnrichment.js` | 400–697 (scrape/web-search/YouTube-search intent + runners, `classifyEnrichment`, `isTrivialTurn`) | chatCore, assistAi |
| `server/services/chatPersona.js` | 5337–7565 (persona strings, tool guidance, intent gates, `AI_BUDGETS`) | chatCore, voice |
| `server/services/localToolBridge.js` | 6457–6480 (`localToolStreams` Map + register/release/resolve) | chatCore only (both routes) |
| `server/services/voiceSessions.js` | 22875–22930 (`voiceSessionGrounding`, `voiceScreenByUser`, `pruneVoiceSessions`, `sign/verifyLyknVoiceToken`, `customLlmStats`) | voice only |
| `server/services/cronSecrets.js` | 11816, 12423–12478, 27041 (`timingSafeEqualStr`, `verifyBackfillSecret`, `verifyDiscoverIngestSecret`, `verifyAdminIngestSecret`, `verifyReconcilerDeleteSecret`) | discover, synthesis, feeds |
| `server/middleware/auth.js` | 1228–1311, 1454–1478 (`requireAuth`, `requireAdmin`, `sanitizePromptBundle`) | all |
| `server/middleware/rateLimits.js` | 4461–4660 (12 limiters + `guestAiGlobalLimiter` + `userOrIpKey`) | all |
| `server/middleware/checkAiUsageLimit.js` | 4666–4723 | chatCore, voice, assistAi |
| `server/lib/utils.js` | 999–1002, 1483–1533, 4735 (`safeErr`, `sha256`, `memCache`, `isUrlSafe`) | many |

### Per-domain: imports, closures, middleware, singletons

- **youtube** — imports: `youtubeQa.js` (already external). Middleware: `requireAuth`, `searchScrapeLimiter`, `requireAppAccess`, `aiLimiter`. Closes over: nothing else. Singletons: none. Cross-domain: none. **Cleanest extraction in the file.**
- **webtools** — imports: `ssrfGuard` (`safeFetch`/`assertUrlSafe`), cheerio, `memCache`, META_APP_TOKEN env. Middleware: `requireAuth`, `searchScrapeLimiter`. Singletons: memCache instances (module-local after extraction — identity preserved as long as defined once).
- **files** — imports: multer `upload`, mammoth/ExcelJS/AdmZip, `buildAttachmentColumns`, `insertWithSchemaFallback`, `inferAttachmentKind`, `supabaseAdmin`. **Closes over `indexVaultNoteForSearch`** (lines 24474/24579) → needs `vaultEnrichment` service first, or extract together with synthesis.
- **authFlows** — imports: `createEmailSignupHandlers`/`createEmailPasswordResetHandlers` factories (already external), `resendClient` singleton (24669), `exchangeAppleAuthorizationCode`, `validate` schemas. Middleware: `authLimiter`, `requireAuth` (mixed). `findAuthUserByEmail` helper is local to this cluster.
- **usage** — imports: `usageTracking.js` fns only. Trivial.
- **feeds** — imports: `rss-service.js`, `verifyAdminIngestSecret`, `supabaseAdmin`, validate schemas. Poll-due routes are unauthenticated + secret-gated (external cron compatibility — paths frozen).
- **connections/concepts** — imports: `customConnections` lib, `conceptEmbedding`. **Closes over `invalidateConnectedToolsCache`** (cache Map lives in the prompt-sections cluster at 3035) → needs `promptSections` service or a passed callback.
- **connectors (OAuth)** — imports: `connectors-service.js`, `encryptToken`, `connectorRedirectUri`. Serves HTML with inline scripts on `/oauth/callback/:provider`; the CSP relaxation is **path-based** (`HTML_OAUTH_PATH_RE` in the security middleware), not order-based — safe to extract, but the `/oauth/` path prefix must never change. Also calls `invalidateConnectedToolsCache` (27608).
- **admin** — imports: `usageTracking` admin fns, Stripe client (read-only MRR math), `supabaseAdmin.auth.admin`. Middleware: `requireAuth` + `requireAdmin`.
- **account / learning / synthesis** — imports: `userModelLearning.js`, `beliefSystem.js`, `synthesis-service.js`, `conceptsJob`, embedding helpers. Heavy interaction with the per-user cache Maps (invalidation on writes) — extract `promptSections` first.
- **discover** — mostly self-contained ~30-function cluster + Serper key + synthesis profile reads + `verifyDiscoverIngestSecret`. Big but low-coupling.
- **desktop** — imports: `lib/holo/*`, `agentModelProviders`, browser-control helpers (19648–20074 belt is only used here). Does **not** touch `localToolStreams`. Middleware: `requireAuth`, `requireAppAccess`, `aiLimiter`.
- **voice** — imports: `modelCatalog`, `promptSections` (`buildRealtimeSynthesisGrounding` uses synthesis + beliefs + identity), voice-briefing builders (3724–4460), `voiceSessions` singletons, ElevenLabs env secrets, `timingSafeEqualStr`. The custom-LLM proxy **streams upstream SSE bytes straight through** and is consumed by ElevenLabs servers (external API contract — request/response shapes frozen, OpenAI-compatible).
- **chatCore** — the maximal dependency node: webEnrichment, promptSections, chatPersona, modelCatalog, localToolBridge, billingService (plan gates inside route bodies at 12971/15364), usageTracking, `chat-agent-loop.js`, `mcp-tools/*`, custom-model libs, sanitizers, deep research, artifacts. Extract **last** among routes.
- **billing** — Stripe singleton, price maps, plan caches, `handleStripeEvent`, credit wallet lib. The webhook route body is thin (35 lines) but its **registration position** before the JSON parser is a hard invariant.
- **platform** — health (DB ping + replay counter), client-error (own parser), `/f/:token` (verifyFileToken + storage download + per-response header un-hardening), artifacts rebuild.

### Circular dependency risks

1. **`connectors/notion.js` → `server.js`**: notion.js lazy-imports `enrichVaultNoteSummary` via `await import('../server.js')` (notion.js:403–417) while server.js imports `connectors-service.js`. The lazy import currently just resolves the cached module. **When `enrichVaultNoteSummary` moves, either (a) update notion.js to import the new service module, or (b) keep the re-export in server.js (`export { enrichVaultNoteSummary } from './server/services/vaultEnrichment.js'`).** Option (a) is cleaner and breaks the cycle for real.
2. **`checkAiUsageLimit` (4666) → billing fns (25671+)**: works today only via function hoisting across 21,000 lines. Extracting the middleware requires `billingService` to exist first (or in the same commit).
3. **Global error handler (27689) → `AI_TEMPORARY_FAILURE_TEXT` (4999)**: move the constant to `modelCatalog` (or a copy module) before touching the error handler.
4. **chatCore ↔ everything**: `/api/ai/stream` reads plan (billing), synthesis sections, beliefs, connected tools, model catalog, local tool bridge, web enrichment. Not circular per se, but any naive "move the route first" attempt drags 5,000 helper lines with it. Extract the helper belt into services first; the route bodies then move nearly verbatim.

---

## 5. Shared-state hazards (singleton identity must be preserved)

All of these are **module-level mutable state**. After extraction each must be defined in exactly one module (ESM caches modules, so a single definition = single instance). Never duplicate a Map into two modules.

| State | Line | Written by | Read by |
|---|---|---|---|
| `localToolStreams` Map | 6457 | `/api/ai/stream` (register 17780, poll 18086), `/api/ai/local-tool-result` (14691) | same — **the two routes must share one module** |
| `voiceSessionGrounding`, `voiceScreenByUser` Maps | 22875/22879 | `/api/ai/realtime/session`, `/api/ai/realtime/screen`, ElevenLabs signed-url | `elevenCustomLlmHandler` |
| `customLlmStats` object | ~23000s | `elevenCustomLlmHandler` | `GET /api/ai/elevenlabs/llm/_debug` |
| `userModelSectionCache`, `userIdentitySectionCache`, `beliefSectionCache`, `projectSectionCache`, `connectedToolsSectionCache`, `incrementalConceptsLastRunAt`, `lastProfileLlmAt`, `lastProfileEvidenceHash` | 2963–3035 | learning/belief/synthesis/account routes call `invalidate*`; profile refresh writes | chat prompt builders (guest stream, invoke, stream, voice grounding) — **cross-domain: writes in one domain must invalidate reads in another** |
| `userPlanCache`, `appAccessGrace`, `freeCreditsCache` | 25664–25769 | `handleStripeEvent` invalidates; `resolveUserPlan` populates | `checkAiUsageLimit`, `requireAppAccess`, chat routes, billing routes |
| `autoLearnVerdictCache` | 9293 | `/api/learned/auto` | same route (local to learning domain) |
| `guestAiGlobalHourlyCount/ResetAt` | 4634 | `guestAiGlobalLimiter` | same (local to rate-limit module) |
| `_memCaches`, `_geminiCacheInflight`, `_elevenVoicesCache` | 1488/1600/~23050 | lazy caches | respective helpers |
| Rate limiter instances | 4464–4660 | express-rate-limit in-memory stores | every route using them — **the limiter object identity IS the counter store; construct once, import everywhere** |
| Lazy-initialized clients | — | `stripe` (815, null-checked), `supabaseAdmin` (1167, null-checked), `resendClient` (24669), `loadConnectorTokenHelpers`/`loadNotionFetchPageBody` (2414/2421 lazy imports) | all null-checks are "feature disabled" semantics — preserve nullability, don't convert to throws |

---

## 6. Middleware & ordering hazards

Express matches in registration order. The exact current order is:

1. `app.disable('x-powered-by')`, `app.set('trust proxy', 1)` — trust-proxy **must precede limiter creation usage** (limiters key on `req.ip`).
2. Artifacts-host gate (318) — host-based 404 wall for `artifacts.lykn.io`.
3. Security headers (335) — path-conditional CSP relaxation for `/oauth/*`.
4. CORS (777) — terminates OPTIONS with 204.
5. **`POST /api/stripe/webhook` (919) with `express.raw`** — must stay before the JSON parser or signature verification breaks.
6. Branching JSON parser (987) — routes in `IMAGE_BEARING_AI_ROUTES` get 12 MB; a route-level parser **cannot raise** the limit later (stream already consumed), so this set must stay in the global middleware and stay in sync with route paths.
7. `/api/client-error` (1040) — own 10 kb parser (runs after global parse; effectively double-parsed body is fine since the global parser already parsed it — behavior verified as intentional per comments; do not "fix").
8. `/api/health` (1089), `/f/:token` (1352), `/api/artifacts/react/rebuild` (1434).
9. **`app.use('/api/', globalLimiter)` at 4662** — ⚠️ every route registered **before** this line bypasses the global limiter: `/api/stripe/webhook`, `/api/client-error`, `/api/health`, `/f/:token`, `/api/artifacts/react/rebuild`. Webhook/health exemption is clearly intentional; the artifacts-rebuild exemption looks accidental but is **current behavior — preserve it**. After extraction, these five must still be registered before the limiter mount.
10. All remaining routes (4662→27613).
11. Global error handler (27641) — must remain the **last** `app.use`.
12. `app.listen` (27713) — callback starts pollers only, registers no routes.

Other ordering facts:

- **No wildcard or catch-all routes.** The only parameterized top-level paths are `/f/:token` and `/oauth/callback/:provider`; everything else is a literal `/api/...` path. No overlapping patterns found (the three ElevenLabs LLM aliases are distinct literals sharing one handler). Within-domain `:id` routes (e.g. `/api/beliefs/promote` vs `/api/beliefs/:id/ratify`) are registered with the static path first — keep intra-domain registration order when moving.
- **`requireAuth` before `requireAppAccess` before limiters/usage-check** on each route's middleware array — preserve per-route arrays verbatim.
- 404 handling is Express default (no custom fallback handler) — do not add one.
- `validate(...)`/`validateParams(...)` zod middleware appear on ~12 routes; they must move with their schema constants.

---

## 7. Recommended router pattern

**Use the pattern the codebase already proved: `registerXRoutes(app, deps)` functions that register full literal paths directly on `app`** (see `custom-models-routes.js` + its call at server.js:10253).

Explicitly **do not** use `express.Router()` mounted at path prefixes (`app.use('/api/billing', router)`), because:

- Mounted routers strip the prefix from `req.path`. Dozens of handlers and the rate-limit/security loggers log or branch on `req.path` (e.g. `console.error('[supabase]', req.method, req.path, …)`, `logSecurityEvent` payloads, `IMAGE_BEARING_AI_ROUTES.has(req.path)` in the global parser). Prefix-mounting silently changes observability and could break future path checks.
- Full-path registration makes each extraction a pure text move: the route line in the new module is byte-identical to the old one.
- Registration order stays explicit and auditable in server.js: a numbered list of `registerXRoutes(app, deps)` calls in the current order.

**Dependency passing — hybrid, minimal:**

- Stateless helpers and singletons that many domains need (supabaseAdmin, limiters, model catalog, prompt sections, billing service) become **directly imported modules**. No giant deps objects.
- `registerXRoutes(app, deps)` receives only what genuinely varies or would create an import cycle — typically `{ requireAuth, requireAdmin, requireAppAccess, checkAiUsageLimit }` plus the domain's limiters. Even these can be direct imports from `server/middleware/*` once those modules exist; the deps parameter is a transitional convenience matching the existing precedent.
- Keep `app.set('supabaseAdmin', …)` in bootstrap — `buildToolCtx`/tool context builders rely on the app-level idiom.

Signature convention:

```js
// server/routes/youtube.js
export function registerYoutubeRoutes(app) {
  app.get('/api/youtube/search', requireAuth, searchScrapeLimiter, async (req, res) => { /* moved verbatim */ });
  // ...
}
```

---

## 8. Extraction waves

### Wave 0 — harness (no lines removed)

Build the validation tooling before moving anything:
- A route-manifest script that imports `app` (with `NODE_ENV=test`, which skips `listen`) and dumps `app._router.stack` as an ordered list of `(methods, path, handler-count, middleware names)`. Snapshot it; diff after every wave. This is the single highest-value safety net.
- A supertest smoke suite: health 200, a `requireAuth` route 401s without a token, webhook 400s on bad signature, guest-stream returns `text/event-stream` headers, `/f/bogus` 403s.
- Confirm existing tests pass: `youtubeQa.test.js`, `security-logger.test.js`.

### Wave 1 — safest (est. **~2,400–2,700 lines** out of server.js)

Small, self-contained domains, few shared deps. Prerequisite service extractions are tiny.

| Move | Routes | Risk | Validation |
|---|---|---|---|
| `youtube` | 8 | minimal — everything already lives in `youtubeQa.js` | manifest diff + youtubeQa tests + one live transcript call |
| `usage` | 3 | minimal | manifest diff + authed smoke |
| `webtools` (search/scrape/unfurl) | 3 | low — SSRF guard is already a lib; memCache instances move whole | manifest diff + unfurl a YT/IG URL |
| `feeds` + `cronSecrets` service | 9 | low — poll-due paths/secrets are an external cron contract; freeze paths + Bearer semantics | cron secret 403/200 checks |
| `authFlows` (signup/reset/SIWA/feedback/invite) | 9 | low-moderate — Resend singleton + `authLimiter` identity | signup-start round-trip in dev |
| `admin` | 9 | low — read-only | admin smoke with allowlisted email |

The prior audit's Wave-1 suggestion of "YouTube QA and feeds" is **confirmed correct**; usage, webtools, admin, and authFlows are equally safe.

### Wave 2 — moderate (est. **~6,500–7,500 lines**)

Requires the shared-state service modules first.

| Move | Routes | Risk | Validation |
|---|---|---|---|
| `promptSections` service (caches + fetchers, 1799–4460) | 0 (helpers only) | **moderate-high** — 8 cache Maps become one module; every chat/voice path reads them | manifest unchanged; full chat turn + voice session in staging; check invalidation (edit a fact → next chat reflects it) |
| `vaultEnrichment` service + `synthesis` routes | 10 | moderate — **notion.js lazy-import must be repointed** (or shim kept) | connector sync creates a note → ai_summary appears; backfill secret routes 403/200 |
| `discover` | 2 | low-moderate — big but isolated | discover feed returns items; ingest with secret |
| `connections`/`concepts` + `connectors` (OAuth) | 17 | moderate — OAuth popup HTML + `/oauth/` CSP path coupling; `invalidateConnectedToolsCache` cross-domain call | full OAuth connect flow for one provider in staging |
| `files` | 7 | moderate — depends on vaultEnrichment | upload image → vault note + description |
| `account` + `learning` | 30 | moderate — cache invalidation correctness | facts CRUD → chat prompt reflects changes |
| `desktop` | 9 | low-moderate — isolated helper belt (19648–20074 moves with it) | Glass browser-plan smoke |
| `assistAi` | 9 | low-moderate — multer + model catalog | transcribe + meeting-notes smoke |

### Wave 3 — sensitive (est. **~11,000–12,500 lines**)

One domain per PR. Never batch these.

| Move | Routes | Risk | Validation |
|---|---|---|---|
| `billingService` + `billing` routes + webhook | 11 | **high** — money. Plan caches identity, comped emails, webhook raw-body ordering, `checkAiUsageLimit` hoisting fix. Webhook registration call stays in bootstrap before the JSON parser (the handler function may live in the module). | Stripe CLI event replay (checkout.completed, sub updated/deleted, topup); plan gate flips correctly; `X-Plan` headers unchanged |
| `voice` + `voiceSessions` service (+ voice-briefing builders 3724–4460) | 12 | **high** — external ElevenLabs API contract (OpenAI-compatible streaming), shared session Maps, timing-safe secret auth | real voice session end-to-end; `_debug` stats still increment; ElevenLabs agent round-trip |
| `chatPersona` + `webEnrichment` + `modelCatalog` + `localToolBridge` services | 0 | moderate (pure moves, huge surface) | manifest unchanged; token-cap and persona snapshot tests (string-equality on built prompts for fixed inputs would be ideal) |
| `chatCore` (`stream-guest`, `invoke`, `stream`, `local-tool-result`, `models`) | 5 | **highest** — 3,594-line SSE route with per-request heartbeat/stall/watchdog intervals, agent loop, image parser coupling (`IMAGE_BEARING_AI_ROUTES`), plan checks, local-tool bridge | streamed chat turn with tools; local-tool round trip from desktop app; guest stream; abort mid-stream (client disconnect cleanup); SSE `[DONE]` framing byte-identical |

### Wave 4 — bootstrap cleanup (est. **~1,200 lines**, only after routes are proven)

- Move perimeter/CORS/security-header middleware to `server/middleware/perimeter.js`, `cors.js`, `parsers.js` — as exported middleware functions, **mounted from bootstrap in the exact current order**.
- Move env logging + `validateSecrets` call into `server/config/`.
- Move the listen-callback pollers (RSS, connector, cursor-builds, session cleanup) to `server/bootstrap/pollers.js` — started from the same `listen` callback, same gating (`NODE_ENV !== 'test'`, serverless detection, `supabaseAdmin` presence).
- Global error handler to `server/middleware/errorHandler.js`, mounted last.
- Keep `export { app, enrichVaultNoteSummary }` semantics: `app` for tests; `enrichVaultNoteSummary` re-export until notion.js is repointed (do the repoint in Wave 2 and drop the re-export here).

---

## 9. Target architecture

```text
server.js                      # thin entry: imports bootstrap, ~30 lines
server/
├── config/
│   ├── env.js                 # dotenv, validateSecrets, boot logging, IS_PROD, PORT/HOST
│   └── constants.js           # ALLOWED_ORIGINS, IMAGE_BEARING_AI_ROUTES, ADMIN_EMAILS, …
├── middleware/
│   ├── perimeter.js           # artifacts gate, security headers
│   ├── cors.js
│   ├── parsers.js             # branching JSON parser + multer upload
│   ├── auth.js                # requireAuth, requireAdmin, sanitizePromptBundle
│   ├── rateLimits.js          # all limiter singletons
│   ├── usageGate.js           # checkAiUsageLimit
│   └── errorHandler.js
├── services/
│   ├── supabase.js            # supabaseAdmin singleton
│   ├── billingService.js      # Stripe client, plan caches, resolveUserPlan, requireAppAccess, handleStripeEvent
│   ├── modelCatalog.js
│   ├── promptSections.js      # synthesis/user-model/belief/project/identity/connected-tools + caches
│   ├── chatPersona.js
│   ├── webEnrichment.js
│   ├── vaultEnrichment.js     # enrichVaultNoteSummary, indexVaultNoteForSearch
│   ├── localToolBridge.js
│   ├── voiceSessions.js
│   └── cronSecrets.js
├── routes/                    # one registerXRoutes(app) per domain (§3 table)
│   ├── youtube.js … chatCore.js  (~20 modules)
└── bootstrap/
    ├── app.js                 # create app, mount middleware + routes in frozen order
    └── pollers.js             # RSS / connector / cursor-build pollers, session cleanup
```

**Estimated post-refactor entry + bootstrap size: ~350–500 lines total** (app.js carries the ordered mount list with the ordering-invariant comments preserved; server.js itself becomes ~30 lines).

---

## 10. Critical invariants (must-preserve checklist)

1. **Route paths byte-identical** — external consumers: Stripe, ElevenLabs (3 LLM alias paths), Render health check (`render.yaml → /api/health`), cron services (`poll-due` trio, `discover/ingest`, `synthesis/backfill`, `vault/reconcile`), OAuth providers (`/oauth/callback/:provider` redirect URIs registered upstream), iOS app (SIWA, metrics ingest), Electron desktop app (`/api/desktop/*`, local-tool-result), branded links in the wild (`/f/:token`).
2. **Registration order** — the five pre-limiter routes stay pre-limiter; webhook stays pre-parser; error handler stays last; intra-domain static-before-param order kept.
3. **Middleware order per route** — copy middleware arrays verbatim (`requireAuth, requireAppAccess, aiLimiter, checkAiUsageLimit, upload.single(...)` etc.).
4. **Request parsing** — raw body for webhook; 12 MB parser for the six `IMAGE_BEARING_AI_ROUTES`; 10 kb parser on client-error; multer memory storage at 50 MB on upload routes.
5. **Streaming behavior** — SSE framing (`data: {...}\n\n`, `: keepalive`, `data: [DONE]`), `flushHeaders`, heartbeat/stall intervals and their cleanup on close, `res.headersSent` guard in the error handler, ElevenLabs upstream passthrough content-type.
6. **Response shapes and status codes** — including 503 "not configured" semantics when optional env vars are absent, `X-Model-Downgraded`/`X-Plan`/`X-Feature-Stripped` exposed headers, prod-vs-dev error message split (`safeErr`, error handler).
7. **Singleton identity** — every Map/limiter/client in §5 defined exactly once; limiter stores are the rate-limit counters.
8. **Service init order** — `validateSecrets()` immediately after dotenv; Stripe before webhook registration; `supabaseAdmin` before logger-sink wiring and before `app.set('supabaseAdmin')`; pollers only inside the `listen` callback, gated on `NODE_ENV !== 'test'`.
9. **Environment behavior** — dev fallbacks (requireAuth bypass without Supabase env in dev, localhost CORS in dev, HOST loopback in dev), serverless poller detection, `COMPED_PRO_EMAILS` env merge.
10. **Scheduled/background behavior** — RSS poller (60 s), connector poller (60 s), cursor-build poller (30 s), `startSessionCleanup()`, plus fire-and-forget calls inside request handlers (`void indexVaultNoteForSearch(...)`, `enrichVaultNoteSummary(...).catch(() => {})`) — keep them non-awaited.
11. **`export { app, enrichVaultNoteSummary }`** — `app` export powers the `NODE_ENV=test` import path; `enrichVaultNoteSummary` is lazily imported by `connectors/notion.js`.
12. **Security-event logging** — `logSecurityEvent` call sites and payload shapes (an audit table consumes them); `buildRateLimitHandler` wiring on every limiter.

---

## 11. High-risk findings (flagged for the refactor agent)

- **`/api/ai/stream` (14698–18291)** — 3,594 lines, SSE, per-request `setInterval` triplet (stall check, keepalive heartbeat, attempt watchdog) with cleanup paths; shares `localToolStreams` with `/api/ai/local-tool-result`. The single most dangerous move in the project.
- **`checkAiUsageLimit` → `resolveUserPlan` hoisting** across 21,000 lines — invisible coupling that a naive top-down split will break at module-load time.
- **`connectors/notion.js` lazy-imports server.js** — the only true import cycle. Repoint it during the vaultEnrichment extraction.
- **Pre-limiter route exemptions** (webhook, client-error, health, `/f/:token`, artifacts rebuild) — easy to accidentally "fix" by mounting the limiter earlier; that's a behavior change (and would break Stripe retries under load).
- **Branching body parser** — `IMAGE_BEARING_AI_ROUTES` is a path set inside global middleware; if chat routes ever get renamed/prefixed, image uploads 413 silently. Keep the set adjacent to the parser and add a comment linking it to the chatCore route module.
- **Stripe webhook + `handleStripeEvent`** — billing mutations + `invalidateUserPlanCache`; wrong cache identity after extraction means stale plans until process restart, i.e. paying users locked out or free users unlocked.
- **ElevenLabs custom-LLM proxy** — external service POSTs here with a shared secret; OpenAI-compatible response contract; upstream SSE passthrough; `customLlmStats` debug coupling.
- **Voice session Maps** — grounding handed from `realtime/session` → ElevenLabs handler via `voiceSessionGrounding`; identity break = silently degraded voice grounding (no error thrown).
- **Per-user prompt-section caches** — writes (facts/beliefs/projects/connections routes) invalidate what chat reads. Splitting them across two modules without sharing state would cause stale-prompt bugs that only show up minutes later in QA.
- **In-memory rate limiters** — 13 stores; splitting a limiter into two instances doubles everyone's effective quota.
- **Secret-gated cron endpoints** — timing-safe comparison + ≥32-char floors; response codes are consumed by external schedulers.
- **Fire-and-forget background work inside handlers** — must not become awaited (latency change) or dropped (data change).
- **The unhandled-rejection safety net (4742)** and `process.exit` semantics in `validateSecrets` — bootstrap-order sensitive.

---

## 12. Things that should NOT move yet

1. The four global middleware mounts (perimeter, headers, CORS, parser) — Wave 4 only, after all routes are proven.
2. The `app.use('/api/', globalLimiter)` line and anything registered above it — freeze until Wave 4.
3. The global error handler and `app.listen` block — Wave 4.
4. `enrichVaultNoteSummary` — not before the notion.js repoint/shim is in place.
5. `/api/ai/stream` + `/api/ai/invoke` — not before `promptSections`, `chatPersona`, `webEnrichment`, `modelCatalog`, `localToolBridge`, and `billingService` all exist as modules.
6. The Stripe webhook **registration position** — the handler body can move to `billingService`, but the `app.post('/api/stripe/webhook', express.raw(...), handler)` call stays in bootstrap, above the parser, forever.
7. `IMAGE_BEARING_AI_ROUTES` — stays glued to the parser middleware.
8. Anything in the `listen` callback — Wave 4.

---

## 13. Validation strategy (per wave)

1. **Route-manifest diff** (Wave 0 harness): ordered dump of method/path/middleware-count must be identical before and after every extraction, except for intentional none.
2. **Boot-log diff**: the startup console output is extensive and deterministic per env; byte-identical boot logs are a cheap, strong regression signal.
3. **Supertest smoke suite** on the exported `app` (no listen in test mode): auth 401s, health, webhook signature rejection, SSE headers, secret-gated 403s, admin 403 for non-allowlisted email.
4. **Existing unit tests**: `youtubeQa.test.js`, `security-logger.test.js`.
5. **Staging end-to-end per sensitive domain**: Stripe CLI webhook replay; full OAuth connect; live voice session; streamed chat turn with a tool call + local-tool round trip; guest stream; client-disconnect mid-stream (verify interval cleanup — watch for leaked timers via `process._getActiveHandles()` in a debug endpoint or heap snapshot).
6. **Cache-behavior checks**: mutate a fact/belief/connection → verify the next chat prompt reflects it (proves invalidation still crosses module boundaries).
7. **One extraction per PR** in Waves 2–3; revert unit = one domain.
