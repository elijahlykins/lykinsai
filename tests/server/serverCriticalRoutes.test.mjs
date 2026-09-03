// ============================================================================
// tests/server/serverCriticalRoutes.test.mjs — critical endpoint smoke
// ============================================================================
// Characterizes the cheap, externally observable behavior of the highest-risk
// server surfaces WITHOUT contacting any real external service:
//   - the harness scrubs every .env secret to inert dummies, and
//   - every URL-shaped env var points at 127.0.0.1:9 (closed port), so any
//     unexpected outbound call fails instantly instead of leaving the box.
//
// These are the behaviors a future route extraction must not change:
// auth rejection codes, webhook signature rejection, body-parser limits and
// the image-route parser branch, CORS and security headers, secret-gated
// cron 401s, guest-stream input validation, and the file-proxy token gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import { startEphemeral, HARNESS_DUMMY_SECRET } from './harness.mjs';

const { baseUrl, close } = await startEphemeral();
test.after(() => close());

const get = (p, opts) => fetch(`${baseUrl}${p}`, opts);
const postJson = (p, body, headers = {}) =>
  fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ── Perimeter ───────────────────────────────────────────────────────────────

test('API responses carry the hardened security headers and no x-powered-by', async () => {
  const res = await get('/api/health');
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(res.headers.get('strict-transport-security') || '', /max-age=63072000/);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'none'/);
});

test('/oauth/* paths get the relaxed popup CSP (COOP unsafe-none)', async () => {
  // Must hit a REAL /oauth/ route: for unrouted paths Express 5's final 404
  // handler overwrites Content-Security-Policy with its own `default-src
  // 'none'` (COOP survives). The MCP callback rejects missing state while
  // retaining the popup middleware headers.
  const res = await get('/oauth/mcp/callback');
  assert.equal(res.headers.get('cross-origin-opener-policy'), 'unsafe-none');
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'unsafe-inline'/);
});

test('CORS: allowed dev origin is echoed with credentials + exposed headers', async () => {
  const res = await get('/api/health', { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  assert.match(
    res.headers.get('access-control-expose-headers') || '',
    /X-Model-Downgraded, X-Plan, X-Feature-Stripped/,
  );
});

test('CORS: disallowed origin gets NO allow-origin header (browser blocks it)', async () => {
  const res = await get('/api/health', { headers: { Origin: 'https://evil.example.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('CORS: OPTIONS preflight terminates with 204', async () => {
  const res = await fetch(`${baseUrl}/api/anything`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(res.status, 204);
});

test('the /api/ global rate limiter is active on post-limiter routes', async () => {
  const res = await get('/api/usage/me'); // 401s, but the limiter runs first
  const hasRateLimitHeader = [...res.headers.keys()].some((k) => k.toLowerCase().startsWith('ratelimit'));
  assert.ok(hasRateLimitHeader, 'expected a RateLimit-* header on routes behind app.use("/api/", globalLimiter)');
});

const hasRateLimitHeader = (res) =>
  [...res.headers.keys()].some((k) => k.toLowerCase().startsWith('ratelimit'));

test('pre-limiter routes carry their own dedicated perimeter limiter', async () => {
  // These register before app.use('/api/', globalLimiter) so the global
  // limiter never covers them; each must answer with RateLimit-* headers
  // from its dedicated perimeter limiter instead. (Closes the former
  // rate-limit-exemption DEFERRED SECURITY FINDING.)
  const health = await get('/api/health');
  assert.ok(hasRateLimitHeader(health), '/api/health runs behind healthLimiter');
  const fileProxy = await get('/f/zz-bogus-token');
  assert.ok(hasRateLimitHeader(fileProxy), '/f/:token runs behind fileProxyLimiter');
  const clientError = await postJson('/api/client-error', { message: 'limiter probe' });
  assert.ok(hasRateLimitHeader(clientError), '/api/client-error runs behind clientErrorLimiter');
  const webhook = await postJson('/api/stripe/webhook', {});
  assert.ok(hasRateLimitHeader(webhook), '/api/stripe/webhook runs behind stripeWebhookLimiter');
});

test('artifacts rebuild is rate limited AND behind requireAuth', async () => {
  // POST /api/artifacts/react/rebuild registers before the global limiter,
  // so it carries its own perimeter limiter. The limiter runs BEFORE
  // requireAuth (IP-keyed), so even this unauthenticated 401 shows the
  // RateLimit-* headers.
  const res = await fetch(`${baseUrl}/api/artifacts/react/rebuild`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 401, 'unauthenticated rebuild is rejected by requireAuth');
  assert.ok(hasRateLimitHeader(res), 'rebuild route runs behind artifactRebuildLimiter');
});

test('/oauth/* callback pages run behind the /oauth/ perimeter limiter', async () => {
  // Mounted OUTSIDE /api/, so the global limiter never matches them; the
  // dedicated app.use('/oauth/', ...) mount must cover every callback.
  const res = await get('/oauth/mcp/callback');
  assert.ok(hasRateLimitHeader(res), '/oauth/mcp/callback runs behind oauthCallbackLimiter');
});

test('unknown routes 404 via the Express default (no custom catch-all)', async () => {
  const res = await get('/api/zz-harness-does-not-exist');
  assert.equal(res.status, 404);
});

// ── Platform ────────────────────────────────────────────────────────────────

test('/api/health is public and returns the health JSON shape', async () => {
  const res = await get('/api/health');
  assert.ok([200, 503].includes(res.status), `health returns 200/503, got ${res.status}`);
  const body = await res.json();
  assert.ok(['ok', 'degraded'].includes(body.status));
  assert.ok(body.checks && typeof body.checks === 'object');
  assert.ok('database' in body.checks);
  assert.ok('secrets' in body.checks);
  assert.ok(typeof body.timestamp === 'string');
});

test('/f/:token rejects an invalid file token with 403', async () => {
  const res = await get('/f/zz-bogus-token');
  assert.equal(res.status, 403);
  assert.equal(await res.text(), 'Link expired or invalid');
});

test('/api/client-error accepts a valid report with 204', async () => {
  const res = await postJson('/api/client-error', { message: 'harness probe', name: 'Error' });
  assert.equal(res.status, 204);
});

test('/api/client-error rejects a malformed report with 400 (zod validate)', async () => {
  const res = await postJson('/api/client-error', { message: 12345 });
  assert.equal(res.status, 400);
});

test('/api/client-error: oversized fields are rejected by zod, not the 10kb parser', async () => {
  // CHARACTERIZATION (current behavior, do not "fix" during decomposition):
  // the global 1mb JSON parser runs BEFORE the route's own express.json
  // 10kb parser, which therefore never re-parses (body already consumed).
  // A 20kb body passes the parsers and is rejected by the zod field caps
  // with 400 — not 413. The effective unauthenticated body ceiling on this
  // route is the global 1mb, not 10kb. Recorded as a DEFERRED SECURITY
  // FINDING in tests/server/README.md.
  const res = await postJson('/api/client-error', { message: 'x'.repeat(20_000) });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'invalid_request');
});

// ── Body-parser branching (1mb default vs 12mb image-bearing AI routes) ────

const MB = 1024 * 1024;
const bigBody = { pad: 'x'.repeat(1.2 * MB) };

test('a >1mb JSON body 413s on a standard route (global 1mb parser)', async () => {
  const res = await postJson('/api/ai/local-tool-result', bigBody);
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, 'payload_too_large');
});

test('the same >1mb body is ACCEPTED by an image-bearing AI route (12mb parser branch)', async () => {
  // These paths are in IMAGE_BEARING_AI_ROUTES: the parser accepts the body,
  // so the request reaches requireAuth and 401s instead of 413ing.
  // agent-model is on the list because local screenshot reads post a data URL.
  const res = await postJson('/api/ai/invoke', bigBody);
  assert.equal(res.status, 401);
  const model = await postJson('/api/desktop/agent-model', bigBody);
  assert.equal(model.status, 401);
});

// ── Authentication ─────────────────────────────────────────────────────────

test('critical authenticated routes 401 without an Authorization header', async () => {
  const cases = [
    ['POST', '/api/ai/stream'],
    ['POST', '/api/ai/invoke'],
    ['GET', '/api/billing/me'],
    ['GET', '/api/usage/me'],
    ['GET', '/api/admin/usage/overview'],
    ['GET', '/api/mcp/connections'],
    ['GET', '/api/mcp/catalog'],
    ['GET', '/api/mcp/attention'],
    ['POST', '/api/mcp/connections'],
    ['POST', '/api/ai/vault-search'],
    ['POST', '/api/storage/signed-url'],
    ['GET', '/api/youtube/search'],
    ['POST', '/api/synthesis/reindex'],
  ];
  for (const [method, path] of cases) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.equal(res.status, 401, `${method} ${path} without auth → 401 (got ${res.status})`);
    const body = await res.json();
    assert.equal(body.error, 'Missing or invalid Authorization header');
  }
});

test('requireAuth fails CLOSED (503) when the auth backend is unreachable', async () => {
  // With a Bearer token present, requireAuth verifies against Supabase — which
  // the harness points at a closed loopback port. The contract is 503, never
  // a silent bypass. (Retries: 3 attempts with backoff, ~1s total.)
  const res = await get('/api/usage/me', { headers: { Authorization: 'Bearer zz-harness-token' } });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, 'Auth verification failed');
});

// ── Billing / webhooks ──────────────────────────────────────────────────────

test('stripe webhook rejects an unsigned payload with 400 (signature contract)', async () => {
  const res = await postJson('/api/stripe/webhook', { type: 'checkout.session.completed' });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /^Webhook Error:/);
});

test('billing/stripe-config is public and returns the publishable-key shape', async () => {
  // CHARACTERIZATION: this endpoint is intentionally unauthenticated (it
  // vends the publishable key for embedded checkout) — a DEFERRED BILLING
  // FINDING, preserved as-is. 200 + { publishableKey } when the env var is
  // set, 503 { error: 'stripe_not_configured' } when it is not.
  const res = await get('/api/billing/stripe-config');
  assert.ok([200, 503].includes(res.status), `got ${res.status}`);
  const body = await res.json();
  if (res.status === 200) {
    assert.ok(typeof body.publishableKey === 'string' && body.publishableKey.length > 0);
  } else {
    assert.equal(body.error, 'stripe_not_configured');
  }
});

test('public toolkit catalog is unauthenticated and never includes connection state', async () => {
  const res = await get('/api/public/toolkits');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(Array.isArray(body.tools), true);
  assert.equal(body.tools.every((t) => !('connected' in t) && !('connectionId' in t)), true);
});

test('public model catalog is unauthenticated and never includes pricing', async () => {
  const res = await get('/api/public/models');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(Array.isArray(body.models), true);
  assert.ok(body.models.length >= 8);
  assert.equal(
    body.models.every((m) => !('pricing' in m) && !('capabilities' in m) && typeof m.name === 'string' && typeof m.logoUrl === 'string'),
    true,
  );
});

test('every non-public billing route 401s without an Authorization header', async () => {
  // Characterizes the auth perimeter of the billing boundary extracted in
  // Wave 6 (server/routes/billing.routes.js). requireAuth runs before any
  // zod validation or Stripe access, so unauthenticated calls must always
  // short-circuit with the shared 401 shape.
  const cases = [
    ['GET', '/api/billing/me'],
    ['POST', '/api/billing/checkout'],
    ['GET', '/api/billing/credits'],
    ['POST', '/api/billing/topup'],
    ['POST', '/api/billing/trial-checkout'],
    ['POST', '/api/billing/portal'],
    ['GET', '/api/billing/waitlist'],
    ['POST', '/api/billing/waitlist'],
  ];
  for (const [method, path] of cases) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
    });
    assert.equal(res.status, 401, `${method} ${path} without auth → 401 (got ${res.status})`);
    const body = await res.json();
    assert.equal(body.error, 'Missing or invalid Authorization header');
  }
});

// ── Secret-gated cron endpoints ─────────────────────────────────────────────

test('poll-due cron endpoints 401 without the shared secret', async () => {
  for (const path of ['/api/feeds/poll-due', '/api/ai/cursor-builds/poll-due']) {
    const res = await postJson(path, {});
    assert.equal(res.status, 401, `${path} without secret → 401`);
  }
});

test('poll-due rejects a wrong secret of the correct length (timing-safe compare path)', async () => {
  const wrong = HARNESS_DUMMY_SECRET.slice(0, -1) + 'X';
  const res = await postJson('/api/feeds/poll-due', {}, { Authorization: `Bearer ${wrong}` });
  assert.equal(res.status, 401);
});

test('retired Discover ingest route is absent', async () => {
  const res = await postJson('/api/discover/ingest', {});
  assert.equal(res.status, 404);
});

// ── Chat / AI ───────────────────────────────────────────────────────────────

test('guest stream validates input before any provider call (400 on empty prompt)', async () => {
  const res = await postJson('/api/ai/stream-guest', {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'Prompt is required');
});

test('ElevenLabs custom-LLM proxy rejects unauthenticated calls', async () => {
  const res = await postJson('/api/ai/elevenlabs/llm/chat/completions', { messages: [] });
  assert.ok([401, 403, 503].includes(res.status), `shared-secret gate holds (got ${res.status})`);
});
