/**
 * Chat-turn progressive disclosure for MCP tools.
 */

import { inferCapabilityNeeds } from './inferCapabilityNeed.js';
import { resolveExternalTools } from './externalToolResolver.js';
import { toChatTools, mcpChatToolName } from './chatBridge.js';
import { executeMcpTool } from './executeMcpTool.js';

export async function resolveMcpToolsForTurn({
  manager,
  userId,
  text,
  contextText,
  botConnectionIds,
  connectionIds,
} = {}) {
  if (!manager || !userId) return { tools: [], bindings: {}, resolution: { tools: [], reason: 'no_runtime' } };
  const connections = await manager.store.list(userId);
  if (!connections.length) return { tools: [], bindings: {}, resolution: { tools: [], reason: 'no_connections' } };
  const classifiedByConnectionId = Object.fromEntries(
    connections.map((row) => [row.id, row.classifiedTools || []]),
  );
  // Follow-up turns rarely repeat the app ("ok now send it" after drafting an
  // email carries no email token), so needs are inferred over the current
  // message PLUS recent conversation context. The objective used for tool
  // scoring stays the current message.
  const needs = inferCapabilityNeeds(contextText ? `${text}\n${contextText}` : text);
  const resolution = resolveExternalTools({
    task: {
      objective: text,
      capabilities: needs,
      association: Array.isArray(connectionIds) ? { connectionIds } : {},
    },
    connections,
    classifiedByConnectionId,
    botConnectionIds,
    contextText,
  });
  const bridged = toChatTools(resolution.ok ? resolution.tools : []);
  return {
    ...bridged,
    resolution,
    needs,
    suggestions: resolution.suggestions || [],
  };
}

/**
 * Execute one MCP tool addressed by its bridged chat name (mcp_xxxxxxxx_tool)
 * without a pre-bound handler. Used by surfaces that receive a bare tool
 * call (voice realtime relay) after disclosure happened on an earlier
 * request. All executeMcpTool gates apply: connection status, resolution
 * membership, capability check, consequence approval, untrusted wrapping.
 */
export async function executeMcpToolByBridgedName({ manager, userId, name, args, signal, taskId, runId } = {}) {
  if (!manager || !userId || !name) return { ok: false, error: 'unknown_mcp_binding' };
  const connections = await manager.store.list(userId);
  for (const row of connections) {
    for (const t of row.classifiedTools || []) {
      if (mcpChatToolName(row.id, t.toolName) !== name) continue;
      const task = {
        id: taskId || `voice_${userId}`,
        runId: runId || taskId || `voice_${userId}`,
        userId,
        objective: '',
        capabilities: t.semanticCapabilities || [],
        approval: {
          policy: 'preserve_executor_security_gates',
          state: 'not_requested',
        },
        association: { connectionIds: [row.id] },
        cancellation: { state: 'active', signal: signal || null },
      };
      return executeMcpTool({
        task,
        userId,
        resolution: {
          tools: [
            {
              connectionId: row.id,
              toolName: t.toolName,
              consequenceHint: t.consequenceHint,
              semanticCapabilities: t.semanticCapabilities,
              description: t.description,
              inputSchema: t.inputSchema,
            },
          ],
        },
        connectionId: row.id,
        toolName: t.toolName,
        args: args && typeof args === 'object' ? args : {},
        connection: await manager.store.get(userId, row.id),
        callTool: (opts) =>
          manager.callTool({
            userId,
            connectionId: opts.connectionId,
            toolName: opts.toolName,
            args: opts.args,
            signal: opts.signal,
            taskId: opts.taskId,
            runId: opts.runId,
          }),
      });
    }
  }
  return { ok: false, error: 'unknown_mcp_binding' };
}

/**
 * Run one connected-app tool through the full MCP gate stack, including
 * the live approval round-trip when the surface can ask the user.
 * Used by both ranked `mcp_*` disclosure handlers and the registry
 * search → call path (`lykn_call_connected_tool`).
 */
export async function runConnectedAppToolCall({
  manager,
  userId,
  connectionId,
  toolName,
  classified,
  args,
  ctx,
  objective,
} = {}) {
  const uid = ctx?.userId || userId;
  const binding = {
    connectionId,
    toolName,
    semanticCapabilities: classified?.semanticCapabilities || [],
    consequenceHint: classified?.consequenceHint,
    description: classified?.description,
    inputSchema: classified?.inputSchema,
  };
  const syntheticTask = {
    id: ctx?.taskId || `chat_${uid}`,
    runId: ctx?.runId || ctx?.taskId || `chat_${uid}`,
    userId: uid,
    objective: String(objective || ctx?.userMessage || ''),
    capabilities: binding.semanticCapabilities,
    approval: {
      policy: 'preserve_executor_security_gates',
      state: 'not_requested',
    },
    association: { connectionIds: [connectionId] },
    cancellation: { state: 'active', signal: ctx?.signal || null },
  };
  const runWithConnection = async (approvalToken) =>
    executeMcpTool({
      task: syntheticTask,
      userId: uid,
      resolution: { tools: [binding] },
      connectionId,
      toolName,
      args: args && typeof args === 'object' ? args : {},
      approvalToken,
      connection: await manager.store.get(uid, connectionId),
      callTool: (opts) =>
        manager.callTool({
          userId: uid,
          connectionId: opts.connectionId,
          toolName: opts.toolName,
          args: opts.args,
          signal: opts.signal,
          taskId: opts.taskId,
          runId: opts.runId,
        }),
    });
  let executed = await runWithConnection(null);
  if (
    executed?.ok === false &&
    executed.status === 'waiting_for_approval' &&
    executed.approvalToken &&
    typeof ctx?.requestMcpApproval === 'function'
  ) {
    let approved = false;
    try {
      approved = await ctx.requestMcpApproval({
        toolName,
        connectionId,
        consequence: executed.consequence,
        request: executed.request,
      });
    } catch {
      approved = false;
    }
    executed = approved
      ? await runWithConnection(executed.approvalToken)
      : {
          ok: false,
          status: 'declined',
          reason: 'user_declined',
          note: 'The user declined this action in the approval prompt. Do not retry; acknowledge and ask what they would like instead.',
        };
  }
  return executed;
}

export function bindMcpChatHandlers(tools, bindings, { manager, userId, text }) {
  return (tools || []).map((tool) => ({
    ...tool,
    async handler(args, ctx) {
      const binding = bindings[tool.name];
      if (!binding) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_mcp_binding' }) }] };
      }
      const executed = await runConnectedAppToolCall({
        manager,
        userId,
        connectionId: binding.connectionId,
        toolName: binding.toolName,
        classified: {
          ...binding,
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        args,
        ctx,
        objective: text,
      });
      return {
        isError: executed.ok === false,
        content: [{ type: 'text', text: JSON.stringify(executed.observation || executed) }],
      };
    },
  }));
}
