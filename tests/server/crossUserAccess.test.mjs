// HTTP-level User A / User B ID-substitution tests against production route
// registrars. Auth is a Bearer→user map that sets req.user the same way
// requireAuth does after JWT verification. The database is a filter-faithful
// fake: omitting user_id from a query WOULD return the other user's row.
// These tests fail if a production handler drops ownership enforcement.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { registerStorageRoutes } from '../../server/routes/storage.routes.js';
import { registerProjectInviteRoutes } from '../../server/routes/platform.routes.js';
import { registerDesktopRoutes } from '../../server/routes/desktop.routes.js';
import { registerAccountRoutes } from '../../server/routes/account.routes.js';
import { registerSynthesisMaintenanceRoutes, registerSynthesisRoutes } from '../../server/routes/synthesis.routes.js';
import { registerFeedsRoutes } from '../../server/routes/feeds.routes.js';
import { createSupabaseMemoryStore } from '../../server/memory/memoryStore.js';
import { assertUserPath } from '../../lib/exterior/capabilityStorage.js';
import { enrichVaultNoteSummary, backfillVaultText } from '../../server/ai/vaultEnrichment.js';

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TOKEN_A = 'token-user-a';
const TOKEN_B = 'token-user-b';
const CHAT_A = '11111111-1111-4111-8111-111111111111';
const CHAT_B = '22222222-2222-4222-8222-222222222222';
const VAULT_A = '33333333-3333-4333-8333-333333333333';
const PROJECT_A = '44444444-4444-4444-8444-444444444444';
const STEWARD_A = '55555555-5555-4555-8555-555555555555';
const MEMORY_A = '66666666-6666-4666-8666-666666666666';
const FEED_A = '77777777-7777-4777-8777-777777777777';

function matches(row, filters) {
  return filters.every((f) => {
    if (f.op === 'in') return (f.val || []).includes(row[f.col]);
    if (f.op === 'neq') return String(row[f.col]) !== String(f.val);
    if (f.op === 'is') return row[f.col] == f.val;
    return String(row[f.col]) === String(f.val);
  });
}

function createFakeClient(seedRows) {
  const store = seedRows.map((r) => ({ ...r }));
  const signed = [];
  function from(table) {
    const filters = [];
    let mode = 'select';
    let patch = null;
    let columns = '*';
    const api = {
      select(cols = '*') {
        columns = cols;
        return api;
      },
      insert(row) {
        mode = 'insert';
        patch = row;
        return api;
      },
      update(row) {
        mode = 'update';
        patch = row;
        return api;
      },
      delete() {
        mode = 'delete';
        return api;
      },
      eq(col, val) {
        filters.push({ col, val });
        return api;
      },
      neq(col, val) {
        filters.push({ col, op: 'neq', val });
        return api;
      },
      in(col, val) {
        filters.push({ col, op: 'in', val });
        return api;
      },
      is(col, val) {
        filters.push({ col, op: 'is', val });
        return api;
      },
      or() {
        return api;
      },
      order() {
        return api;
      },
      limit() {
        return api;
      },
      gte() {
        return api;
      },
      maybeSingle() {
        return execute('one');
      },
      single() {
        return execute('one');
      },
      then(resolve, reject) {
        return execute('many').then(resolve, reject);
      },
    };
    async function execute(shape) {
      if (mode === 'insert') {
        const row = { table, ...patch };
        if (row.id && store.some((r) => r.table === table && String(r.id) === String(row.id))) {
          return { data: null, error: { message: 'duplicate key', code: '23505' } };
        }
        store.push(row);
        return { data: row, error: null };
      }
      const hit = store.filter((r) => r.table === table && matches(r, filters));
      if (mode === 'update') {
        for (const row of hit) Object.assign(row, patch);
      }
      if (mode === 'delete') {
        for (const row of hit) {
          const idx = store.indexOf(row);
          if (idx >= 0) store.splice(idx, 1);
        }
      }
      const data = hit;
      if (shape === 'one') return { data: data[0] || null, error: null };
      return { data, error: null };
    }
    return api;
  }
  return {
    store,
    signed,
    from,
    storage: {
      from() {
        return {
          async createSignedUrl(p) {
            signed.push(p);
            return { data: { signedUrl: `https://signed.example/${p}` } };
          },
        };
      },
    },
  };
}

function seed() {
  return createFakeClient([
    { table: 'lykn_chats', id: CHAT_A, user_id: USER_A, title: 'A secret chat' },
    { table: 'lykn_chats', id: CHAT_B, user_id: USER_B, title: 'B chat' },
    { table: 'lykn_chat_states', chat_id: CHAT_A, user_id: USER_A, state: { secret: true } },
    {
      table: 'vault_items',
      id: VAULT_A,
      user_id: USER_A,
      title: 'A vault note',
      content: 'classified',
    },
    { table: 'lykn_projects', id: PROJECT_A, user_id: USER_A, name: 'A project', status: 'active' },
    {
      table: 'lykn_steward_items',
      id: STEWARD_A,
      user_id: USER_A,
      title: 'A task',
      spec: 'do not touch',
      status: 'backlog',
    },
    {
      table: 'lykn_memory_documents',
      id: MEMORY_A,
      user_id: USER_A,
      path: 'profile.md',
      name: 'Profile',
      markdown: 'A memory',
      status: 'active',
      version: 1,
    },
    {
      table: 'rss_feeds',
      id: FEED_A,
      user_id: USER_A,
      feed_url: 'https://a.example/feed.xml',
      title: 'A feed',
      status: 'active',
    },
  ]);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  const users = {
    [TOKEN_A]: { id: USER_A, email: 'a@example.com' },
    [TOKEN_B]: { id: USER_B, email: 'b@example.com' },
  };
  const user = users[token];
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

const passthrough = (_req, _res, next) => next();

function memCache() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

function sha256(s) {
  return String(s || '');
}

async function startApp(client) {
  const app = express();
  app.use(express.json());
  registerStorageRoutes(app, {
    requireAuth,
    requireAppAccess: passthrough,
    aiLimiter: passthrough,
    describeLimiter: passthrough,
    supabaseAdmin: client,
    sha256,
    SIGNED_URL_TTL_SECONDS: 60,
    OUTPUT_CAPS: {},
    enrichVaultNoteSummary,
    backfillVaultText,
    findAttachmentsMarkerSpan: () => null,
    extractBodyAfterAttachmentsMarker: () => '',
    replaceSynthesisChunks: async () => 0,
    createSynthesisUserClient: () => null,
  });
  registerProjectInviteRoutes(app, {
    requireAuth,
    supabaseAdmin: client,
    resendClient: null,
    findAuthUserByEmail: async () => null,
    pickUserDisplayName: () => 'User',
  });
  registerDesktopRoutes(app, {
    requireAuth,
    requireAppAccess: passthrough,
    aiLimiter: passthrough,
    supabaseAdmin: client,
    sha256,
    memCache,
  });
  registerAccountRoutes(app, {
    requireAuth,
    supabaseAdmin: client,
    stripe: null,
  });
  registerSynthesisMaintenanceRoutes(app, {
    requireAuth,
    requireAppAccess: passthrough,
    synthesisLimiter: passthrough,
    supabaseAdmin: client,
    createSynthesisUserClient: () => null,
    safeErr: (e, f) => f,
    enrichVaultNoteSummary,
    backfillVaultText,
    replaceSynthesisChunks: async () => 0,
  });
  registerSynthesisRoutes(app, {
    requireAuth,
    requireAppAccess: passthrough,
    synthesisLimiter: passthrough,
    supabaseAdmin: client,
    createSynthesisUserClient: () => null,
    deleteSynthesisChunksForSource: async () => {},
    replaceSynthesisChunks: async () => 0,
  });
  registerFeedsRoutes(app, {
    requireAuth,
    supabaseAdmin: client,
    isUrlSafe: async () => true,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

const { client, baseUrl, close } = await (async () => {
  const c = seed();
  const srv = await startApp(c);
  return { client: c, ...srv };
})();
test.after(() => close());

async function asUser(token, method, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: authHeaders(token),
    body: body == null ? undefined : JSON.stringify(body),
  });
}

test('unauthenticated ID substitution is rejected before ownership checks', async () => {
  const res = await fetch(`${baseUrl}/api/storage/signed-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ storagePath: `${USER_A}/secret.png` }),
  });
  assert.equal(res.status, 401);
});

test('User B cannot list User A chats', async () => {
  const res = await asUser(TOKEN_B, 'GET', '/api/desktop/chats');
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = (body.chats || []).map((c) => c.id);
  assert.equal(ids.includes(CHAT_A), false);
});

test('User B cannot overwrite User A chat state via ID substitution', async () => {
  const res = await asUser(TOKEN_B, 'POST', '/api/desktop/chats/save', {
    chatId: CHAT_A,
    title: 'hijacked',
    messages: [{ role: 'user', content: 'steal this thread please' }],
  });
  assert.notEqual(res.status, 200);
  const still = client.store.find((r) => r.table === 'lykn_chats' && r.id === CHAT_A);
  assert.equal(still.user_id, USER_A);
  assert.equal(still.title, 'A secret chat');
});

test('User B cannot rename User A chat by substituting chatId', async () => {
  const res = await asUser(TOKEN_B, 'POST', '/api/ai/name-chat', {
    chatId: CHAT_A,
    userMessage: 'please name this conversation now',
    assistantReply: 'this is long enough to pass the too_short guard on the namer',
  });
  assert.ok([200, 503].includes(res.status), `got ${res.status}`);
  const body = await res.json();
  if (res.status === 200) {
    assert.equal(body.applied, false);
    assert.equal(body.reason, 'not_found');
  }
  const still = client.store.find((r) => r.table === 'lykn_chats' && r.id === CHAT_A);
  assert.equal(still.title, 'A secret chat');
});

test('User B cannot enrich User A vault note by substituting noteId', async () => {
  const res = await asUser(TOKEN_B, 'POST', '/api/vault/enrich-note', { noteId: VAULT_A });
  assert.equal(res.status, 404);
  const still = client.store.find((r) => r.table === 'vault_items' && r.id === VAULT_A);
  assert.equal(still.content, 'classified');
});

test('User B cannot mint a signed URL for User A storage path', async () => {
  const res = await asUser(TOKEN_B, 'POST', '/api/storage/signed-url', {
    storagePath: `${USER_A}/file-a/original.png`,
    bucket: 'user-files',
  });
  assert.equal(res.status, 403);
  assert.equal(client.signed.includes(`${USER_A}/file-a/original.png`), false);
});

test('User B cannot mint a file-proxy URL for User A storage path', async () => {
  const res = await asUser(TOKEN_B, 'POST', '/api/storage/file-proxy-url', {
    storagePath: `${USER_A}/file-a/original.png`,
    bucket: 'user-files',
  });
  assert.equal(res.status, 403);
});

test('User B cannot use ../ to escape their storage namespace', async () => {
  const res = await asUser(TOKEN_B, 'POST', '/api/storage/signed-url', {
    storagePath: `${USER_B}/../${USER_A}/secret.png`,
    bucket: 'user-files',
  });
  assert.equal(res.status, 403);
  const check = assertUserPath(USER_B, `${USER_B}/../${USER_A}/secret.png`);
  assert.equal(check.ok, false);
});

test('User B cannot update User A steward item by substituting :id', async () => {
  const res = await asUser(TOKEN_B, 'PATCH', `/api/steward/items/${STEWARD_A}`, {
    status: 'cancelled',
  });
  assert.equal(res.status, 404);
  const still = client.store.find((r) => r.table === 'lykn_steward_items' && r.id === STEWARD_A);
  assert.equal(still.status, 'backlog');
});

test('User B cannot invite to User A project by substituting project_id', async () => {
  const res = await asUser(TOKEN_B, 'POST', '/api/projects/invite', {
    project_id: PROJECT_A,
    email: 'victim@example.com',
  });
  assert.equal(res.status, 404);
});

test('User B cannot patch or delete User A RSS feed by substituting :id', async () => {
  const patch = await asUser(TOKEN_B, 'PATCH', `/api/feeds/${FEED_A}`, { status: 'paused' });
  assert.equal(patch.status, 404);
  const del = await asUser(TOKEN_B, 'DELETE', `/api/feeds/${FEED_A}`);
  assert.ok([200, 404].includes(del.status), `delete status ${del.status}`);
  const still = client.store.find((r) => r.table === 'rss_feeds' && r.id === FEED_A);
  assert.ok(still);
  assert.equal(still.user_id, USER_A);
  assert.equal(still.status, 'active');
});

test('User B cannot reindex User A vault note by substituting sourceId', async () => {
  const res = await asUser(TOKEN_B, 'POST', '/api/synthesis/reindex', {
    sourceType: 'vault_note',
    sourceId: VAULT_A,
    text: 'hijack embeddings',
  });
  assert.equal(res.status, 404);
});

test('owner can still read their own chat list', async () => {
  const res = await asUser(TOKEN_A, 'GET', '/api/desktop/chats');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal((body.chats || []).some((c) => c.id === CHAT_A), true);
});

test('Memory store rejects User B update/delete of User A document by id', async () => {
  const store = createSupabaseMemoryStore(client);
  const updated = await store.updateDocument(USER_B, MEMORY_A, 1, { markdown: 'hijack' });
  assert.equal(updated.ok, false);
  const deleted = await store.hardDeleteDocument(USER_B, MEMORY_A);
  assert.equal(deleted.deleted, false);
  const still = await store.getDocument(USER_A, 'profile.md');
  assert.equal(still.id, MEMORY_A);
  assert.equal(still.markdown, 'A memory');
});

test('dropping user_id from a lookup would leak: the fake client is filter-faithful', async () => {
  const { data } = await client.from('vault_items').select('id').eq('id', VAULT_A).maybeSingle();
  assert.equal(data?.id, VAULT_A);
});
