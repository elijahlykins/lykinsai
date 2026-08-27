import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
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
