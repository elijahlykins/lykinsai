/**
 * Managed tool connections: Composio-backed apps flowing through the
 * Universal MCP stack.
 *
 * The connection manager must resolve the endpoint URL and auth headers
 * live (resolveManagedEndpoint) for rows marked providedThrough='composio',
 * never persisting either, and must recover from rotated sessions. The
 * bridge must keep managed rows aligned with the user's connected apps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startFixtureMcpServer } from '../../lib/mcp/fixtures/testMcpServer.js';
import { createMemoryMcpStore } from '../../lib/mcp/mcpStore.js';
import { createMcpConnectionManager } from '../../lib/mcp/mcpConnectionManager.js';
import { MCP_TRUST_LEVELS, MCP_STATUSES, MANAGED_TOOL_PROVIDER, isManagedToolConnection } from '../../lib/mcp/protocol.js';
import {
  createManagedToolBridge,
  managedToolCatalogId,
  managedToolServerUrl,
} from '../../lib/connections/managedToolBridge.js';
import { createConnectionService, createMemoryConnectStateStore } from '../../lib/connections/connectionService.js';
import { resolveMcpToolsForTurn, bindMcpChatHandlers } from '../../lib/mcp/chatTurn.js';

const PLACEHOLDER = managedToolServerUrl('gmail');

function managedInput(overrides = {}) {
  return {
    name: 'Gmail',
    serverUrl: PLACEHOLDER,
    // Fixture servers listen on localhost; production bridge rows use OFFICIAL.
    trustLevel: MCP_TRUST_LEVELS.LOCAL_TRUSTED,
    providedThrough: MANAGED_TOOL_PROVIDER,
    catalogId: managedToolCatalogId('gmail'),
    catalogSource: { kind: 'managed', toolkit: 'gmail' },
    ...overrides,
  };
}

test('managed connect dials the minted endpoint with minted headers, stores only the placeholder', async () => {
  const fixture = await startFixtureMcpServer({ requireAuth: true });
  const resolverCalls = [];
  try {
    const store = createMemoryMcpStore();
    const manager = createMcpConnectionManager({
      store,
      resolveManagedEndpoint: async (userId, row, { fresh } = {}) => {
        resolverCalls.push({ userId, catalogId: row.catalogId, fresh: Boolean(fresh) });
        return { url: fixture.url, headers: { Authorization: 'Bearer fixture-token' } };
      },
    });
    const result = await manager.connect('user-1', managedInput());
    assert.equal(result.ok, true);
    const row = await store.get('user-1', result.connection.id);
    assert.equal(isManagedToolConnection(row), true);
    // The live session URL must never land in the row.
    assert.equal(row.serverUrl, PLACEHOLDER);
    assert.equal(row.status, MCP_STATUSES.CONNECTED);
    assert.ok(row.classifiedTools.length > 0);
    assert.deepEqual(resolverCalls, [
      { userId: 'user-1', catalogId: 'composio:gmail', fresh: false },
    ]);
    // Tool calls run against the minted endpoint too.
    const read = await manager.callTool({
      userId: 'user-1',
      connectionId: row.id,
      toolName: 'read_item',
      args: { id: 'a1' },
    });
    assert.equal(read.kind, 'external_untrusted_observation');
  } finally {
    await fixture.close();
  }
});

test('a rotated managed session is retried once with a fresh endpoint', async () => {
  const fixture = await startFixtureMcpServer({ requireAuth: true });
  let mints = 0;
  try {
    const store = createMemoryMcpStore();
    const manager = createMcpConnectionManager({
      store,
      resolveManagedEndpoint: async (_userId, _row, { fresh } = {}) => {
        mints += 1;
        // First mint hands back a stale credential; the fresh retry works.
        const token = fresh ? 'fixture-token' : 'stale-token';
        return { url: fixture.url, headers: { Authorization: `Bearer ${token}` } };
      },
    });
    const result = await manager.connect('user-1', managedInput());
    assert.equal(result.ok, true);
    assert.equal(mints, 2);
  } finally {
    await fixture.close();
  }
});

test('a managed row never falls into MCP OAuth; persistent 401 asks for reconnect', async () => {
  const fixture = await startFixtureMcpServer({ requireAuth: true });
  try {
    const store = createMemoryMcpStore();
    const manager = createMcpConnectionManager({
      store,
      resolveManagedEndpoint: async () => ({
        url: fixture.url,
        headers: { Authorization: 'Bearer wrong-token' },
      }),
    });
    const result = await manager.connect('user-1', managedInput());
    assert.equal(result.ok, false);
    assert.equal(result.error, 'authentication_required');
    const row = await store.get('user-1', result.connection.id);
    assert.equal(row.status, MCP_STATUSES.AUTHENTICATION_REQUIRED);
    // Specifically not 'authorizing': no MCP OAuth flow was started.
    assert.equal(result.connection.status, MCP_STATUSES.AUTHENTICATION_REQUIRED);
  } finally {
    await fixture.close();
  }
});

function fakeManager(rows = []) {
  const calls = { connect: [], reconnect: [], remove: [] };
  return {
    calls,
    store: {
      async list() {
        return rows;
      },
    },
    async connect(userId, input) {
      calls.connect.push({ userId, input });
      return { ok: true, connection: { id: 'new-row' } };
    },
    async reconnect(userId, id) {
      calls.reconnect.push({ userId, id });
      return { ok: true };
    },
    async remove(userId, id) {
      calls.remove.push({ userId, id });
      return { ok: true };
    },
  };
}

test('bridge creates the managed row with placeholder URL and official trust', async () => {
  const manager = fakeManager([]);
  const bridge = createManagedToolBridge({ manager });
  const result = await bridge.ensureToolConnection('user-1', {
    id: 'gmail',
    label: 'Gmail',
    toolkit: 'gmail',
  });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  const input = manager.calls.connect[0].input;
  assert.equal(input.serverUrl, managedToolServerUrl('gmail'));
  assert.equal(input.trustLevel, MCP_TRUST_LEVELS.OFFICIAL);
  assert.equal(input.providedThrough, MANAGED_TOOL_PROVIDER);
  assert.equal(input.catalogId, 'composio:gmail');
});

test('bridge leaves a healthy row alone unless refresh is requested', async () => {
  const row = {
    id: 'row-1',
    providedThrough: MANAGED_TOOL_PROVIDER,
    catalogId: 'composio:gmail',
    status: MCP_STATUSES.CONNECTED,
  };
  const manager = fakeManager([row]);
  const bridge = createManagedToolBridge({ manager });
  const untouched = await bridge.ensureToolConnection('user-1', { toolkit: 'gmail', label: 'Gmail' });
  assert.equal(untouched.created, false);
  assert.equal(manager.calls.reconnect.length, 0);
  await bridge.ensureToolConnection('user-1', { toolkit: 'gmail', label: 'Gmail' }, { refresh: true });
  assert.deepEqual(manager.calls.reconnect, [{ userId: 'user-1', id: 'row-1' }]);
});

test('bridge reconcile creates missing rows and removes orphans, leaving user MCP rows alone', async () => {
  const rows = [
    { id: 'keep', providedThrough: MANAGED_TOOL_PROVIDER, catalogId: 'composio:gmail', status: MCP_STATUSES.CONNECTED },
    { id: 'orphan', providedThrough: MANAGED_TOOL_PROVIDER, catalogId: 'composio:notion', status: MCP_STATUSES.CONNECTED },
    { id: 'user-mcp', providedThrough: null, catalogId: null, status: MCP_STATUSES.CONNECTED },
  ];
  const manager = fakeManager(rows);
  const bridge = createManagedToolBridge({ manager });
  const result = await bridge.reconcileToolConnections('user-1', [
    { toolkit: 'gmail', label: 'Gmail' },
    { toolkit: 'slack', label: 'Slack' },
  ]);
  assert.equal(result.created, 1);
  assert.equal(result.removed, 1);
  assert.equal(manager.calls.connect[0].input.catalogId, 'composio:slack');
  assert.deepEqual(manager.calls.remove, [{ userId: 'user-1', id: 'orphan' }]);
});

test('concurrent ensures create exactly one managed row (connect-callback vs reconcile race)', async () => {
  // Regression: the connect callback and the Settings-page reconcile both
  // ensured rows fire-and-forget; both saw no existing row and both created
  // one, leaving duplicate Mailchimp rows that disclosed every tool twice.
  const rows = [];
  let connects = 0;
  const manager = {
    store: {
      async list() {
        return [...rows];
      },
    },
    async connect(userId, input) {
      connects += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const row = {
        id: `row-${connects}`,
        providedThrough: input.providedThrough,
        catalogId: input.catalogId,
        status: MCP_STATUSES.CONNECTED,
        updatedAt: new Date().toISOString(),
      };
      rows.push(row);
      return { ok: true, connection: row };
    },
    async reconnect() {
      return { ok: true };
    },
    async remove() {
      return { ok: true };
    },
  };
  const bridge = createManagedToolBridge({ manager });
  const [a, b] = await Promise.all([
    bridge.ensureToolConnection('user-1', { toolkit: 'mailchimp', label: 'Mailchimp' }),
    bridge.ensureToolConnection('user-1', { toolkit: 'mailchimp', label: 'Mailchimp' }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(connects, 1);
  assert.equal(rows.length, 1);
});

test('reconcile heals duplicate rows for the same app, keeping the healthiest', async () => {
  const rows = [
    { id: 'dupe-old', providedThrough: MANAGED_TOOL_PROVIDER, catalogId: 'composio:mailchimp', status: MCP_STATUSES.DISCONNECTED, updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'dupe-live', providedThrough: MANAGED_TOOL_PROVIDER, catalogId: 'composio:mailchimp', status: MCP_STATUSES.CONNECTED, updatedAt: '2026-02-01T00:00:00Z' },
  ];
  const manager = fakeManager(rows);
  const bridge = createManagedToolBridge({ manager });
  const result = await bridge.reconcileToolConnections('user-1', [
    { toolkit: 'mailchimp', label: 'Mailchimp' },
  ]);
  assert.equal(result.removed, 1);
  assert.equal(result.created, 0);
  assert.deepEqual(manager.calls.remove, [{ userId: 'user-1', id: 'dupe-old' }]);
});

test('connection service syncs tools after connect and removes them after disconnect', async () => {
  const bridgeCalls = { ensure: [], remove: [] };
  const toolBridge = {
    async ensureToolConnection(userId, provider, opts) {
      bridgeCalls.ensure.push({ userId, provider: provider.id, refresh: Boolean(opts?.refresh) });
      return { ok: true };
    },
    async removeToolConnection(userId, provider) {
      bridgeCalls.remove.push({ userId, provider: provider.id });
      return { ok: true };
    },
  };
  const gateway = {
    isConfigured: () => true,
    async getToolkitConnection() {
      return { connected: true, status: 'connected', connectedAccountId: 'acc_1' };
    },
    async createConnectLink() {
      return { redirectUrl: 'https://connect.example/link' };
    },
    async revokeAtProvider() {
      return { revoked: true };
    },
    async deleteConnectedAccount() {
      return { deleted: true };
    },
  };
  const stateStore = createMemoryConnectStateStore();
  const service = createConnectionService({
    gateway,
    stateStore,
    publicApiBase: 'https://api.test',
    toolBridge,
    logger: { log() {}, warn() {} },
  });
  const issued = await stateStore.issue({ userId: 'user-1', providerId: 'gmail' });
  const completed = await service.completeCallback({ state: issued });
  assert.equal(completed.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridgeCalls.ensure, [{ userId: 'user-1', provider: 'gmail', refresh: true }]);

  const disconnected = await service.disconnect('user-1', 'gmail');
  assert.equal(disconnected.ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(bridgeCalls.remove, [{ userId: 'user-1', provider: 'gmail' }]);
});

async function insertGmailRow(store) {
  return store.insert('user-1', {
    ...managedInput({ trustLevel: MCP_TRUST_LEVELS.OFFICIAL }),
    status: MCP_STATUSES.CONNECTED,
    classifiedTools: [
      {
        toolName: 'GMAIL_SEND_EMAIL',
        semanticCapabilities: ['communication.email.send'],
        consequenceHint: 'CONSEQUENTIAL',
        confidence: 0.78,
        description: 'Send an email via Gmail',
      },
      {
        toolName: 'GMAIL_FETCH_EMAILS',
        semanticCapabilities: ['communication.email.read'],
        consequenceHint: 'READ',
        confidence: 0.78,
        description: 'Fetch emails from Gmail',
      },
    ],
  });
}

test('follow-up turns disclose tools from conversation context', async () => {
  const store = createMemoryMcpStore();
  await insertGmailRow(store);
  const manager = { store };

  // The bare follow-up has no app tokens — on its own it discloses nothing.
  const bare = await resolveMcpToolsForTurn({ manager, userId: 'user-1', text: 'ok now send it' });
  assert.equal((bare.tools || []).length, 0);

  // With the recent conversation as context, the email need is inferred and
  // the send tool is disclosed for the follow-up turn.
  const withContext = await resolveMcpToolsForTurn({
    manager,
    userId: 'user-1',
    text: 'ok now send it',
    contextText:
      'user: can you send an email to elijah@lykn.io\nassistant: What should it say?\nuser: just make it funny',
  });
  assert.ok(
    (withContext.tools || []).some((tool) => tool.name.endsWith('GMAIL_SEND_EMAIL')),
    `expected send tool in ${JSON.stringify((withContext.tools || []).map((t) => t.name))}`,
  );
});

test('consequential chat tool pauses for approval, executes on approve, halts on decline', async () => {
  const store = createMemoryMcpStore();
  await insertGmailRow(store);
  const executedCalls = [];
  const manager = {
    store,
    callTool: async (opts) => {
      executedCalls.push(opts.toolName);
      return { ok: true, id: 'msg_1' };
    },
  };
  const turn = await resolveMcpToolsForTurn({
    manager,
    userId: 'user-1',
    text: 'send an email to sarah@example.com',
  });
  const bound = bindMcpChatHandlers(turn.tools, turn.bindings, {
    manager,
    userId: 'user-1',
    text: 'send an email to sarah@example.com',
  });
  const send = bound.find((tool) => tool.name.endsWith('GMAIL_SEND_EMAIL'));
  assert.ok(send, 'send tool must be disclosed for a send task');

  // Approved: one approval round trip, then exactly one execution.
  const approvals = [];
  const approvedResult = await send.handler(
    { to: 'sarah@example.com', subject: 'hi', body: 'hello' },
    {
      userId: 'user-1',
      requestMcpApproval: async (req) => {
        approvals.push(req);
        return true;
      },
    },
  );
  assert.equal(approvedResult.isError, false);
  assert.equal(approvals.length, 1);
  assert.match(String(approvals[0].request?.title || ''), /send an email/i);
  assert.deepEqual(executedCalls, ['GMAIL_SEND_EMAIL']);

  // Declined: no execution, and the model is told the user said no.
  const declinedResult = await send.handler(
    { to: 'sarah@example.com', subject: 'hi', body: 'hello' },
    { userId: 'user-1', requestMcpApproval: async () => false },
  );
  assert.equal(declinedResult.isError, true);
  assert.match(declinedResult.content[0].text, /user_declined/);
  assert.deepEqual(executedCalls, ['GMAIL_SEND_EMAIL']);

  // No approval channel (e.g. non-desktop surface): the tool reports the
  // approval requirement instead of executing.
  const noChannel = await send.handler(
    { to: 'sarah@example.com', subject: 'hi', body: 'hello' },
    { userId: 'user-1' },
  );
  assert.equal(noChannel.isError, true);
  assert.match(noChannel.content[0].text, /waiting_for_approval|approval_required/);
  assert.deepEqual(executedCalls, ['GMAIL_SEND_EMAIL']);
});
