// ============================================================================
// tests/server/serverRouteManifest.test.mjs — route registration contract
// ============================================================================
// Compares the LIVE Express registration surface against the checked-in
// manifest (serverRouteManifest.json). This is the primary safety net for
// server.js decomposition: after moving a domain into a router module, this
// suite mechanically proves no route was lost, renamed, duplicated, method-
// changed, middleware-changed, or REORDERED.
//
// If a surface change is intentional, regenerate the manifest with
//   npm run test:server:update-manifest
// and review the JSON diff like code.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from './harness.mjs';
import { buildManifest, findDuplicates, analyzeOrderHazards } from './routeSurface.mjs';

const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'serverRouteManifest.json');
const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const app = await loadApp();
const actual = buildManifest(app);

const routeKey = (e) => `${e.methods.join(',')} ${e.path}`;
const expectedRoutes = expected.entries.filter((e) => e.kind === 'route');
const actualRoutes = actual.entries.filter((e) => e.kind === 'route');

test('route count matches the manifest', () => {
  assert.equal(
    actualRoutes.length,
    expected.routeCount,
    `route count changed: manifest has ${expected.routeCount}, live app has ${actualRoutes.length}`,
  );
});

test('app-level middleware count matches the manifest', () => {
  assert.equal(actual.middlewareCount, expected.middlewareCount);
});

test('no route was lost or renamed', () => {
  const live = new Set(actualRoutes.map(routeKey));
  const missing = expectedRoutes.map(routeKey).filter((k) => !live.has(k));
  assert.deepEqual(missing, [], `routes missing from live app: ${missing.join(' | ')}`);
});

test('no unexpected new route appeared', () => {
  const known = new Set(expectedRoutes.map(routeKey));
  const added = actualRoutes.map(routeKey).filter((k) => !known.has(k));
  assert.deepEqual(added, [], `routes not in manifest: ${added.join(' | ')}`);
});

test('no duplicate method+path registrations', () => {
  assert.deepEqual(findDuplicates(actual.entries), []);
});

test('registration ORDER is unchanged (Express matches in registration order)', () => {
  const expectedOrder = expected.entries.map((e) => (e.kind === 'route' ? routeKey(e) : `USE:${e.mount}:${e.argc}`));
  const actualOrder = actual.entries.map((e) => (e.kind === 'route' ? routeKey(e) : `USE:${e.mount}:${e.argc}`));
  assert.deepEqual(actualOrder, expectedOrder);
});

test('per-route middleware chains are unchanged', () => {
  const expectedChains = Object.fromEntries(expectedRoutes.map((e) => [routeKey(e), e.chain]));
  for (const r of actualRoutes) {
    const want = expectedChains[routeKey(r)];
    if (!want) continue; // covered by the lost/new-route tests above
    assert.deepEqual(
      r.chain,
      want,
      `middleware chain changed on ${routeKey(r)}: expected [${want}], got [${r.chain}]`,
    );
  }
});

test('param/static ordering hazards are unchanged', () => {
  assert.deepEqual(analyzeOrderHazards(actual.entries), expected.orderHazards);
});

test('domain and risk-flag classification is unchanged', () => {
  const expectedMeta = Object.fromEntries(
    expectedRoutes.map((e) => [routeKey(e), { domain: e.domain, flags: e.flags }]),
  );
  for (const r of actualRoutes) {
    const want = expectedMeta[routeKey(r)];
    if (!want) continue;
    assert.deepEqual({ domain: r.domain, flags: r.flags }, want, `classification changed on ${routeKey(r)}`);
  }
});
