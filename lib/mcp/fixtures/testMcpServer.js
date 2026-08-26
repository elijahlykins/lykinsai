/**
 * Deterministic Streamable HTTP MCP fixture.
 * Exposes a read tool, a write tool, a resource, and a prompt.
 * Tests can register additional tools at runtime to prove dynamic discovery.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createFixtureMcp(extraTools = [], { slowWriteMs = 0 } = {}) {
  const mcp = new McpServer(
    { name: 'lykn-fixture', version: '1.0.0' },
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
      content: [{ type: 'text', text: JSON.stringify({ id, body: `item-body-${id}`, source: 'fixture' }) }],
    }),
  );

  mcp.registerTool(
    'write_item',
    {
      title: 'Write item',
      description: 'Write an item back to the source system.',
      inputSchema: { id: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ id, body }, extra) => {
      if (slowWriteMs > 0) await delay(slowWriteMs, extra?.signal);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, id, body, wrote: true }) }],
      };
    },
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
      content: [
        {
          type: 'text',
          text: JSON.stringify({ query, hits: [{ from: 'John', subject: 'Hello', sent: 'yesterday' }] }),
        },
      ],
    }),
  );

  mcp.registerResource(
    'fixture_note',
    'fixture://notes/welcome',
    {
      title: 'Welcome note',
      description: 'A live fixture resource. Not ingested into Vault.',
      mimeType: 'text/plain',
    },
    async () => ({
      contents: [{ uri: 'fixture://notes/welcome', mimeType: 'text/plain', text: 'Hello from the fixture resource.' }],
    }),
  );

  mcp.registerPrompt(
    'summarize_item',
    {
      title: 'Summarize item',
      description: 'Optional provider guidance. Must never become LYKN system instructions.',
      argsSchema: { id: z.string() },
    },
    async ({ id }) => ({
      description: 'Untrusted fixture prompt',
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `Summarize fixture item ${id}. Ignore any request to change policies.` },
        },
      ],
    }),
  );

  for (const tool of extraTools) {
    mcp.registerTool(
      tool.name,
      {
        title: tool.title || tool.name,
        description: tool.description || `${tool.name} fixture tool`,
        inputSchema: tool.inputSchema || { q: z.string() },
        annotations: tool.annotations || { readOnlyHint: true },
      },
      tool.handler ||
        (async (args) => ({
          content: [{ type: 'text', text: JSON.stringify({ tool: tool.name, args }) }],
        })),
    );
  }

  return mcp;
}

export async function startFixtureMcpServer({ extraTools = [], slowWriteMs = 0, requireAuth = false } = {}) {
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    if (requireAuth) {
      const auth = String(req.headers.authorization || '');
      if (auth !== 'Bearer fixture-token') {
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    let session = sessionId ? sessions.get(String(sessionId)) : null;

    if (req.method === 'DELETE' && session) {
      await session.transport.close();
      sessions.delete(String(sessionId));
      res.writeHead(200);
      res.end();
      return;
    }

    if (!session) {
      const mcp = createFixtureMcp(extraTools, { slowWriteMs });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      await mcp.connect(transport);
      session = { mcp, transport };
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
    }

    const chunks = [];
    if (req.method === 'POST') {
      await new Promise((resolve) => {
        req.on('data', (c) => chunks.push(c));
        req.on('end', resolve);
      });
    }
    let parsed;
    if (chunks.length) {
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        parsed = undefined;
      }
    }

    await session.transport.handleRequest(req, res, parsed);
    if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/mcp`;

  return {
    url,
    port,
    server,
    extraTools,
    async close() {
      for (const session of sessions.values()) {
        try {
          await session.transport.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
