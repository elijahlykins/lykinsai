import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createConnectionService,
  createMemoryConnectStateStore,
  managedProviderById,
  managedProviderByToolkit,
  MANAGED_PROVIDERS,
  PUBLIC_CATALOG_USER_ID,
} from './connectionService.js';
import {
  ManagedConnectionError,
  MANAGED_CONNECTION_ERROR_CODES,
} from './composioGateway.js';

const API_BASE = 'https://api.lykn.io';

const TEST_CATALOG = [
  { slug: 'gmail', name: 'Gmail', logoUrl: 'https://logos.example/gmail.svg', isNoAuth: false },
  { slug: 'slack', name: 'Slack', logoUrl: 'https://logos.example/slack.svg', isNoAuth: false },
  { slug: 'notion', name: 'Notion', logoUrl: null, isNoAuth: false },
  { slug: 'hackernews', name: 'Hacker News', logoUrl: null, isNoAuth: true },
];

function makeGateway({ configured = true, state, completeAuthResult, catalog, connected } = {}) {
  const calls = {
    status: [],
    links: [],
    revoked: [],
    deleted: [],
    completed: [],
    catalog: [],
    firstPage: [],
    warmed: [],
  };
    const gateway = {
    isConfigured: () => configured,
    async listToolkitCatalog(userId) {
      calls.catalog.push(userId);
      return catalog ?? TEST_CATALOG;
    },
    async listToolkitFirstPage(userId, { limit = 50 } = {}) {
      calls.firstPage.push(userId);
      return (catalog ?? TEST_CATALOG).slice(0, limit);
    },
    warmToolkitCatalog(userId) {
      calls.warmed.push(userId);
    },
    async listConnectedToolkits() {
      return connected ?? {};
    },
    async getToolkitConnection(userId, toolkit) {
      calls.status.push({ userId, toolkit });
      return state ?? { connected: false, status: 'disconnected', connectedAccountId: null };
    },
    async createConnectLink(userId, toolkit, opts) {
      calls.links.push({ userId, toolkit, opts });
      return { redirectUrl: 'https://connect.composio.dev/link/ln_abc' };
    },
    async completeAuth(userId, sessionUri) {
      calls.completed.push({ userId, sessionUri });
      if (completeAuthResult instanceof Error) throw completeAuthResult;
      return completeAuthResult ?? { connectedAccountId: 'ca_1', toolkitSlug: 'gmail' };
    },
    async revokeAtProvider(id) {
      calls.revoked.push(id);
      return { revoked: true };
    },
    async deleteConnectedAccount(id) {
      calls.deleted.push(id);
      return { deleted: true };
    },
  };
  return { gateway, calls };
}

function makeService(overrides = {}) {
  const { gateway, calls } = makeGateway(overrides);
  const stateStore = overrides.stateStore || createMemoryConnectStateStore(overrides.storeOpts);
  const service = createConnectionService({
    gateway,
    stateStore,
    publicApiBase: API_BASE,
    logger: { log() {}, warn() {} },
    callbackGrace: overrides.callbackGrace || { attempts: 3, delayMs: 0 },
    sleep: async () => {},
  });
  return { service, calls, stateStore };
}

test('gmail is a registered managed provider on the composio backend', () => {
  const gmail = managedProviderById('gmail');
  assert.equal(gmail.backend, 'composio');
  assert.equal(gmail.toolkit, 'gmail');
  assert.equal(managedProviderByToolkit('gmail')?.id, 'gmail');
  assert.equal(managedProviderById('slack'), null);
});

test('connect issues a one-shot state bound to the user and returns a Connect Link', async () => {
  const { service, calls, stateStore } = makeService();
  const result = await service.connect('user-1', 'gmail');
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://connect.composio.dev/link/ln_abc');
  assert.equal(calls.links[0].userId, 'user-1');
  const callbackUrl = new URL(calls.links[0].opts.callbackUrl);
  assert.equal(callbackUrl.origin, API_BASE);
  assert.equal(callbackUrl.pathname, '/oauth/connections/callback');
  const state = callbackUrl.searchParams.get('state');
  assert.ok(state, 'callback carries the one-shot state');
  const bound = await stateStore.consume(state);
  assert.deepEqual(bound, { userId: 'user-1', providerId: 'gmail' });
});

test('connect rejects unknown/auth-less providers and missing users', async () => {
  const { service } = makeService();
  const rejectsAsUnknown = (providerId) =>
    assert.rejects(
      service.connect('user-1', providerId),
      (e) =>
        e instanceof ManagedConnectionError &&
        e.code === MANAGED_CONNECTION_ERROR_CODES.UNKNOWN_PROVIDER,
    );
  await rejectsAsUnknown('notarealapp'); // not in the catalog
  await rejectsAsUnknown('hackernews'); // in the catalog but needs no auth
  await rejectsAsUnknown('../evil'); // invalid slug shape never reaches the catalog
  await assert.rejects(service.connect('', 'gmail'), (e) => /authenticated/i.test(e.message));
});

test('connect works for any auth toolkit in the catalog, not just curated providers', async () => {
  const { service, calls, stateStore } = makeService();
  const result = await service.connect('user-1', 'slack');
  assert.equal(result.ok, true);
  assert.equal(calls.links[0].toolkit, 'slack');
  const state = new URL(calls.links[0].opts.callbackUrl).searchParams.get('state');
  assert.deepEqual(await stateStore.consume(state), { userId: 'user-1', providerId: 'slack' });
});

test('completeCallback re-reads authoritative state and succeeds only when connected', async () => {
  const { service, calls, stateStore } = makeService({
    state: { connected: true, status: 'connected', connectedAccountId: 'ca_9' },
  });
  const state = await stateStore.issue({ userId: 'user-1', providerId: 'gmail' });
  const result = await service.completeCallback({ state });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'gmail');
  assert.equal(result.userId, 'user-1');
  assert.equal(result.status.connectionId, 'ca_9');
  // Verification queried the backend for the state-bound user, not any
  // value from the callback query string.
  assert.deepEqual(calls.status.at(-1), { userId: 'user-1', toolkit: 'gmail' });
});

test('completeCallback rejects replayed, unknown, and expired states', async () => {
  const { service, stateStore } = makeService({
    state: { connected: true, status: 'connected', connectedAccountId: 'ca_9' },
  });
  const state = await stateStore.issue({ userId: 'user-1', providerId: 'gmail' });
  assert.equal((await service.completeCallback({ state })).ok, true);
  const replay = await service.completeCallback({ state });
  assert.deepEqual(replay, { ok: false, error: 'invalid_or_expired_state' });
  const unknown = await service.completeCallback({ state: 'nope' });
  assert.equal(unknown.error, 'invalid_or_expired_state');

  let clock = 0;
  const expiringStore = createMemoryConnectStateStore({ now: () => clock });
  const { service: expiringService } = makeService({ stateStore: expiringStore });
  const staleState = await expiringStore.issue({ userId: 'user-1', providerId: 'gmail' });
  clock = 11 * 60 * 1000;
  const expired = await expiringService.completeCallback({ state: staleState });
  assert.equal(expired.error, 'invalid_or_expired_state');
});

test('completeCallback reports not_connected when authorization did not finish', async () => {
  const { service, stateStore } = makeService({
    state: { connected: false, status: 'pending', connectedAccountId: 'ca_pending' },
  });
  const state = await stateStore.issue({ userId: 'user-1', providerId: 'gmail' });
  const result = await service.completeCallback({ state });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_connected');
});

test('completeCallback waits out the pending->active race before failing', async () => {
  // Composio may still report the account as pending at the instant the
  // OAuth redirect lands; the grace retries must catch the flip to active.
  const { gateway } = makeGateway();
  const answers = [
    { connected: false, status: 'pending', connectedAccountId: 'ca_race' },
    { connected: false, status: 'pending', connectedAccountId: 'ca_race' },
    { connected: true, status: 'connected', connectedAccountId: 'ca_race' },
  ];
  gateway.getToolkitConnection = async () => answers.shift() ?? answers.at(-1);
  const stateStore = createMemoryConnectStateStore();
  const service = createConnectionService({
    gateway,
    stateStore,
    publicApiBase: API_BASE,
    logger: { log() {}, warn() {} },
    callbackGrace: { attempts: 3, delayMs: 0 },
    sleep: async () => {},
  });
  const state = await stateStore.issue({ userId: 'user-1', providerId: 'gmail' });
  const result = await service.completeCallback({ state });
  assert.equal(result.ok, true);
  assert.equal(result.status.status, 'connected');
});

test('completeVerifiedCallback binds the server-derived user to complete_auth', async () => {
  const { service, calls } = makeService({
    state: { connected: true, status: 'connected', connectedAccountId: 'ca_1' },
  });
  const result = await service.completeVerifiedCallback('user-7', { sessionUri: 'uri-1' });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'gmail');
  assert.deepEqual(calls.completed, [{ userId: 'user-7', sessionUri: 'uri-1' }]);
});

test('completeVerifiedCallback resolves catalog toolkits and refuses unknown ones', async () => {
  const { service } = makeService({
    state: { connected: true, status: 'connected', connectedAccountId: 'ca_2' },
    completeAuthResult: { connectedAccountId: 'ca_2', toolkitSlug: 'slack' },
  });
  const ok = await service.completeVerifiedCallback('user-1', { sessionUri: 'uri' });
  assert.equal(ok.ok, true);
  assert.equal(ok.provider, 'slack');

  const { service: refusing } = makeService({
    completeAuthResult: { connectedAccountId: 'ca_3', toolkitSlug: 'notarealapp' },
  });
  const result = await refusing.completeVerifiedCallback('user-1', { sessionUri: 'uri' });
  assert.deepEqual(result, { ok: false, error: 'unknown_provider' });
});

test('status is unconfigured without a backend and never exposes credentials', async () => {
  const { service } = makeService({ configured: false });
  const status = await service.getStatus('user-1', 'gmail');
  assert.equal(status.status, 'unconfigured');
  assert.equal(status.connected, false);
  const allowedKeys = ['provider', 'label', 'description', 'backend', 'iconUrl', 'status', 'connected', 'connectionId'];
  assert.deepEqual(Object.keys(status).sort(), [...allowedKeys].sort());
  const flat = JSON.stringify(status).toLowerCase();
  for (const banned of ['token', 'secret', 'apikey', 'api_key']) {
    assert.ok(!flat.includes(banned), `status leaked ${banned}`);
  }
});

test('listConnections covers every managed provider and degrades to error entries', async () => {
  const { gateway } = makeGateway();
  gateway.getToolkitConnection = async () => {
    throw new ManagedConnectionError(
      MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
      'down',
    );
  };
  const service = createConnectionService({
    gateway,
    stateStore: createMemoryConnectStateStore(),
    publicApiBase: API_BASE,
    logger: { log() {}, warn() {} },
  });
  const list = await service.listConnections('user-1');
  assert.equal(list.length, MANAGED_PROVIDERS.length);
  assert.equal(list[0].status, 'error');
  assert.equal(list[0].connected, false);
});

test('disconnect revokes at the provider, then deletes the connected account', async () => {
  const { service, calls } = makeService({
    state: { connected: true, status: 'connected', connectedAccountId: 'ca_del' },
  });
  const result = await service.disconnect('user-1', 'gmail');
  assert.equal(result.ok, true);
  assert.equal(result.providerRevoked, true);
  assert.equal(result.status.status, 'disconnected');
  assert.deepEqual(calls.revoked, ['ca_del']);
  assert.deepEqual(calls.deleted, ['ca_del']);
});

test('searchDirectory lists auth apps with icons, connected-first, filtered by query', async () => {
  const { service, calls } = makeService({
    connected: {
      slack: { connected: true, status: 'connected', connectedAccountId: 'ca_slk' },
    },
  });
  const all = await service.searchDirectory('user-1');
  assert.equal(all.unconfigured, false);
  // Auth-less toolkits never appear in the connections directory.
  assert.ok(!all.entries.some((e) => e.provider === 'hackernews'));
  // Connected apps sort first; icon URLs come from the catalog.
  assert.equal(all.entries[0].provider, 'slack');
  assert.equal(all.entries[0].connected, true);
  assert.equal(all.entries[0].connectionId, 'ca_slk');
  assert.equal(all.entries[0].iconUrl, 'https://logos.example/slack.svg');
  // Curated providers keep LYKN copy.
  const gmail = all.entries.find((e) => e.provider === 'gmail');
  assert.equal(gmail.label, managedProviderById('gmail').label);
  // The default view is the fast path: first page, full catalog untouched
  // but warming in the background for later searches.
  assert.equal(calls.firstPage.length, 1);
  assert.equal(calls.catalog.length, 0);
  assert.equal(calls.warmed.length, 1);
  assert.equal(all.hasMore, true);

  // A query takes the full-catalog path with an exact hasMore.
  const filtered = await service.searchDirectory('user-1', { query: 'noti' });
  assert.deepEqual(filtered.entries.map((e) => e.provider), ['notion']);
  assert.equal(filtered.hasMore, false);
  assert.equal(calls.catalog.length, 1);

  const limited = await service.searchDirectory('user-1', { limit: 1 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.hasMore, true);
});

test('searchDirectory fast path always includes connected apps outside the top page', async () => {
  const { service } = makeService({
    connected: {
      obscureapp: {
        connected: true,
        status: 'connected',
        connectedAccountId: 'ca_obs',
        name: 'Obscure App',
        logoUrl: 'https://logos.example/obscure.svg',
      },
    },
  });
  const all = await service.searchDirectory('user-1');
  assert.equal(all.entries[0].provider, 'obscureapp');
  assert.equal(all.entries[0].label, 'Obscure App');
  assert.equal(all.entries[0].iconUrl, 'https://logos.example/obscure.svg');
  assert.equal(all.entries[0].connected, true);
});

test('searchDirectory reports unconfigured without a backend', async () => {
  const { service, calls } = makeService({ configured: false });
  const result = await service.searchDirectory('user-1');
  assert.deepEqual(result, { unconfigured: true, entries: [], hasMore: false });
  assert.equal(calls.catalog.length, 0);
});

test('listPublicCatalog returns names and Composio logos without connection state', async () => {
  const catalog = [
    ...TEST_CATALOG,
    { slug: 'composio', name: 'Composio', logoUrl: 'https://logos.composio.dev/api/composio', isNoAuth: false },
    { slug: 'slackbot', name: 'Slackbot', logoUrl: 'https://evil.example/x.png', isNoAuth: false },
    { slug: 'linear', name: 'Linear', logoUrl: 'https://evil.example/x.png', isNoAuth: false },
  ];
  const { service, calls } = makeService({ catalog });
  const result = await service.listPublicCatalog();
  assert.equal(result.unconfigured, false);
  assert.deepEqual(calls.firstPage, [PUBLIC_CATALOG_USER_ID]);
  assert.equal(
    result.tools.some((t) => t.slug === 'composio' || t.slug === 'slackbot'),
    false,
  );
  assert.deepEqual(result.tools[0], {
    slug: 'gmail',
    name: 'Gmail',
    logoUrl: 'https://logos.composio.dev/api/gmail',
  });
  assert.equal(
    result.tools.find((t) => t.slug === 'linear')?.logoUrl,
    'https://logos.composio.dev/api/linear',
  );
  assert.equal(result.tools.every((t) => !('connected' in t)), true);
});

test('listPublicCatalog reports unconfigured without a backend', async () => {
  const { service, calls } = makeService({ configured: false });
  const result = await service.listPublicCatalog();
  assert.deepEqual(result, { unconfigured: true, tools: [] });
  assert.equal(calls.firstPage.length, 0);
});

test('listPublicCatalog degrades to empty when the catalog fetch fails', async () => {
  const { gateway, calls } = makeGateway();
  gateway.listToolkitFirstPage = async () => {
    calls.firstPage.push('threw');
    throw new ManagedConnectionError(
      MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
      'Could not load the connections directory.',
    );
  };
  const service = createConnectionService({
    gateway,
    stateStore: createMemoryConnectStateStore(),
    publicApiBase: API_BASE,
    logger: { log() {}, warn() {}, error() {} },
  });
  const result = await service.listPublicCatalog();
  assert.deepEqual(result, { unconfigured: true, tools: [] });
});

test('disconnect is a no-op when nothing is connected', async () => {
  const { service, calls } = makeService();
  const result = await service.disconnect('user-1', 'gmail');
  assert.equal(result.ok, true);
  assert.equal(result.alreadyDisconnected, true);
  assert.deepEqual(calls.revoked, []);
  assert.deepEqual(calls.deleted, []);
});
