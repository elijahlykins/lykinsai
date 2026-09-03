import test from 'node:test';
import assert from 'node:assert/strict';

import { selectToolsForCache, toolCachePriority } from '../../lib/mcp/toolCacheSelect.js';

function tool(name, required = []) {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', required, properties: Object.fromEntries(required.map((key) => [key, { type: 'string' }])) },
  };
}

test('a 600-tool alpha catalog keeps the late authenticated list enumerator', () => {
  const tools = [];
  for (let i = 0; i < 580; i += 1) {
    tools.push(tool(`GITHUB_GET_A_THING_${String(i).padStart(4, '0')}`, ['owner', 'repo', 'id']));
  }
  tools.push(tool('GITHUB_LIST_ACCESSIBLE_REPOSITORIES', ['installation_id']));
  tools.push(tool('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', []));
  tools.push(tool('GITHUB_GET_REPOSITORY_CONTENT', ['path', 'repo', 'owner']));
  tools.push(tool('GITHUB_GET_THE_AUTHENTICATED_USER', []));

  const kept = selectToolsForCache(tools, 500);
  const names = kept.map((t) => t.name);
  assert.equal(kept.length, 500);
  assert.ok(names.includes('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER'));
  assert.ok(names.includes('GITHUB_GET_THE_AUTHENTICATED_USER'));
  assert.ok(names.includes('GITHUB_GET_REPOSITORY_CONTENT'));
  assert.ok(
    toolCachePriority(tool('GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', []))
      > toolCachePriority(tool('GITHUB_LIST_ACCESSIBLE_REPOSITORIES', ['installation_id'])),
  );
});

test('Slack and Notion enumerators beat id-gated getters under the same cap', () => {
  const tools = [
    ...Array.from({ length: 200 }, (_, i) => tool(`SLACK_GET_MESSAGE_${i}`, ['channel_id', 'ts'])),
    tool('SLACK_LIST_CONVERSATIONS', []),
    tool('NOTION_GET_PAGE', ['page_id']),
    tool('NOTION_SEARCH', []),
  ];
  const kept = selectToolsForCache(tools, 50);
  const names = kept.map((t) => t.name);
  assert.ok(names.includes('SLACK_LIST_CONVERSATIONS'));
  assert.ok(names.includes('NOTION_SEARCH'));
});
