// ============================================================================
// tests/server/serverMiddlewareOrder.test.mjs — security-sensitive ordering
// ============================================================================
// The full ordered surface is protected by serverRouteManifest.test.mjs.
// This suite re-asserts the SECURITY-CRITICAL ordering facts individually,
// so a future extraction that breaks one of them gets a targeted, named
// failure instead of a generic manifest diff:
//
//   1. Stripe webhook (express.raw) registered BEFORE the global JSON parser
//      — otherwise signature verification breaks (body already consumed).
//   2. Exactly 5 routes registered BEFORE the /api/ global rate limiter
//      (webhook, client-error, health, /f/:token, artifacts rebuild) —
//      each carries its own dedicated perimeter limiter instead.
//   3. Global error handler (4-arg) is the LAST layer in the stack.
//   4. trust proxy = 1 and x-powered-by disabled (perimeter settings).
//   5. Auth/admin gates present on the critical route chains.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './harness.mjs';
import { extractSurface } from './routeSurface.mjs';

const app = await loadApp();
const entries = extractSurface(app);
const indexOfRoute = (method, path) =>
  entries.findIndex((e) => e.kind === 'route' && e.path === path && e.methods.includes(method));
const routeAt = (method, path) => entries[indexOfRoute(method, path)];

test('stripe webhook uses the raw-body parser (signature verification contract)', () => {
  const webhook = routeAt('POST', '/api/stripe/webhook');
  assert.ok(webhook, 'POST /api/stripe/webhook is registered');
  // chain[0] is the anonymous perimeter rate limiter (rejects a flood before
  // buffering the body); the RAW parser must still run before the handler.
  assert.equal(webhook.chain[1], 'rawParser', 'webhook must parse the RAW body, not JSON');
  assert.ok(!webhook.chain.includes('jsonParser'), 'webhook must never see a JSON-parsed body');
});

test('stripe webhook is registered before the global JSON body parser', () => {
  const webhookIdx = indexOfRoute('POST', '/api/stripe/webhook');
  // The branching JSON parser is the first app.use() AFTER the webhook route;
  // if any route other than the webhook precedes it, raw-body ordering broke.
  const routesBeforeParser = entries
    .slice(0, entries.findIndex((e, i) => i > webhookIdx && e.kind === 'use'))
    .filter((e) => e.kind === 'route')
    .map((e) => e.path);
  assert.deepEqual(routesBeforeParser, ['/api/stripe/webhook']);
});

test('exactly the 5 known pre-limiter routes precede the /api/ global rate limiter', () => {
  // These 5 register before the global limiter mounts, so it never covers
  // them — each carries a dedicated perimeter limiter instead (see
  // serverCriticalRoutes.test.mjs for the runtime RateLimit-header proof).
  const limiterIdx = entries.findIndex((e) => e.kind === 'use' && e.mount === '/api/');
  assert.ok(limiterIdx > 0, 'found exactly one app.use middleware mounted at /api/ (globalLimiter)');
  const preLimiterRoutes = entries
    .slice(0, limiterIdx)
    .filter((e) => e.kind === 'route')
    .map((e) => e.path);
  assert.deepEqual(preLimiterRoutes, [
    '/api/stripe/webhook',
    '/api/client-error',
    '/api/health',
    '/f/:token',
    '/api/artifacts/react/rebuild',
  ]);
});

test('an /oauth/ perimeter limiter is mounted before the OAuth callback routes', () => {
  // The OAuth callback/verify pages live OUTSIDE /api/, so the global
  // limiter never matches them; the dedicated /oauth/ mount must exist and
  // precede every /oauth/* route registration.
  const oauthLimiterIdx = entries.findIndex((e) => e.kind === 'use' && e.mount === '/oauth/');
  assert.ok(oauthLimiterIdx > 0, 'found the app.use middleware mounted at /oauth/');
  const oauthRoutes = entries.filter((e) => e.kind === 'route' && e.path.startsWith('/oauth/'));
  assert.ok(oauthRoutes.length >= 5, 'OAuth callback surface present');
  for (const r of oauthRoutes) {
    assert.ok(
      entries.indexOf(r) > oauthLimiterIdx,
      `${r.path} registers after the /oauth/ perimeter limiter mount`,
    );
  }
});

test('the global error handler is the LAST layer registered', () => {
  const last = entries[entries.length - 1];
  assert.equal(last.kind, 'use', 'last layer is app-level middleware');
  assert.equal(last.argc, 4, 'last layer is a 4-arg (err, req, res, next) error handler');
  const errorHandlers = entries.filter((e) => e.kind === 'use' && e.argc === 4);
  assert.equal(errorHandlers.length, 1, 'exactly one error-handling middleware exists');
});

test('perimeter settings: trust proxy = 1, x-powered-by disabled', () => {
  assert.equal(app.get('trust proxy'), 1);
  assert.equal(app.enabled('x-powered-by'), false);
});

test('supabaseAdmin is exposed via app.set (tool-context builder contract)', () => {
  assert.ok(app.get('supabaseAdmin'), 'app.get("supabaseAdmin") returns the service client');
});

test('critical AI routes carry the full auth → appAccess → usage-gate chain', () => {
  for (const path of ['/api/ai/stream', '/api/ai/invoke']) {
    const r = routeAt('POST', path);
    assert.ok(r, `${path} is registered`);
    const chain = r.chain;
    assert.ok(chain.includes('requireAuth'), `${path} has requireAuth`);
    assert.ok(chain.includes('requireAppAccess'), `${path} has requireAppAccess`);
    assert.ok(chain.includes('checkAiUsageLimit'), `${path} has checkAiUsageLimit`);
    assert.ok(
      chain.indexOf('requireAuth') < chain.indexOf('requireAppAccess')
        && chain.indexOf('requireAppAccess') < chain.indexOf('checkAiUsageLimit'),
      `${path} keeps requireAuth → requireAppAccess → checkAiUsageLimit order`,
    );
  }
});

test('every /api/admin route is gated by requireAuth then requireAdmin', () => {
  const adminRoutes = entries.filter((e) => e.kind === 'route' && e.path.startsWith('/api/admin/'));
  assert.ok(adminRoutes.length >= 9, 'admin surface present');
  for (const r of adminRoutes) {
    assert.equal(r.chain[0], 'requireAuth', `${r.path} starts with requireAuth`);
    assert.equal(r.chain[1], 'requireAdmin', `${r.path} has requireAdmin second`);
  }
});

test('upload routes use multer and are authenticated', () => {
  const uploads = entries.filter((e) => e.kind === 'route' && e.chain.includes('multerMiddleware'));
  assert.ok(uploads.length >= 6, 'multer upload surface present');
  for (const r of uploads) {
    assert.ok(r.chain.includes('requireAuth'), `${r.path} requires auth before accepting uploads`);
    assert.ok(
      r.chain.indexOf('requireAuth') < r.chain.indexOf('multerMiddleware'),
      `${r.path}: requireAuth runs before multer parses the multipart body`,
    );
  }
});

test('ElevenLabs custom-LLM alias trio stays registered (external API contract)', () => {
  for (const path of [
    '/api/ai/elevenlabs/llm',
    '/api/ai/elevenlabs/llm/chat/completions',
    '/api/ai/elevenlabs/llm/chat/completions/chat/completions',
  ]) {
    const r = routeAt('POST', path);
    assert.ok(r, `${path} is registered`);
    assert.ok(r.chain.includes('elevenCustomLlmHandler'), `${path} shares elevenCustomLlmHandler`);
  }
});
