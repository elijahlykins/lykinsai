/**
 * Chat-turn progressive disclosure for MCP tools.
 */

import { inferCapabilityNeeds } from './inferCapabilityNeed.js';
import { resolveExternalTools } from './externalToolResolver.js';
import { toChatTools } from './chatBridge.js';
import { executeMcpTool } from './executeMcpTool.js';

export async function resolveMcpToolsForTurn({
  manager,
  userId,
  text,
  botConnectionIds,
  connectionIds,
} = {}) {
  if (!manager || !userId) return { tools: [], bindings: {}, resolution: { tools: [], reason: 'no_runtime' } };
  const connections = await manager.store.list(userId);
  if (!connections.length) return { tools: [], bindings: {}, resolution: { tools: [], reason: 'no_connections' } };
  const classifiedByConnectionId = Object.fromEntries(
    connections.map((row) => [row.id, row.classifiedTools || []]),
  );
  const needs = inferCapabilityNeeds(text);
  const resolution = resolveExternalTools({
    task: {
      objective: text,
      capabilities: needs,
      association: Array.isArray(connectionIds) ? { connectionIds } : {},
    },
    connections,
    classifiedByConnectionId,
    botConnectionIds,
  });
  const bridged = toChatTools(resolution.ok ? resolution.tools : []);
  return { ...bridged, resolution, needs };
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
        objective: String(text || ctx?.userMessage || ''),
        capabilities: binding.semanticCapabilities || [],
        approval: {
          policy:
            binding.consequenceHint === 'DESTRUCTIVE'
              ? 'preserve_executor_security_gates'
              : 'standing_authorization',
          state: 'not_requested',
        },
        cancellation: { state: 'active', signal: ctx?.signal || null },
      };
      const executed = await executeMcpTool({
        task: syntheticTask,
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
