import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveChatTurnDisclosure,
  composeWithExternalTools,
} from '../../mcp-tools/firstPartyCapabilities.js';
import { resolveMcpToolsForTurn } from '../../lib/mcp/chatTurn.js';
import { createMemoryMcpStore } from '../../lib/mcp/mcpStore.js';
import { createMcpConnectionManager } from '../../lib/mcp/mcpConnectionManager.js';
import { startFixtureMcpServer } from '../../lib/mcp/fixtures/testMcpServer.js';
import { MCP_TRUST_LEVELS } from '../../lib/mcp/protocol.js';
import { createParityWorld, emailParityTools } from './parityWorld.mjs';

test('hello discloses 0 first-party and 0 MCP tools', () => {
  const d = resolveChatTurnDisclosure({ message: 'hello' });
  assert.deepEqual(d.firstPartyToolNames, []);
  assert.deepEqual(d.externalTools, []);
  assert.equal(d.keepToolsOn, false);
});

test('search the web discloses first-party web tools and 0 MCP', () => {
  const d = resolveChatTurnDisclosure({ message: 'search the web for lykn' });
  assert.ok(d.firstPartyToolNames.includes('lykn_web_search'));
  assert.deepEqual(d.externalTools, []);
});

test('check Gmail with no connection returns missing_capability', async () => {
  const manager = createMcpConnectionManager({ store: createMemoryMcpStore() });
  const turn = await resolveMcpToolsForTurn({
    manager,
    userId: 'user-1',
    text: 'check Gmail',
  });
  assert.equal(turn.tools.length, 0);
  assert.equal(turn.resolution.reason, 'missing_capability');
  assert.ok(turn.suggestions.some((item) => /gmail/i.test(item.name)));
});

test('check Gmail with a live fixture attaches ≤10 MCP tools through composeWithExternalTools', async () => {
  const world = createParityWorld();
  const fixture = await startFixtureMcpServer({
    extraTools: emailParityTools(world),
    includeDefaults: false,
  });
  const manager = createMcpConnectionManager({ store: createMemoryMcpStore() });
  try {
    const connected = await manager.connect('user-1', {
      name: 'Work Gmail',
      serverUrl: fixture.url,
      trustLevel: MCP_TRUST_LEVELS.LOCAL_TRUSTED,
    });
    assert.equal(connected.ok, true, connected.message || connected.error);
    const turn = await resolveMcpToolsForTurn({
      manager,
      userId: 'user-1',
      text: 'check Gmail',
    });
    const firstParty = resolveChatTurnDisclosure({ message: 'check Gmail' });
    const composed = composeWithExternalTools(firstParty.firstPartyToolNames, turn.tools);
    assert.ok(turn.tools.length > 0, JSON.stringify(turn.resolution));
    assert.ok(composed.externalTools.length <= 10);
    assert.ok(composed.toolNames.some((name) => name.startsWith('mcp_')));
    assert.ok(firstParty.firstPartyToolNames.length < 8);
  } finally {
    await fixture.close();
  }
});
