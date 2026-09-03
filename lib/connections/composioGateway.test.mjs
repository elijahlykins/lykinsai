import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createComposioGateway,
  ManagedConnectionError,
  MANAGED_CONNECTION_ERROR_CODES,
  normalizeAccountStatus,
} from './composioGateway.js';

const API_KEY = 'ck_test_composio_key_1234567890';

function makeFakes({
  toolkitsResult,
  authorizeResult,
  authorizeError,
  createError,
  mcpConfig,
} = {}) {
  const calls = {
    constructorOpts: null,
    create: [],
    authorize: [],
    toolkits: [],
    deleted: [],
    fetches: [],
  };
  const session = {
    async toolkits(opts) {
      calls.toolkits.push(opts);
      if (typeof toolkitsResult === 'function') return toolkitsResult(opts);
      return toolkitsResult ?? { items: [] };
    },
    async authorize(toolkit, opts) {
      calls.authorize.push({ toolkit, opts });
      if (authorizeError) throw authorizeError;
      return authorizeResult ?? { redirectUrl: 'https://connect.composio.dev/link/ln_abc' };
    },
  };
  class FakeComposio {
    constructor(opts) {
      calls.constructorOpts = opts;
      this.connectedAccounts = {
        delete: async (id) => {
          calls.deleted.push(id);
          return { deleted: true };
        },
      };
    }

    async create(userId, opts) {
      calls.create.push({ userId, opts });
      if (createError) throw createError;
      if (opts?.mcp) {
        return {
          ...session,
          mcp:
            mcpConfig === null
              ? undefined
              : mcpConfig ?? {
                  type: 'http',
                  url: 'https://apollo.composio.dev/v3/mcp/sess_123/mcp',
                  headers: { 'x-api-key': 'ephemeral-session-key' },
                },
        };
      }
      return session;
    }
  }
  const fetchResponses = [];
  const fetchImpl = async (url, init) => {
    calls.fetches.push({ url, init });
    const next = fetchResponses.shift() || { status: 200, data: {} };
    return {
      status: next.status,
      async json() {
        return next.data;
      },
    };
  };
  return { calls, fetchImpl, fetchResponses, loadComposio: async () => FakeComposio };
}

test('normalizeAccountStatus maps Composio statuses to LYKN statuses', () => {
  assert.equal(normalizeAccountStatus('ACTIVE'), 'connected');
  assert.equal(normalizeAccountStatus('INITIATED'), 'pending');
  assert.equal(normalizeAccountStatus('INITIALIZING'), 'pending');
  assert.equal(normalizeAccountStatus('FAILED'), 'broken');
  assert.equal(normalizeAccountStatus('EXPIRED'), 'broken');
  assert.equal(normalizeAccountStatus('REVOKED'), 'broken');
  assert.equal(normalizeAccountStatus(undefined), 'disconnected');
});

test('unconfigured gateway refuses operations with not_configured', async () => {
  const gateway = createComposioGateway({ apiKey: '', loadComposio: async () => null });
  assert.equal(gateway.isConfigured(), false);
  await assert.rejects(
    gateway.getToolkitConnection('user-1', 'gmail'),
    (e) =>
      e instanceof ManagedConnectionError &&
      e.code === MANAGED_CONNECTION_ERROR_CODES.NOT_CONFIGURED,
  );
});

test('toolkits without an auth config surface provider_requires_setup, not an outage', async () => {
  // Regression: connecting Twitter/X (no Composio-managed OAuth app; one
  // cannot be auto-created) showed "Could not reach the managed connection
  // provider" — an outage message for what is a setup gap on our side.
  const fakes = makeFakes({
    createError: new Error(
      '400 {"error":{"message":"The following toolkits require auth configs but none exist and cannot be auto-created: twitter. Please specify them in auth_configs.","code":4300}}',
    ),
  });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await assert.rejects(
    gateway.getToolkitConnection('user-1', 'twitter'),
    (e) =>
      e instanceof ManagedConnectionError &&
      e.code === MANAGED_CONNECTION_ERROR_CODES.REQUIRES_SETUP &&
      /not set up yet/i.test(e.message),
  );
});

test('the authorize-time phrasing of the missing-auth-config error also maps to requires_setup', async () => {
  // Composio words the same condition differently at authorize() time:
  // "Composio does not manage auth for toolkit X and no auth config without
  // required fields is available. Please create an auth config..."
  const fakes = makeFakes({
    authorizeError: new Error(
      '400 {"error":{"message":"Composio does not manage auth for toolkit bitwarden and no auth config without required fields is available. Please create an auth config.","code":4300}}',
    ),
  });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await assert.rejects(
    gateway.createConnectLink('user-1', 'bitwarden'),
    (e) =>
      e instanceof ManagedConnectionError &&
      e.code === MANAGED_CONNECTION_ERROR_CODES.REQUIRES_SETUP,
  );
});

test('sessions are created with the stable LYKN user id, no in-chat auth, no sandbox', async () => {
  const fakes = makeFakes();
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await gateway.getToolkitConnection('lykn-user-uuid-1', 'gmail');
  assert.equal(fakes.calls.constructorOpts.apiKey, API_KEY);
  assert.equal(fakes.calls.create.length, 1);
  assert.equal(fakes.calls.create[0].userId, 'lykn-user-uuid-1');
  assert.deepEqual(fakes.calls.create[0].opts.toolkits, ['gmail']);
  assert.equal(fakes.calls.create[0].opts.manageConnections, false);
  assert.deepEqual(fakes.calls.create[0].opts.sandbox, { enable: false });
});

test('per-user sessions are cached within the TTL', async () => {
  const fakes = makeFakes();
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await gateway.getToolkitConnection('user-1', 'gmail');
  await gateway.getToolkitConnection('user-1', 'gmail');
  await gateway.getToolkitConnection('user-2', 'gmail');
  assert.equal(fakes.calls.create.length, 2);
});

test('getMcpEndpoint mints a direct-tools session with mcp enabled', async () => {
  const fakes = makeFakes();
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  const endpoint = await gateway.getMcpEndpoint('user-1', 'gmail');
  assert.equal(endpoint.url, 'https://apollo.composio.dev/v3/mcp/sess_123/mcp');
  assert.deepEqual(endpoint.headers, { 'x-api-key': 'ephemeral-session-key' });
  assert.equal(endpoint.type, 'http');
  const opts = fakes.calls.create[0].opts;
  assert.deepEqual(opts.toolkits, ['gmail']);
  assert.equal(opts.sessionPreset, 'direct_tools');
  assert.equal(opts.mcp, true);
  assert.equal(opts.manageConnections, false);
  assert.deepEqual(opts.sandbox, { enable: false });
});

test('getMcpEndpoint caches per user+toolkit and fresh bypasses the cache', async () => {
  const fakes = makeFakes();
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await gateway.getMcpEndpoint('user-1', 'gmail');
  await gateway.getMcpEndpoint('user-1', 'gmail');
  assert.equal(fakes.calls.create.length, 1);
  await gateway.getMcpEndpoint('user-1', 'slack');
  assert.equal(fakes.calls.create.length, 2);
  await gateway.getMcpEndpoint('user-1', 'gmail', { fresh: true });
  assert.equal(fakes.calls.create.length, 3);
});

test('getMcpEndpoint fails as provider_unavailable when the session has no mcp url', async () => {
  const fakes = makeFakes({ mcpConfig: null });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await assert.rejects(
    gateway.getMcpEndpoint('user-1', 'gmail'),
    (e) =>
      e instanceof ManagedConnectionError &&
      e.code === MANAGED_CONNECTION_ERROR_CODES.UNAVAILABLE,
  );
});

test('an empty user id is rejected before reaching Composio', async () => {
  const fakes = makeFakes();
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await assert.rejects(gateway.getToolkitConnection('', 'gmail'), (e) =>
    /user id/i.test(e.message),
  );
  assert.equal(fakes.calls.create.length, 0);
});

test('toolkit connection state normalizes active, pending, and missing connections', async () => {
  const cases = [
    {
      items: [
        {
          slug: 'gmail',
          connection: { isActive: true, connectedAccount: { id: 'ca_1', status: 'ACTIVE' } },
        },
      ],
      expected: { connected: true, status: 'connected', connectedAccountId: 'ca_1' },
    },
    {
      items: [
        {
          slug: 'gmail',
          connection: { isActive: false, connectedAccount: { id: 'ca_2', status: 'INITIATED' } },
        },
      ],
      expected: { connected: false, status: 'pending', connectedAccountId: 'ca_2' },
    },
    {
      items: [
        {
          slug: 'gmail',
          connection: { isActive: false, connectedAccount: { id: 'ca_3', status: 'REVOKED' } },
        },
      ],
      expected: { connected: false, status: 'broken', connectedAccountId: 'ca_3' },
    },
    {
      items: [{ slug: 'gmail', connection: undefined }],
      expected: { connected: false, status: 'disconnected', connectedAccountId: null },
    },
    {
      items: [],
      expected: { connected: false, status: 'disconnected', connectedAccountId: null },
    },
  ];
  for (const { items, expected } of cases) {
    const fakes = makeFakes({ toolkitsResult: { items } });
    const gateway = createComposioGateway({
      apiKey: API_KEY,
      loadComposio: fakes.loadComposio,
      fetchImpl: fakes.fetchImpl,
    });
    const result = await gateway.getToolkitConnection('user-1', 'gmail');
    assert.deepEqual(result, expected);
  }
});

test('createConnectLink returns only a redirect URL and forwards the callback', async () => {
  const fakes = makeFakes({
    authorizeResult: { redirectUrl: 'https://connect.composio.dev/link/ln_xyz', extra: 'x' },
  });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  const result = await gateway.createConnectLink('user-1', 'gmail', {
    callbackUrl: 'https://api.lykn.io/oauth/connections/callback?state=abc',
  });
  assert.deepEqual(result, { redirectUrl: 'https://connect.composio.dev/link/ln_xyz' });
  assert.equal(fakes.calls.authorize[0].toolkit, 'gmail');
  assert.equal(
    fakes.calls.authorize[0].opts.callbackUrl,
    'https://api.lykn.io/oauth/connections/callback?state=abc',
  );
});

test('createConnectLink failure is normalized and does not leak the API key', async () => {
  const fakes = makeFakes({
    authorizeError: new Error(`composio rejected key ${API_KEY} for auth config`),
  });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await assert.rejects(gateway.createConnectLink('user-1', 'gmail'), (e) => {
    assert.equal(e.code, MANAGED_CONNECTION_ERROR_CODES.LINK_FAILED);
    assert.ok(!e.message.includes(API_KEY), 'message must not contain the API key');
    assert.ok(!String(e.detail).includes(API_KEY), 'detail must not contain the API key');
    return true;
  });
});

test('completeAuth posts the session_uri with the server-derived user id', async () => {
  const fakes = makeFakes();
  fakes.fetchResponses.push({
    status: 200,
    data: { connected_account_id: 'ca_new', toolkit_slug: 'GMAIL' },
  });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  const result = await gateway.completeAuth('user-1', 'https://backend.composio.dev/s/one-shot');
  assert.deepEqual(result, { connectedAccountId: 'ca_new', toolkitSlug: 'gmail' });
  const call = fakes.calls.fetches[0];
  assert.ok(call.url.endsWith('/connected_accounts/complete_auth'));
  assert.equal(call.init.headers['x-api-key'], API_KEY);
  assert.deepEqual(JSON.parse(call.init.body), {
    session_uri: 'https://backend.composio.dev/s/one-shot',
    user_id: 'user-1',
  });
});

test('completeAuth maps identity mismatch and expired sessions to typed errors', async () => {
  for (const [status, code] of [
    [400, MANAGED_CONNECTION_ERROR_CODES.VERIFICATION_FAILED],
    [404, MANAGED_CONNECTION_ERROR_CODES.VERIFICATION_EXPIRED],
  ]) {
    const fakes = makeFakes();
    fakes.fetchResponses.push({ status, data: { error: 'nope' } });
    const gateway = createComposioGateway({
      apiKey: API_KEY,
      loadComposio: fakes.loadComposio,
      fetchImpl: fakes.fetchImpl,
    });
    await assert.rejects(gateway.completeAuth('user-1', 'uri'), (e) => e.code === code);
  }
});

test('revokeAtProvider normalizes success, unsupported, and conflict', async () => {
  const table = [
    [200, { revoked: true }],
    [400, { revoked: false, reason: 'unsupported' }],
    [409, { revoked: false, reason: 'not_revokable' }],
    [404, { revoked: false, reason: 'not_found' }],
  ];
  for (const [status, expected] of table) {
    const fakes = makeFakes();
    fakes.fetchResponses.push({ status, data: {} });
    const gateway = createComposioGateway({
      apiKey: API_KEY,
      loadComposio: fakes.loadComposio,
      fetchImpl: fakes.fetchImpl,
      logger: { warn() {} },
    });
    assert.deepEqual(await gateway.revokeAtProvider('ca_1'), expected);
  }
});

test('deleteConnectedAccount deletes through the SDK and requires an id', async () => {
  const fakes = makeFakes();
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  assert.deepEqual(await gateway.deleteConnectedAccount('ca_1'), { deleted: true });
  assert.deepEqual(fakes.calls.deleted, ['ca_1']);
  await assert.rejects(
    gateway.deleteConnectedAccount(''),
    (e) => e.code === MANAGED_CONNECTION_ERROR_CODES.NOT_CONNECTED,
  );
});

test('a 429 from Composio is surfaced as rate_limited', async () => {
  const err = new Error('too many requests');
  err.status = 429;
  const fakes = makeFakes({ createError: err });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  await assert.rejects(
    gateway.getToolkitConnection('user-1', 'gmail'),
    (e) => e.code === MANAGED_CONNECTION_ERROR_CODES.RATE_LIMITED,
  );
});

/**
 * Fetch fake for the REST catalog endpoints, routing by URL so the
 * auth_configs and toolkits requests can interleave in any order.
 */
function makeCatalogFetch({ authConfigItems = [], toolkitPages = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    let data;
    if (url.includes('/auth_configs')) {
      data = { items: authConfigItems, next_cursor: null };
    } else if (url.includes('/toolkits')) {
      const cursor = new URL(url).searchParams.get('cursor') || 'first';
      data = toolkitPages[cursor] || { items: [], next_cursor: null };
    } else {
      throw new Error(`unexpected fetch ${url}`);
    }
    return { status: 200, async json() { return data; } };
  };
  return { calls, fetchImpl };
}

test('listToolkitCatalog pages the REST catalog and hides setup-required apps', async () => {
  // Regression: Twitter/X (unmanaged OAuth, no LYKN developer app) appeared
  // in the directory but every connect attempt could only ever end in the
  // "developer credentials not set up" error. Setup-required means ALL auth
  // schemes need a pre-registered app (OAuth/S2S/SAML without managed auth
  // or a project auth config). Self-service schemes like API_KEY stay
  // listed: the user supplies their own key in the Connect Link form.
  const catalogFetch = makeCatalogFetch({
    authConfigItems: [{ toolkit: { slug: 'xcustom' }, status: 'ENABLED' }],
    toolkitPages: {
      first: {
        items: [
          {
            slug: 'GMAIL',
            name: 'Gmail',
            auth_schemes: ['OAUTH2'],
            composio_managed_auth_schemes: ['OAUTH2'],
            meta: { logo: 'https://logos.example/gmail.svg' },
          },
          { slug: 'hackernews', name: 'Hacker News', no_auth: true },
          {
            slug: 'twitter',
            name: 'Twitter',
            auth_schemes: ['OAUTH2'],
            composio_managed_auth_schemes: [],
          },
          {
            slug: 'bitwarden',
            name: 'Bitwarden',
            auth_schemes: ['S2S_OAUTH2'],
            composio_managed_auth_schemes: [],
          },
        ],
        next_cursor: 'page2',
      },
      page2: {
        items: [
          {
            slug: 'perplexityai',
            name: 'Perplexity',
            auth_schemes: ['API_KEY'],
            composio_managed_auth_schemes: [],
          },
          {
            slug: 'xcustom',
            name: 'X Custom',
            auth_schemes: ['OAUTH2'],
            composio_managed_auth_schemes: [],
          },
        ],
        next_cursor: null,
      },
    },
  });
  const fakes = makeFakes();
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: catalogFetch.fetchImpl,
  });
  const catalog = await gateway.listToolkitCatalog();
  assert.deepEqual(catalog, [
    { slug: 'gmail', name: 'Gmail', logoUrl: 'https://logos.example/gmail.svg', isNoAuth: false },
    { slug: 'hackernews', name: 'Hacker News', logoUrl: null, isNoAuth: true },
    { slug: 'perplexityai', name: 'Perplexity', logoUrl: null, isNoAuth: false },
    { slug: 'xcustom', name: 'X Custom', logoUrl: null, isNoAuth: false },
  ]);
  // The catalog never creates a Composio session.
  assert.equal(fakes.calls.create.length, 0);
  const fetched = catalogFetch.calls.length;
  await gateway.listToolkitCatalog();
  assert.equal(catalogFetch.calls.length, fetched, 'second call served from cache');
});

test('listToolkitFirstPage is one toolkits round-trip and serves repeats from cache', async () => {
  const catalogFetch = makeCatalogFetch({
    toolkitPages: {
      first: {
        items: [
          {
            slug: 'gmail',
            name: 'Gmail',
            auth_schemes: ['OAUTH2'],
            composio_managed_auth_schemes: ['OAUTH2'],
            meta: { logo: 'https://logos.example/gmail.svg' },
          },
          {
            slug: 'twitter',
            name: 'Twitter',
            auth_schemes: ['OAUTH2'],
            composio_managed_auth_schemes: [],
          },
          {
            slug: 'slack',
            name: 'Slack',
            auth_schemes: ['OAUTH2'],
            composio_managed_auth_schemes: ['OAUTH2'],
          },
        ],
        next_cursor: 'more',
      },
    },
  });
  const fakes = makeFakes();
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: catalogFetch.fetchImpl,
  });
  const page = await gateway.listToolkitFirstPage('user-1', { limit: 2 });
  // Setup-required Twitter is filtered out; the next connectable app fills in.
  assert.deepEqual(page.map((t) => t.slug), ['gmail', 'slack']);
  const toolkitCalls = catalogFetch.calls.filter((u) => u.includes('/toolkits'));
  assert.equal(toolkitCalls.length, 1, 'no cursor paging on the fast path');
  // The short-lived first-page cache absorbs repeat paints.
  await gateway.listToolkitFirstPage('user-1');
  assert.equal(catalogFetch.calls.filter((u) => u.includes('/toolkits')).length, 1);
});

test('listConnectedToolkits maps per-user connection state and stays fresh', async () => {
  const fakes = makeFakes({
    toolkitsResult: {
      items: [
        {
          slug: 'GMAIL',
          connection: { isActive: true, connectedAccount: { id: 'ca_1', status: 'ACTIVE' } },
        },
        {
          slug: 'slack',
          connection: { isActive: false, connectedAccount: { id: 'ca_2', status: 'EXPIRED' } },
        },
        { slug: 'notion', connection: undefined },
      ],
    },
  });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  const connected = await gateway.listConnectedToolkits('user-1');
  assert.deepEqual(connected, {
    gmail: {
      connected: true,
      status: 'connected',
      connectedAccountId: 'ca_1',
      name: 'GMAIL',
      logoUrl: null,
    },
    slack: {
      connected: false,
      status: 'broken',
      connectedAccountId: 'ca_2',
      name: 'slack',
      logoUrl: null,
    },
  });
  assert.equal(fakes.calls.toolkits.at(-1).isConnected, true);
  await gateway.listConnectedToolkits('user-1');
  assert.equal(fakes.calls.toolkits.length, 2, 'connection state is never cached');
});

test('no product-facing object carries token-shaped fields', async () => {
  const fakes = makeFakes({
    toolkitsResult: {
      items: [
        {
          slug: 'gmail',
          connection: {
            isActive: true,
            connectedAccount: {
              id: 'ca_1',
              status: 'ACTIVE',
              access_token: 'ya29.secret',
              refresh_token: '1//refresh',
            },
          },
        },
      ],
    },
  });
  const gateway = createComposioGateway({
    apiKey: API_KEY,
    loadComposio: fakes.loadComposio,
    fetchImpl: fakes.fetchImpl,
  });
  const result = await gateway.getToolkitConnection('user-1', 'gmail');
  const flat = JSON.stringify(result);
  assert.ok(!flat.includes('ya29'), 'access token leaked');
  assert.ok(!flat.includes('refresh'), 'refresh token leaked');
  assert.deepEqual(Object.keys(result).sort(), ['connected', 'connectedAccountId', 'status']);
});
