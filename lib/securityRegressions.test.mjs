// Usage: node --test lib/securityRegressions.test.mjs
//
// Static source guards for the SECURITY_REPORT_07 and API_SECURITY_REPORT_08
// remediations. These scan server.js rather than exercising it (the file is
// not importable in isolation) and fail if a reverted pattern reappears.
//
// Since the server decomposition (Wave 1+), route handlers live in
// server.js, server/routes/*.js, server/ai/*.js, and server/services/*.js,
// so the scan concatenates those trees — the guards follow the code
// wherever it is registered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

async function listJsFiles(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listJsFiles(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const routeFiles = await listJsFiles(join(root, 'server', 'routes'));
const aiFiles = await listJsFiles(join(root, 'server', 'ai'));
const serviceFiles = await listJsFiles(join(root, 'server', 'services'));
const serverSrc = (
  await Promise.all(
    [join(root, 'server.js'), ...routeFiles, ...aiFiles, ...serviceFiles].map((p) => readFile(p, 'utf8')),
  )
).join('\n');

test('no admin-first client fallback: RLS must stay load-bearing (P2)', () => {
  // `supabaseAdmin || createSynthesisUserClient(...)` makes the user-scoped
  // client dead code and bypasses RLS on that path. The correct order is
  // user-client-first with admin as the no-auth-header fallback.
  const adminFirst = serverSrc.match(/supabaseAdmin\s*\|\|\s*createSynthesisUserClient/g) || [];
  assert.deepEqual(adminFirst, [], 'found admin-first client fallback(s); flip to createSynthesisUserClient(...) || supabaseAdmin');
});

test('lykn_chat_states is never written via an unscoped upsert (P1)', () => {
  // An upsert keyed only on chat_id overwrites whatever row holds that id,
  // regardless of owner. Writes must be scoped by user_id.
  const idx = serverSrc.indexOf("from('lykn_chat_states')");
  assert.notEqual(idx, -1);
  let at = idx;
  while (at !== -1) {
    const window = serverSrc.slice(at, at + 400);
    assert.ok(!/\.upsert\(/.test(window), `unscoped upsert near lykn_chat_states at offset ${at}`);
    at = serverSrc.indexOf("from('lykn_chat_states')", at + 1);
  }
});

test('no route echoes a raw error message to the client (F-08-01)', () => {
  // Route-local catch blocks must route through safeErr() (prod-safe) rather
  // than returning err.message / error.message straight to the wire. The one
  // legitimate exception is the global error handler's dev-only branch, which
  // is already guarded by `if (NODE_ENV === 'production')` above it and is
  // identified here by its 'request_failed' fallback.
  const leaks = (serverSrc.match(/error:\s*(?:err|error)\?\.message\s*\|\|\s*'[^']+'/g) || [])
    .filter((m) => !m.includes('request_failed'));
  assert.deepEqual(leaks, [], 'found route(s) returning a raw error message; wrap with safeErr(err, fallback)');
});

test('no route forwards raw upstream error bodies to the client (F-08-01)', () => {
  // The YouTube/Gemini/OpenAI proxy paths logged upstream detail server-side
  // but must not ship it to clients via details/fullError fields.
  const detailLeaks = serverSrc.match(/\b(?:details|fullError):\s*(?:data|error)\b/g) || [];
  assert.deepEqual(detailLeaks, [], 'found upstream error body forwarded to client; log it server-side only');
});

test('vault reconciler delete mode requires the dedicated delete secret (F-08-02)', () => {
  // Destructive deletion must depend on verifyReconcilerDeleteSecret, not on
  // the shared BACKFILL_SECRET bearer alone.
  assert.ok(
    /function verifyReconcilerDeleteSecret\b/.test(serverSrc),
    'verifyReconcilerDeleteSecret helper is missing',
  );
  const idx = serverSrc.indexOf("app.post('/api/vault/reconcile'");
  assert.notEqual(idx, -1);
  const routeBody = serverSrc.slice(idx, idx + 1600);
  assert.ok(
    /verifyReconcilerDeleteSecret\(req\)/.test(routeBody),
    'reconcile route does not consult verifyReconcilerDeleteSecret',
  );
  // deleteLeaked must be conjoined with the secret check, not derived from the
  // request flag + env enable alone.
  assert.ok(
    /const deleteLeaked = deleteRequested && deleteEnabled && deleteSecretOk/.test(routeBody),
    'deleteLeaked is not gated on the dedicated delete secret',
  );
});

test('user-owned HTTP routes import the owner-required query helpers', async () => {
  const files = [
    join(root, 'server', 'routes', 'desktop.routes.js'),
    join(root, 'server', 'routes', 'platform.routes.js'),
    join(root, 'server', 'routes', 'storage.routes.js'),
    join(root, 'server', 'routes', 'account.routes.js'),
    join(root, 'server', 'routes', 'files.routes.js'),
    join(root, 'server', 'routes', 'synthesis.routes.js'),
    join(root, 'server', 'routes', 'feeds.routes.js'),
    join(root, 'server', 'ai', 'vaultEnrichment.js'),
    join(root, 'server', 'ai', 'chatRetrieval.js'),
    join(root, 'server', 'memory', 'memoryStore.js'),
  ];
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    assert.match(
      src,
      /userOwnedAccess/,
      `${file} must use lib/security/userOwnedAccess.js for user-owned lookups`,
    );
  }
  assert.match(serverSrc, /assertUserPath/);
});
