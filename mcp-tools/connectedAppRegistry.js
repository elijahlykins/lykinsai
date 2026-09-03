/**
 * Connected-app tool registry — search every connected app's actions,
 * then call the one that matches. In-app only (chat / voice ctx), not
 * exposed as an external MCP tool.
 *
 * Chat does not dump ranked mcp_* schemas. This registry is how the
 * model reaches the rest of an app (Supabase has 100+, GitHub 500)
 * without us guessing the right 10 in advance.
 */

import { jsonContent, errorContent } from './content.js';
import { MCP_STATUSES } from '../lib/mcp/protocol.js';
import { MCP_BOUNDS } from '../lib/mcp/bounds.js';
import { toolCachePolicyIsCurrent } from '../lib/mcp/toolCacheSelect.js';
import {
  matchConnectedApp,
  searchConnectedToolRegistry,
  unresolvedRequiredArgs,
} from '../lib/mcp/toolRegistrySearch.js';
import { runConnectedAppToolCall } from '../lib/mcp/chatTurn.js';

async function listLiveConnections(ctx) {
  const manager = ctx?.mcpManager;
  const userId = ctx?.userId;
  if (!manager || !userId) return [];
  const rows = await manager.store.list(userId);
  const live = (rows || []).filter((row) => row.status === MCP_STATUSES.CONNECTED);
  // A 500-tool cap used to keep the first page of GitHub (GET_A_BLOB,
  // LIST_ACCESSIBLE with installation_id) and drop the user-OAuth enumerator.
  // Re-discover once after the cache policy changes.
  if (typeof manager.refreshMetadata === 'function') {
    for (const row of live) {
      const count = Array.isArray(row.classifiedTools) ? row.classifiedTools.length : 0;
      if (count < MCP_BOUNDS.MAX_TOOLS_CACHED || toolCachePolicyIsCurrent(row.capabilitySummary)) {
        continue;
      }
      try {
        await manager.refreshMetadata(userId, row.id);
      } catch {
        /* keep the stale catalog; search still runs */
      }
    }
    const refreshed = await manager.store.list(userId);
    return (refreshed || []).filter((row) => row.status === MCP_STATUSES.CONNECTED);
  }
  return live;
}

export function identityFromToolResult(parsed) {
  const data = parsed?.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data
    : parsed;
  for (const key of ['login', 'username', 'user_login', 'handle']) {
    const value = typeof data?.[key] === 'string' ? data[key].trim() : '';
    if (value && !value.includes('@') && !/\s/.test(value)) return value.slice(0, 80);
  }
  const email = typeof data?.email === 'string' ? data.email.trim() : '';
  if (email.includes('@') && !/\s/.test(email)) return email.slice(0, 120);
  return '';
}

const STILL_CONNECTED_HINT =
  'This app is still connected. Do not tell the user to reconnect or to visit Settings. ' +
  'Search again for a ready tool (empty required args, authenticated/current user, or get-by-name) and call that.';

export function interpretConnectedToolPayload(executed) {
  const observation = executed?.observation || executed;
  const data = observation?.data && typeof observation.data === 'object' ? observation.data : observation;
  const text = Array.isArray(data?.content)
    ? data.content.map((part) => part?.text).filter(Boolean).join('\n')
    : typeof observation === 'string'
      ? observation
      : '';
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  const body = parsed && typeof parsed === 'object' ? parsed : data;
  const failed =
    executed?.ok === false ||
    data?.isError === true ||
    body?.successful === false ||
    Boolean(body?.error);
  return {
    failed,
    parsed: body,
    text,
    statusCode: body?.data?.status_code || body?.status_code || null,
  };
}

export const searchConnectedToolsTool = {
  name: 'lykn_search_connected_tools',
  title: 'Search a connected app\'s tools',
  scope: 'read',
  description: [
    'This is how you use EVERY OAuth-connected app (Gmail, Notion, GitHub,',
    'Supabase, Mailchimp, and any other connection). Each app has a large',
    'action catalog — search it like skills, then CALL the match. A search',
    'result is not an answer.',
    '',
    'Prefer tools with ready=true. Use suggestedArgs. Tools that need an',
    'opaque id (anything ending in _id / _ref / _sha) you do not have are',
    'the wrong first call — call a ready list/search or authenticated/',
    'current-user tool instead.',
    'Always search before asking the user for an id, URL, or "project ref".',
    'Pass `app` when you know which connection; omit it to search all.',
    '',
    'Do not invent tool names. Do not tell the user to reconnect because a',
    'tool failed — try the next ready tool.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'What you want to do, in plain language (list projects, unread mail, add a page).',
      },
      app: {
        type: 'string',
        description: 'Optional app name (Supabase, Gmail, Notion). Omit to search every connected app.',
      },
    },
  },
  async handler(args = {}, ctx = {}) {
    const query = String(args.query || '').trim();
    if (!query) return errorContent('query is required.');
    const connections = await listLiveConnections(ctx);
    if (!connections.length) {
      return jsonContent({
        ok: true,
        tools: [],
        note: 'No OAuth apps are connected. Point the user at Settings → Connections.',
      });
    }
    if (args.app && !matchConnectedApp(connections, args.app)) {
      return jsonContent({
        ok: false,
        tools: [],
        note: `No connected app matches "${args.app}". Connected: ${connections.map((c) => c.name).join(', ')}.`,
      });
    }
    const classifiedByConnectionId = Object.fromEntries(
      connections.map((row) => [row.id, row.classifiedTools || []]),
    );
    const tools = searchConnectedToolRegistry({
      connections,
      classifiedByConnectionId,
      query,
      contextText: ctx.userMessage && ctx.userMessage !== query ? ctx.userMessage : '',
      app: args.app,
      limit: 8,
    });
    const readyCount = tools.filter((tool) => tool.ready).length;
    return jsonContent({
      ok: true,
      tools,
      note: tools.length
        ? readyCount
          ? 'Call a ready tool now with lykn_call_connected_tool. Pass suggestedArgs. A search is not an answer.'
          : `No ready tool yet. Call an authenticated/current-user tool first to resolve ids, then search/call again. ${STILL_CONNECTED_HINT}`
        : 'No matching tools. Try a shorter action phrase, or drop `app` to search every connection.',
    });
  },
};

export const callConnectedToolTool = {
  name: 'lykn_call_connected_tool',
  title: 'Call a connected app tool',
  scope: 'write',
  description: [
    'Run one action on a connected app after lykn_search_connected_tools',
    'told you the exact tool name and arguments. Prefer ready tools and',
    'pass suggestedArgs. Sends, deletes, and other consequential actions',
    'still ask the user to confirm. Do not invent tool names.',
    'If this call errors, search again for a ready tool. Do not tell the',
    'user to reconnect unless [CONNECTED_APPS — OAuth] says so.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['app', 'tool'],
    properties: {
      app: {
        type: 'string',
        description: 'Connected app name (Supabase, Gmail, Notion) or connection id.',
      },
      tool: {
        type: 'string',
        description: 'Exact tool name from the registry search (e.g. SUPABASE_LIST_ALL_PROJECTS).',
      },
      args: {
        type: 'object',
        description: 'Arguments for that tool, matching the schema from the search result.',
        additionalProperties: true,
      },
    },
  },
  async handler(args = {}, ctx = {}) {
    const manager = ctx?.mcpManager;
    if (!manager || !ctx?.userId) return errorContent('Unauthorized — no LYKN user resolved.');
    const connections = await listLiveConnections(ctx);
    const conn = matchConnectedApp(connections, args.app);
    if (!conn) {
      return errorContent(
        `No connected app matches "${args.app || ''}". Search first with lykn_search_connected_tools.`,
      );
    }
    const toolName = String(args.tool || '').trim();
    const classified = (conn.classifiedTools || []).find(
      (t) => String(t.toolName || t.serverToolName) === toolName,
    );
    if (!classified) {
      return errorContent(
        `Tool "${toolName}" is not on ${conn.name}. Search the registry with lykn_search_connected_tools.`,
      );
    }
    const callArgs = args.args && typeof args.args === 'object' ? args.args : {};
    const missing = unresolvedRequiredArgs(classified.inputSchema, callArgs);
    if (missing.length) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: 'missing_required_args',
            tool: toolName,
            missing,
            hint: STILL_CONNECTED_HINT,
          }),
        }],
      };
    }
    const executed = await runConnectedAppToolCall({
      manager,
      userId: ctx.userId,
      connectionId: conn.id,
      toolName,
      classified,
      args: callArgs,
      ctx,
      objective: ctx.userMessage || toolName,
    });
    const interpreted = interpretConnectedToolPayload(executed);
    if (interpreted.failed) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: false,
            error: interpreted.parsed?.error || executed.reason || 'connected_tool_failed',
            tool: toolName,
            statusCode: interpreted.statusCode,
            detail: interpreted.parsed || executed.observation || executed,
            hint: STILL_CONNECTED_HINT,
          }),
        }],
      };
    }
    if (!conn.accountIdentity) {
      const identity = identityFromToolResult(interpreted.parsed);
      if (identity) {
        try {
          await manager.store.update(ctx.userId, conn.id, { accountIdentity: identity });
        } catch {
          /* display hint only — a failed persist must not hide a good result */
        }
      }
    }
    return {
      isError: false,
      content: [{ type: 'text', text: JSON.stringify(executed.observation || executed) }],
    };
  },
};
