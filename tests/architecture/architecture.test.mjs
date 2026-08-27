import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkArchitecture,
  DEFAULT_BUDGETS,
} from '../../scripts/architecture/check-architecture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const productionBudgets = JSON.parse(fs.readFileSync(DEFAULT_BUDGETS, 'utf8'));
const fixtureBudgets = {
  reviewThreshold: 1500,
  failThreshold: 2500,
  maxDirectServerRoutes: 4,
  importantFiles: {},
  exceptions: {},
  retiredFiles: [],
  forbiddenIdentifiers: productionBudgets.forbiddenIdentifiers,
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function makeTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lykn-arch-'));
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

test('canonical MCP runtime files exist on current main', () => {
  for (const rel of [
    'lib/mcp/mcpConnectionManager.js',
    'lib/mcp/mcpClientRuntime.js',
    'lib/mcp/externalToolResolver.js',
    'lib/mcp/chatTurn.js',
    'lib/mcp/mcpApprovalTokens.js',
    'lib/security/credentialStore.js',
    'electron/task-runtime/executors/mcpExecutor.cjs',
    'server/routes/mcp.routes.js',
    'src/components/connections/McpConnectionsPanel.jsx',
    'supabase-migrations/127_lykn_mcp_connections.sql',
    'supabase-migrations/128_lykn_mcp_auth_trust.sql',
    'supabase-migrations/129_lykn_generic_credentials.sql',
    'supabase-migrations/130_lykn_mcp_stdio_catalog.sql',
  ]) {
    assert.ok(exists(rel), `missing ${rel}`);
  }
});

test('package.json restores the proven MCP SDK and test:mcp', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['@modelcontextprotocol/sdk']);
  assert.match(pkg.scripts['test:mcp'], /tests\/mcp\/universalMcp\.test\.mjs/);
  assert.match(pkg.scripts['test:architecture'], /tests\/architecture\/architecture\.test\.mjs/);
  assert.match(pkg.scripts['test:teach'], /tests\/teach/);
});

test('Chat disclosure remains canonical and composeWithExternalTools is wired', () => {
  const server = read('server.js');
  assert.match(server, /resolveChatTurnDisclosure/);
  assert.match(server, /composeWithExternalTools/);
  assert.match(server, /resolveMcpToolsForTurn/);
  assert.match(server, /bindMcpChatHandlers/);
  assert.match(server, /registerMcpRoutes/);
  assert.match(server, /extraChatTools/);
  assert.doesNotMatch(server, /CHAT_TOOLS\.length\s*>\s*60/);
  assert.match(read('mcp-tools/firstPartyCapabilities.js'), /composeWithExternalTools/);
});

test('MCP routes live in the route module, not as a thousand-line server.js paste', () => {
  const routes = read('server/routes/mcp.routes.js');
  assert.match(routes, /export function registerMcpRoutes/);
  assert.match(routes, /export function getMcpManager/);
  assert.ok(routes.split('\n').length < 1500);
  const server = read('server.js');
  assert.doesNotMatch(server, /app\.(get|post|delete)\('\/api\/mcp\//);
});

test('Chat does not trust request connectionIds for MCP disclosure', () => {
  const chatTurn = read('lib/mcp/chatTurn.js');
  assert.match(chatTurn, /botConnectionIds/);
  assert.doesNotMatch(chatTurn, /association:\s*Array\.isArray\(connectionIds\)/);
  const server = read('server.js');
  assert.match(server, /botConnectionIds:\s*undefined/);
});

test('oversized synthetic file fails the generic threshold', () => {
  const root = makeTree();
  write(root, 'lib/newManager.ts', `${'export const x = 1;\n'.repeat(2601)}`);
  const result = checkArchitecture({ root, budgets: fixtureBudgets });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.kind === 'generic-size' && f.path === 'lib/newManager.ts'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('forbidden import fails without touching production files', () => {
  const root = makeTree();
  write(root, 'server.js', 'export const app = {};\n');
  write(root, 'server/memory/memoryChat.js', "import { app } from '../../server.js';\n");
  const result = checkArchitecture({ root, budgets: fixtureBudgets });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.kind === 'forbidden-import' && f.path === 'server/memory/memoryChat.js'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('forbidden legacy identifier fails without touching production files', () => {
  const root = makeTree();
  write(root, 'electron/host.cjs', 'const flag = "browser_legacy_fallback";\n');
  const result = checkArchitecture({ root, budgets: fixtureBudgets });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.kind === 'forbidden-identifier' && f.path === 'electron/host.cjs'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('checker module lives next to the budgets file', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(
    path.basename(path.resolve(here, '../../scripts/architecture/architecture-budgets.json')),
    'architecture-budgets.json',
  );
});
