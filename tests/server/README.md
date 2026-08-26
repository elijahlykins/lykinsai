# Server Decomposition Safety Harness (Wave 0)

This directory is the safety net for decomposing `server.js` (27,839 lines and 161 routes at harness creation) into `server/routes|services|middleware/*`.
The harness exists so that every extraction can mechanically prove the external route contract did not change.
Wave 1 extracted the first four domains into `server/routes/` (youtube, webtools, usage, feeds — 23 routes) using this harness; the manifest showed zero drift.
Wave 2 extracted three moderate domains (admin, connections, synthesis — 31 routes) the same way, again with zero drift. The static security guards in `lib/securityRegressions.test.mjs` now scan `server.js` + `server/routes/*.js` so they keep covering extracted handlers.
Wave 3 extracted three long-term live domains (voice, desktop, files — 26 routes), again with zero drift; the concatenated security scan covers the new routers automatically.
Wave 4 extracted three more moderate live domains (account, storage, assist — 21 routes), again with zero drift; 101 of the 161 routes now live in `server/routes/`.
Wave 5 extracted the auth-flow and connector-OAuth boundaries (authFlows, platform, connectionsOAuth — 17 routes), again with zero drift; 118 of the 161 routes now live in `server/routes/`, leaving billing, chat core, the pre-limiter platform routes, the learning/user-model band, and discover inline.
Wave 6 extracted the billing boundary (billing — 9 routes), again with zero drift; 127 of the 161 routes now live in `server/routes/`. The Stripe webhook and all shared billing infra (plan caches, `resolveUserPlan`, `requireAppAccess`, `handleStripeEvent`) stayed in server.js; billing 401/stripe-config characterization tests were added to `serverCriticalRoutes.test.mjs`.
Wave 7 extracted the five pre-limiter platform routes (stripeWebhook + preLimiterPlatform — webhook, client-error, health, `/f/:token`, artifacts rebuild), again with zero drift; 132 of the 161 routes now live in `server/routes/`, leaving only chat core (5), the learning/user-model band (21), and discover (2) inline. Each registrar is called at the route's exact original bootstrap position (webhook before the JSON parser; client-error/health before the auth core; file-proxy/rebuild before the global limiter), and a rebuild limiter-exemption characterization test was added to `serverCriticalRoutes.test.mjs`.
Note: Synthesis is planned legacy infrastructure pending Memory Architecture Replacement; `synthesis.routes.js` is retained as an isolation boundary, not as a commitment to the architecture, and the learning/user-model route band stays inline as a MEMORY-REPLACEMENT CANDIDATE.

Companion planning document: `docs/refactor/server-decomposition-plan.md`.

## What is in here

| File | Purpose |
|---|---|
| `harness.mjs` | Loads the production `app` from `server.js` with a scrubbed environment and no listener. Also starts ephemeral loopback listeners for smoke tests. |
| `routeSurface.mjs` | Extracts the ordered Express registration surface (methods, paths, middleware chains, domains, risk flags, duplicates, ordering hazards). |
| `serverRouteManifest.json` | GENERATED, checked-in contract: the full ordered registration surface. Regenerate with `npm run test:server:update-manifest`. |
| `serverRouteManifest.test.mjs` | Diffs the live app against the manifest: lost/renamed/new routes, method changes, duplicates, registration order, middleware chains, ordering hazards. |
| `serverMiddlewareOrder.test.mjs` | Named assertions for the security-critical ordering invariants (webhook-before-parser, limiter exemptions, error handler last, auth chains). |
| `serverCriticalRoutes.test.mjs` | HTTP smoke over a loopback listener: auth 401/503 contracts, webhook signature rejection, parser limits and the image-route parser branch, CORS, security headers, secret-gated cron 401s, guest-stream validation, file-proxy token gate. |

Run everything with:

```bash
npm run test:server
```

## How import safety works (no seam was added)

`server.js` already ships the two seams the harness needs, unchanged in this Wave:

- `export { app, enrichVaultNoteSummary }` near the bottom of the file.
- `app.listen(...)` is guarded by `if (process.env.NODE_ENV !== 'test')`.

The harness force-sets `NODE_ENV=test` before importing, so the listener never binds and the listen-callback pollers never start.

Secrets never enter the test process.
`harness.mjs` parses `.env` for key NAMES only and pre-sets every key to an inert dummy before `server.js` runs `dotenv.config()`, which does not override existing values.
Every URL-shaped variable points at `http://127.0.0.1:9` (a closed loopback port), so any unexpected outbound call fails instantly with `ECONNREFUSED` instead of reaching OpenAI, Anthropic, Supabase, Stripe, Google, Resend, ElevenLabs, or any connector provider.

## Boot-time side-effect map

What happens when `server.js` is imported (all verified against current HEAD):

| Phase | Side effect | Test-mode behavior |
|---|---|---|
| import | `dotenv.config()` loads `.env` | inert — harness pre-sets every key |
| import | `validateSecrets()` | warns and continues outside production; `process.exit(1)` only in `NODE_ENV=production` |
| import | env-check boot logging (~30 lines to stdout) | runs; deterministic per env — useful as a boot-log diff signal |
| import | `const app = express()` + perimeter settings (`trust proxy 1`, `x-powered-by` off) | runs |
| import | `new Stripe(...)` client | constructed, no network I/O |
| import | `createClient(...)` Supabase service client + `setSecurityLoggerSink` + `app.set('supabaseAdmin', ...)` | constructed, no network I/O |
| import | 13 `express-rate-limit` limiter instances (in-memory counter stores; instance identity IS the counter) | constructed |
| import | module-level mutable state: `localToolStreams`, voice session Maps, per-user prompt-section caches, plan caches, memCaches | allocated, empty |
| import | 161 route registrations + 6 `app.use` mounts (incl. `registerCustomModelRoutes(app, ...)`) | runs — this is what the manifest captures |
| import | `process.on('unhandledRejection')` net | installed |
| listen callback only | `app.listen(3001)`, `startSessionCleanup()`, RSS poller, connector poller, Cursor-build poller | SKIPPED under `NODE_ENV=test` |

Consequence for future extraction: none of the timers/pollers live at import scope, but the caches, limiter instances, and client singletons do.
Each of them must remain defined in exactly ONE module after extraction (see plan §5) — importing a module twice is safe under ESM, but duplicating a definition into two modules is not.

`connectors/notion.js` lazily imports `enrichVaultNoteSummary` from `server.js` — the only import cycle.
Any future move of that function must repoint notion.js or keep a re-export.

## Ordering invariants (why the manifest is order-sensitive)

Express matches in registration order. The load-bearing facts, each asserted by name in `serverMiddlewareOrder.test.mjs`:

1. `POST /api/stripe/webhook` uses `express.raw` and is the ONLY route registered before the global branching JSON parser. Moving it after the parser silently breaks Stripe signature verification.
2. The branching JSON parser gives `IMAGE_BEARING_AI_ROUTES` a 12mb limit and everything else 1mb. A route-level parser cannot raise the limit later, so this set must stay in global middleware and in sync with the chat route paths.
3. Exactly five routes are registered before `app.use('/api/', globalLimiter)` and are therefore limiter-exempt: webhook, client-error, health, `/f/:token`, artifacts rebuild. This is current production behavior — preserve it, including the (probably accidental) artifacts-rebuild exemption.
4. The global 4-arg error handler is the LAST layer. Routes registered after it would bypass error handling.
5. Per-route chains keep `requireAuth → requireAppAccess → (limiters) → checkAiUsageLimit → multer` order; admin routes are `requireAuth → requireAdmin`.
6. No wildcard/catch-all routes exist and there are currently ZERO param/static shadowing pairs (`orderHazards` in the manifest is empty — a future extraction that introduces one fails the manifest test).

## DEFERRED SECURITY FINDINGS (do not fix in refactor waves)

Recorded only — fixing any of these is a behavior change reserved for a dedicated security phase:

1. `POST /api/artifacts/react/rebuild` is registered before the global `/api/` rate limiter and is therefore rate-limit-exempt. Looks accidental (unlike the webhook/health exemptions) but is current production behavior.
2. The dedicated `express.json({ limit: '10kb' })` on `POST /api/client-error` is inert: the global 1mb parser has already consumed the body by the time it runs. The effective unauthenticated body ceiling on this route is 1mb, not the intended 10kb. Zod field caps still bound what reaches the logs.
3. `requireAuth` silently bypasses auth in non-production when `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are unset (dev fallback). Fail-closed in production is verified, but the dev bypass means test/dev configs must never leak toward production.
4. The comped-account email allowlist (`COMPED_PRO_EMAILS` + hardcoded list) short-circuits billing enforcement; any extraction of billing must keep it server-side only.
5. `GET /api/billing/stripe-config` is public by design (publishable key) — keep it public, but do not let future extraction accidentally attach auth or drop it below the error handler.

## External services

No test in this directory contacts a real external service.
Dummy secrets + closed-loopback URLs guarantee it mechanically, not just by convention.
The suite runs offline.

## Future extraction protocol (the contract for the next agent)

For EVERY extraction commit (one domain per commit/PR):

```text
1. capture:    npm run test:server            # must be green before you start
2. move:       extract ONE domain following docs/refactor/server-decomposition-plan.md
               (registerXRoutes(app, deps) pattern, full literal paths, no Router mounts)
3. prove:      npm run test:server            # manifest test proves surface + ORDER unchanged
               node scripts/server/update-route-manifest.mjs --check   # same check, CLI form
4. critical:   npm run test:server            # middleware-order + smoke suites are included
5. baseline:   npm run build && npm run typecheck && npm run lint
               node --test youtubeQa.test.js security-logger.test.js
               npm run test:security
6. commit:     only if all of the above are green with ZERO manifest drift
```

If a surface change is intentional (it should almost never be during decomposition), regenerate the manifest with `npm run test:server:update-manifest` and justify every changed JSON line in the PR description.

The manifest JSON is the before/after comparison artifact: `git diff tests/server/serverRouteManifest.json` must be empty for a pure code move.
