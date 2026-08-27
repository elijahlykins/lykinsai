/**
 * Local stdio MCP fixture. Same tools as the HTTP fixture, stdio transport.
 * Spawned as: node lib/mcp/fixtures/stdioMcpServer.js
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

function createStdioFixtureMcp() {
  const mcp = new McpServer(
    { name: 'lykn-stdio-fixture', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  mcp.registerTool(
    'read_item',
    {
      title: 'Read item',
      description: 'Read a live item from the source system. Does not save into Vault.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ id }) => ({
      content: [{ type: 'text', text: JSON.stringify({ id, body: `item-body-${id}`, source: 'stdio-fixture' }) }],
    }),
  );
  mcp.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description: 'Search email-like messages in the source inbox.',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => ({
      content: [{ type: 'text', text: JSON.stringify({ query, hits: [{ from: 'John', subject: 'Hello' }] }) }],
    }),
  );
  return mcp;
}

export { createStdioFixtureMcp };

const isMain = process.argv[1] && process.argv[1].includes('stdioMcpServer');
if (isMain) {
  const mcp = createStdioFixtureMcp();
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
