/**
 * ExternalToolResolver
 *
 * Ranking:
 *   1. explicit connectionId
 *   2. Bot/Routine allowed connections
 *   3. capability match
 *   4. account relevance
 *   5. trust
 *   6. tool confidence
 *
 * Model descriptions cannot select unauthorized connections.
 * Ambiguous consequential writes do not guess an account.
 *
 * First-party GitHub tools remain outside this resolver. If a GitHub MCP
 * connection is also present, this resolver only discloses the MCP tools
 * when the Task needs source_control and the connection is allowed. It
 * does not hide first-party GitHub tools; chat/runtime must not add the
 * same GitHub MCP tools twice. If both are plausible and no connection
 * is assigned, prefer the explicit connectionId; otherwise leave
 * first-party GitHub in the first-party set and omit MCP GitHub until
 * the user assigns it.
 */

import { MCP_BOUNDS } from './bounds.js';
import {
  capabilitySatisfies,
  CONSEQUENCE,
  parseCapability,
  writeRequiresExplicitConnection,
} from './capabilityRegistry.js';
import { inferCapabilityNeeds } from './inferCapabilityNeed.js';
import { AUTH_REQUIRED_STATUSES, MCP_STATUSES, MCP_TRUST_LEVELS } from './protocol.js';
import { searchExternalToolIndex, buildExternalToolIndex } from './toolIndex.js';
import { suggestCatalogForCapabilities } from './catalog/curated.js';

const TRUST_SCORE = {
  [MCP_TRUST_LEVELS.OFFICIAL]: 4,
  [MCP_TRUST_LEVELS.VERIFIED]: 3,
  [MCP_TRUST_LEVELS.ENTERPRISE]: 3,
  [MCP_TRUST_LEVELS.COMMUNITY]: 1,
  [MCP_TRUST_LEVELS.CUSTOM]: 0,
  [MCP_TRUST_LEVELS.REMOTE]: 0,
  [MCP_TRUST_LEVELS.LOCAL_TRUSTED]: 1,
};

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

function scoreTool(classified, needs, conn, { explicitConnection, objective } = {}) {
  let score = 0;
  for (const cap of classified.semanticCapabilities || classified.capabilities || []) {
    for (const need of needs) {
      if (capabilitySatisfies(cap, need)) score += 10;
      const have = parseCapability(cap);
      const want = parseCapability(need);
      if (have && want && have.domain === want.domain) score += 3;
    }
  }
  if (explicitConnection && String(conn.id) === String(explicitConnection)) score += 20;
  const identityBlob = `${conn.accountLabel || ''} ${conn.accountIdentity || ''} ${conn.name || ''}`;
  if (objective && identityBlob && objective.toLowerCase().includes(String(conn.accountLabel || conn.name || '').toLowerCase()) && (conn.accountLabel || conn.name)) {
    score += 2;
  }
  score += TRUST_SCORE[conn.trustLevel] || 0;
  score += classified.confidence || 0;
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
  if (allowlist && allowlist.length === 0) {
    return {
      ok: false,
      tools: [],
      needs: resolvedNeeds,
      reason: 'bot_connection_restricted',
      ambiguous: false,
    };
  }

  const scoped = filterConnections(connections, allowlist);
  const eligible = scoped.filter((conn) => conn.status === MCP_STATUSES.CONNECTED);
  const authBlocked = scoped.filter((conn) => AUTH_REQUIRED_STATUSES.includes(conn.status));
  const unavailable = scoped.filter(
    (conn) => conn.status && conn.status !== MCP_STATUSES.CONNECTED && !AUTH_REQUIRED_STATUSES.includes(conn.status),
  );

  if (allowlist && allowlist.length && !eligible.length) {
    const referenced = scoped[0] || connections?.find((c) => allowlist.includes(String(c.id)));
    if (referenced && AUTH_REQUIRED_STATUSES.includes(referenced.status)) {
      return {
        ok: false,
        tools: [],
        needs: resolvedNeeds,
        reason: 'connection_auth_required',
        condition: 'connection_auth_required',
        connectionId: referenced.id,
        ambiguous: false,
      };
    }
    if (referenced && referenced.status !== MCP_STATUSES.CONNECTED) {
      return {
        ok: false,
        tools: [],
        needs: resolvedNeeds,
        reason: 'connection_required',
        condition: 'connection_required',
        connectionId: referenced.id,
        ambiguous: false,
      };
    }
  }

  const explicitConnection =
    Array.isArray(task?.association?.connectionIds) && task.association.connectionIds.length === 1
      ? String(task.association.connectionIds[0])
      : null;

  const index = buildExternalToolIndex(eligible, classifiedByConnectionId);
  const ranked = [];
  for (const conn of eligible) {
    const classified = classifiedByConnectionId?.[conn.id] || conn.classifiedTools || [];
    for (const tool of classified) {
      const score = scoreTool(tool, resolvedNeeds, conn, { explicitConnection, objective });
      if (score < 10) continue;
      ranked.push({
        connectionId: conn.id,
        connectionName: conn.name,
        accountLabel: conn.accountLabel,
        accountIdentity: conn.accountIdentity,
        trustLevel: conn.trustLevel,
        toolName: tool.toolName || tool.serverToolName,
        semanticCapabilities: tool.semanticCapabilities || tool.capabilities,
        consequenceHint: tool.consequenceHint || tool.consequence,
        consequence: tool.consequence || tool.consequenceHint,
        confidence: tool.confidence,
        description: tool.description,
        inputSchema: tool.inputSchema,
        schemaFingerprint: tool.schemaFingerprint,
        classifierVersion: tool.classifierVersion,
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
          accountLabel: tools[0]?.accountLabel,
          accountIdentity: tools[0]?.accountIdentity,
          toolNames: tools.map((t) => t.toolName).slice(0, 8),
        })),
      };
    }
  }

  const limited = ranked.slice(0, Math.max(1, maxTools));
  if (!limited.length) {
    const suggestions = suggestCatalogForCapabilities(resolvedNeeds).slice(0, 3).map((entry) => ({
      catalogId: entry.id,
      name: entry.name,
      trust: entry.trust,
      source: entry.source,
      capabilities: entry.capabilities,
    }));
    return {
      ok: false,
      tools: [],
      needs: resolvedNeeds,
      reason: 'missing_capability',
      condition: 'missing_capability',
      missingCapabilities: resolvedNeeds,
      suggestions,
      ambiguous: false,
    };
  }
  return {
    ok: true,
    tools: limited,
    needs: resolvedNeeds,
    reason: limited.length ? 'resolved' : 'no_matching_tools',
    ambiguous: false,
    indexHits: searchExternalToolIndex(index, resolvedNeeds).length,
    unavailable: [
      ...unavailable.map((conn) => ({ connectionId: conn.id, name: conn.name, status: conn.status })),
      ...authBlocked.map((conn) => ({
        connectionId: conn.id,
        name: conn.name,
        status: conn.status,
        condition: 'connection_auth_required',
      })),
    ],
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
