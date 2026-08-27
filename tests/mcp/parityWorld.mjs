/**
 * Representative in-memory MCP tool families for Phase 3 parity proofs.
 * Test configuration only. Not a LYKN provider adapter. The universal
 * MCP runtime is the only execution mechanism.
 */
import { z } from 'zod';

export const SAFE_SEND_TO = 'sarah.fixture@lykn.test';

export function createParityWorld() {
  return {
    vaultWrites: [],
    connectorSyncCalls: [],
    email: [
      {
        id: 'em-1',
        from: 'Sarah Chen',
        to: 'work@lykn.test',
        subject: 'Q2 check-in',
        body: 'Catching up next week.',
        sentAt: '2026-08-01T09:00:00.000Z',
      },
    ],
    files: [
      {
        id: 'file-1',
        name: 'Q2 notes',
        body: 'Old notes',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
    ],
    pages: [
      {
        id: 'page-1',
        title: 'Team handbook',
        body: 'How we work',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
    issues: [
      {
        id: '183',
        title: 'Fix overlay crash',
        assignee: 'me',
        state: 'open',
        pr: null,
      },
    ],
  };
}

function jsonResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function emailParityTools(world) {
  return [
    {
      name: 'search_messages',
      description: 'Search gmail inbox email messages by sender, subject, or query',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ query }) => {
        const q = String(query || '').toLowerCase();
        const hits = world.email.filter((item) =>
          `${item.from} ${item.subject} ${item.body}`.toLowerCase().includes(q),
        );
        return jsonResult({ source: 'live_mcp', hits });
      },
    },
    {
      name: 'read_email',
      description: 'Read a live email message from the gmail inbox',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ id }) => {
        const item = world.email.find((row) => row.id === id);
        return jsonResult({ source: 'live_mcp', email: item || null });
      },
    },
    {
      name: 'create_draft',
      description: 'Create an email draft in gmail. Leaves the message unsent.',
      inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async ({ to, subject, body }) => {
        const draft = {
          id: `draft-${world.email.length + 1}`,
          from: 'me',
          to,
          subject,
          body,
          sentAt: null,
          draft: true,
        };
        world.email.push(draft);
        return jsonResult({ source: 'live_mcp', wrote: true, draft });
      },
    },
    {
      name: 'send_email',
      description: 'Send an email message from gmail',
      inputSchema: { to: z.string(), subject: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async ({ to, subject, body }) => {
        if (String(to) !== SAFE_SEND_TO) {
          return jsonResult({ error: 'unsafe_recipient_blocked', allowed: SAFE_SEND_TO });
        }
        const sent = {
          id: `sent-${world.email.length + 1}`,
          from: 'me',
          to,
          subject,
          body,
          sentAt: new Date().toISOString(),
          draft: false,
        };
        world.email.push(sent);
        return jsonResult({ source: 'live_mcp', sent: true, email: sent });
      },
    },
  ];
}

export function driveParityTools(world) {
  return [
    {
      name: 'search_files',
      description: 'Search google drive documents and files by name',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ query }) => {
        const q = String(query || '').toLowerCase();
        const hits = world.files.filter((item) => item.name.toLowerCase().includes(q));
        return jsonResult({ source: 'live_mcp', hits });
      },
    },
    {
      name: 'read_file',
      description: 'Read a live google drive document',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ id }) => {
        const item = world.files.find((row) => row.id === id);
        return jsonResult({ source: 'live_mcp', file: item || null });
      },
    },
    {
      name: 'create_file',
      description: 'Create a test document in google drive',
      inputSchema: { name: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async ({ name, body }) => {
        const file = {
          id: `file-${world.files.length + 1}`,
          name,
          body,
          updatedAt: new Date().toISOString(),
        };
        world.files.push(file);
        return jsonResult({ source: 'live_mcp', wrote: true, file });
      },
    },
  ];
}

export function notionParityTools(world) {
  return [
    {
      name: 'search_pages',
      description: 'Search Notion document pages by title',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ query }) => {
        const q = String(query || '').toLowerCase();
        const hits = world.pages.filter((item) => item.title.toLowerCase().includes(q));
        return jsonResult({ source: 'live_mcp', hits });
      },
    },
    {
      name: 'read_page',
      description: 'Read a live Notion document page',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ id }) => {
        const item = world.pages.find((row) => row.id === id);
        return jsonResult({ source: 'live_mcp', page: item || null });
      },
    },
    {
      name: 'write_page',
      description: 'Write or update a Notion document page',
      inputSchema: { title: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async ({ title, body }) => {
        const page = {
          id: `page-${world.pages.length + 1}`,
          title,
          body,
          updatedAt: new Date().toISOString(),
        };
        world.pages.push(page);
        return jsonResult({ source: 'live_mcp', wrote: true, page });
      },
    },
  ];
}

export function githubParityTools(world) {
  return [
    {
      name: 'search_issues',
      description: 'Search github repository issues and pull requests',
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
      handler: async ({ query }) => {
        const q = String(query || '').toLowerCase();
        const hits = world.issues.filter((item) =>
          `${item.id} ${item.title}`.toLowerCase().includes(q),
        );
        return jsonResult({ source: 'live_mcp', hits });
      },
    },
    {
      name: 'list_assigned',
      description: 'List github issues assigned to me',
      inputSchema: { q: z.string().optional() },
      annotations: { readOnlyHint: true },
      handler: async () => jsonResult({
        source: 'live_mcp',
        hits: world.issues.filter((item) => item.assignee === 'me'),
      }),
    },
    {
      name: 'create_issue',
      description: 'Create a github issue in the repository',
      inputSchema: { title: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async ({ title }) => {
        const issue = {
          id: `iss-${world.issues.length + 1}`,
          title,
          assignee: 'me',
          state: 'open',
          pr: null,
        };
        world.issues.push(issue);
        return jsonResult({ source: 'live_mcp', wrote: true, issue });
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a github pull request for an issue. Leaves the PR unmerged.',
      inputSchema: { issueId: z.string(), title: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async ({ issueId, title }) => {
        const issue = world.issues.find((row) => String(row.id) === String(issueId));
        const pr = {
          id: `pr-${issueId}`,
          title,
          issueId,
          merged: false,
        };
        if (issue) issue.pr = pr;
        return jsonResult({ source: 'live_mcp', sent: true, pr });
      },
    },
    {
      name: 'delete_item',
      description: 'Delete a github issue or file permanently',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
      handler: async ({ id }) => jsonResult({ deleted: id, source: 'live_mcp' }),
    },
  ];
}
