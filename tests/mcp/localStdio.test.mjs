import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseLocalCommand,
  assertLocalCommandSafe,
  createLocalMcpProcessManager,
  publicEnvCredentialRefs,
  createMemoryMcpStore,
  createMcpConnectionManager,
  createMcpClientRuntime,
  MCP_TRANSPORTS,
  MCP_TRUST_LEVELS,
  MCP_STATUSES,
} from '../../lib/mcp/index.js';
import { assertNoRawEnvSecrets } from '../../lib/mcp/stdio/envRefs.js';

const fixturePath = fileURLToPath(new URL('../../lib/mcp/fixtures/stdioMcpServer.js', import.meta.url));

test('local commands canonicalize to argv and reject shell invocation', () => {
  const parsed = parseLocalCommand('npx @some/mcp-server --flag');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.command, 'npx');
  assert.deepEqual(parsed.args, ['@some/mcp-server', '--flag']);
  const rejected = assertLocalCommandSafe({ command: 'bash', args: ['-c', 'rm -rf /'] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'forbidden_command');
  const inject = assertLocalCommandSafe({ command: 'node;rm', args: [] });
  assert.equal(inject.ok, false);
});

test('shell metacharacters stay inside args and are not a shell', () => {
  const safe = assertLocalCommandSafe({
    command: 'node',
    args: [fixturePath, 'foo; rm -rf /'],
    confirmInstall: true,
  });
  assert.equal(safe.ok, true);
  assert.equal(safe.args[1], 'foo; rm -rf /');
});

test('npx requires explicit install confirmation', () => {
  const blocked = assertLocalCommandSafe({ command: 'npx', args: ['@some/mcp-server'] });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'install_confirmation_required');
  const ok = assertLocalCommandSafe({
    command: 'npx',
    args: ['@some/mcp-server'],
    confirmInstall: true,
  });
  assert.equal(ok.ok, true);
  assert.ok(ok.args.includes('-y'));
});

test('raw environment secrets are rejected and refs stay public', () => {
  assert.equal(assertNoRawEnvSecrets({ GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }).ok, false);
  const refs = publicEnvCredentialRefs({ GITHUB_TOKEN: { type: 'lykn_credential', id: 'cred_1' } });
  assert.deepEqual(refs, { GITHUB_TOKEN: { type: 'lykn_credential', id: 'cred_1' } });
  const json = JSON.stringify(refs);
  assert.doesNotMatch(json, /ghp_/);
});

test('process manager kills on stop and bounds crash restarts', async () => {
  let created = 0;
  const transports = [];
  const manager = createLocalMcpProcessManager({
    maxRestarts: 2,
    backoffMs: [5, 5, 5],
    idleShutdownMs: 0,
    createTransport: async () => {
      created += 1;
      const listeners = {};
      const transport = {
        pid: 1000 + created,
        closed: false,
        on(ev, fn) {
          listeners[ev] = fn;
        },
        emit(ev) {
          listeners[ev]?.();
        },
        async close() {
          this.closed = true;
        },
      };
      transports.push(transport);
      return transport;
    },
  });
  await manager.start('conn_1', { command: 'node', args: [fixturePath], confirmInstall: true });
  assert.equal(manager.health('conn_1').live, true);
  transports[0].emit('close');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopped = await manager.stop('conn_1');
  assert.equal(stopped.stopped, true);
  assert.equal(transports.at(-1).closed, true);
  assert.ok(created <= 3);
});

test('stdio fixture initialize, read tool, disconnect kills the process', async () => {
  const store = createMemoryMcpStore();
  const mgr = createMcpConnectionManager({ store });
  const connected = await mgr.connect('user-1', {
    name: 'Local fixture',
    transport: MCP_TRANSPORTS.STDIO,
    command: process.execPath,
    args: [fixturePath],
    confirmInstall: true,
    trustLevel: MCP_TRUST_LEVELS.LOCAL_TRUSTED,
  });
  assert.equal(connected.ok, true, connected.message || connected.error);
  assert.equal(connected.connection.transport, MCP_TRANSPORTS.STDIO);
  assert.equal(connected.connection.status, MCP_STATUSES.CONNECTED);
  const publicJson = JSON.stringify(connected.connection);
  assert.doesNotMatch(publicJson, /CONNECTOR_TOKEN_KEY/);
  const observation = await mgr.callTool({
    userId: 'user-1',
    connectionId: connected.connection.id,
    toolName: 'read_item',
    args: { id: 'a1' },
  });
  assert.equal(observation.kind, 'external_untrusted_observation');
  const live = mgr.localProcesses.listLive();
  assert.ok(live.includes(connected.connection.id));
  await mgr.remove('user-1', connected.connection.id);
  assert.deepEqual(mgr.localProcesses.listLive(), []);
  assert.equal(await store.get('user-1', connected.connection.id), null);
});

test('cancelling a stdio tool call aborts', async () => {
  const runtime = await createMcpClientRuntime({
    transportKind: MCP_TRANSPORTS.STDIO,
    stdio: { command: process.execPath, args: [fixturePath] },
    trustLevel: MCP_TRUST_LEVELS.LOCAL_TRUSTED,
  });
  const controller = new AbortController();
  const pending = runtime.callTool({
    name: 'read_item',
    arguments: { id: 'slow' },
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, (err) => err.code === 'aborted' || /abort/i.test(String(err.message)));
  await runtime.close();
});

test('local MCP is lazy: manager construction does not spawn', () => {
  let created = 0;
  const processManager = createLocalMcpProcessManager({
    createTransport: async () => {
      created += 1;
      return { async close() {}, on() {} };
    },
  });
  createMcpConnectionManager({
    store: createMemoryMcpStore(),
    processManager,
  });
  assert.equal(created, 0);
  assert.deepEqual(processManager.listLive(), []);
});
