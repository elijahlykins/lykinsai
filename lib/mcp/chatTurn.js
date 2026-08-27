/**
 * Chat-turn progressive disclosure for MCP tools.
 *
 * Chat never trusts request-shaped connectionIds.
 * Bot/Routine allowlists are server-owned and passed as botConnectionIds.
 */

import { inferCapabilityNeeds } from './inferCapabilityNeed.js';
import { resolveExternalTools } from './externalToolResolver.js';
import { toChatTools } from './chatBridge.js';
import { executeMcpTool } from './executeMcpTool.js';
import { suggestCatalogForCapabilities } from './catalog/curated.js';

function emptyTurn(reason, extra = {}) {
  return {
    tools: [],
    bindings: {},
    resolution: { tools: [], reason, ...extra },
    needs: extra.needs || [],
    suggestions: extra.suggestions || [],
  };
}

export async function resolveMcpToolsForTurn({
  manager,
  userId,
  text,
  botConnectionIds,
} = {}) {
  if (!manager || !userId) return emptyTurn('no_runtime');
  const needs = inferCapabilityNeeds(text);
  if (!needs.length) return emptyTurn('no_external_need', { needs: [] });

  const connections = await manager.store.list(userId);
  if (!connections.length) {
    const suggestions = suggestCatalogForCapabilities(needs);
    return emptyTurn('missing_capability', {
      ok: false,
      needs,
      suggestions,
    });
  }

  const classifiedByConnectionId = Object.fromEntries(
    connections.map((row) => [row.id, row.classifiedTools || []]),
  );
  const resolution = resolveExternalTools({
    task: {
      objective: text,
      capabilities: needs,
      association: {},
    },
    connections,
    classifiedByConnectionId,
    botConnectionIds,
  });
  const bridged = toChatTools(resolution.ok ? resolution.tools : []);
  return {
    ...bridged,
    resolution,
    needs,
    suggestions: resolution.suggestions || [],
  };
}

export function bindMcpChatHandlers(tools, bindings, { manager, userId, text }) {
  return (tools || []).map((tool) => ({
    ...tool,
    async handler(args, ctx) {
      const binding = bindings[tool.name];
      if (!binding) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_mcp_binding' }) }] };
      }
      const syntheticTask = {
        id: ctx?.taskId || `chat_${userId}`,
        runId: ctx?.runId || ctx?.taskId || `chat_${userId}`,
        userId,
        objective: String(text || ctx?.userMessage || ''),
        capabilities: binding.semanticCapabilities || [],
        approval: {
          policy: 'preserve_executor_security_gates',
          state: 'not_requested',
        },
        association: { connectionIds: [binding.connectionId] },
        cancellation: { state: 'active', signal: ctx?.signal || null },
      };
      const executed = await executeMcpTool({
        task: syntheticTask,
        userId: ctx?.userId || userId,
        resolution: { tools: [{ ...binding, description: tool.description, inputSchema: tool.inputSchema }] },
        connectionId: binding.connectionId,
        toolName: binding.toolName,
        args: args && typeof args === 'object' ? args : {},
        connection: await manager.store.get(ctx?.userId || userId, binding.connectionId),
        callTool: (opts) =>
          manager.callTool({
            userId: ctx?.userId || userId,
            connectionId: opts.connectionId,
            toolName: opts.toolName,
            args: opts.args,
            signal: opts.signal,
            taskId: opts.taskId,
            runId: opts.runId,
          }),
      });
      return {
        isError: executed.ok === false,
        content: [{ type: 'text', text: JSON.stringify(executed.observation || executed) }],
      };
    },
  }));
}
