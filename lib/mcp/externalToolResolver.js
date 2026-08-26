/**
 * ExternalToolResolver
 *
 * Task + semantic needs + user connections + Bot restrictions
 *   → small ranked relevant tool set.
 *
 * Never dumps every discovered tool into the model.
 * Multi-account writes do not pick an arbitrary connection.
 */

import { MCP_BOUNDS } from './bounds.js';
import {
  capabilitySatisfies,
  CONSEQUENCE,
  parseCapability,
  writeRequiresExplicitConnection,
} from './capabilityRegistry.js';
import { inferCapabilityNeeds } from './inferCapabilityNeed.js';
import { MCP_STATUSES } from './protocol.js';

function connectionAllowlist(task, botConnectionIds) {
  if (Array.isArray(task?.association?.connectionIds)) {
    return task.association.connectionIds.map(String);
  }
  if (Array.isArray(botConnectionIds)) return botConnectionIds.map(String);
  return null;
}

function filterConnections(connections, allowlist) {
  const list = Array.isArray(connections) ? connections : [];
  if (!allowlist) return list;
  const set = new Set(allowlist);
  return list.filter((conn) => set.has(String(conn.id)));
}

function scoreTool(classified, needs) {
  let score = 0;
  for (const cap of classified.semanticCapabilities || []) {
    for (const need of needs) {
      if (capabilitySatisfies(cap, need)) score += 10;
      const have = parseCapability(cap);
      const want = parseCapability(need);
      if (have && want && have.domain === want.domain) score += 3;
    }
  }
  if (classified.confidence) score += classified.confidence;
  return score;
}

export function resolveExternalTools({
  task,
  needs,
  connections,
  classifiedByConnectionId,
  botConnectionIds,
  maxTools = MCP_BOUNDS.MAX_TOOLS_PER_DISCLOSURE,
} = {}) {
  const objective = String(task?.objective || '');
  const resolvedNeeds =
    Array.isArray(needs) && needs.length
      ? needs
      : inferCapabilityNeeds(objective, { explicit: task?.capabilities });

  if (!resolvedNeeds.length) {
    return {
      ok: true,
      tools: [],
      needs: [],
      reason: 'no_external_need',
      ambiguous: false,
    };
  }

  const allowlist = connectionAllowlist(task, botConnectionIds);
  const eligible = filterConnections(connections, allowlist).filter(
    (conn) => conn.status === MCP_STATUSES.CONNECTED || conn.status === 'connected',
  );

  if (allowlist && allowlist.length === 0) {
    return {
      ok: false,
      tools: [],
      needs: resolvedNeeds,
      reason: 'bot_connection_restricted',
      ambiguous: false,
    };
  }

  const unavailable = filterConnections(connections, allowlist).filter(
    (conn) => conn.status && conn.status !== MCP_STATUSES.CONNECTED && conn.status !== 'connected',
  );

  const ranked = [];
  for (const conn of eligible) {
    const classified = classifiedByConnectionId?.[conn.id] || conn.classifiedTools || [];
    for (const tool of classified) {
      const score = scoreTool(tool, resolvedNeeds);
      if (score < 10) continue;
      ranked.push({
        connectionId: conn.id,
        connectionName: conn.name,
        toolName: tool.toolName,
        semanticCapabilities: tool.semanticCapabilities,
        consequenceHint: tool.consequenceHint,
        confidence: tool.confidence,
        description: tool.description,
        inputSchema: tool.inputSchema,
        score,
      });
    }
  }

  ranked.sort((a, b) => b.score - a.score);

  const writeNeeded = ranked.some((item) => writeRequiresExplicitConnection(item.consequenceHint));
  const byAccount = new Map();
  for (const item of ranked) {
    const list = byAccount.get(item.connectionId) || [];
    list.push(item);
    byAccount.set(item.connectionId, list);
  }

  const explicitConnection =
    Array.isArray(task?.association?.connectionIds) && task.association.connectionIds.length === 1
      ? String(task.association.connectionIds[0])
      : null;

  if (!explicitConnection && writeNeeded && byAccount.size > 1) {
    const writeAccounts = [...byAccount.entries()].filter(([, tools]) =>
      tools.some((tool) => writeRequiresExplicitConnection(tool.consequenceHint)),
    );
    if (writeAccounts.length > 1) {
      return {
        ok: false,
        tools: [],
        needs: resolvedNeeds,
        reason: 'ambiguous_account',
        ambiguous: true,
        candidates: writeAccounts.map(([id, tools]) => ({
          connectionId: id,
          connectionName: tools[0]?.connectionName,
          toolNames: tools.map((t) => t.toolName).slice(0, 8),
        })),
      };
    }
  }

  const limited = ranked.slice(0, Math.max(1, maxTools));
  return {
    ok: true,
    tools: limited,
    needs: resolvedNeeds,
    reason: limited.length ? 'resolved' : 'no_matching_tools',
    ambiguous: false,
    unavailable: unavailable.map((conn) => ({
      connectionId: conn.id,
      name: conn.name,
      status: conn.status,
    })),
  };
}

export function findResolvedTool(resolution, { connectionId, toolName } = {}) {
  const tools = resolution?.tools || [];
  return (
    tools.find(
      (tool) =>
        (!connectionId || tool.connectionId === connectionId) &&
        (!toolName || tool.toolName === toolName),
    ) || null
  );
}

export { CONSEQUENCE };
