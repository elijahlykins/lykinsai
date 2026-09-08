/**
 * Connected-app work for a Chat stream turn.
 *
 * Awareness ([CONNECTED_TOOLS]) stays on so the model can see what the user
 * linked. The agent loop (search/call + keepToolsOn) only arms when this turn
 * actually needs an external app — not because a connection exists.
 */

import { inferCapabilityNeeds } from './inferCapabilityNeed.js';
import { inferExternalCapabilityNeeds } from '../../mcp-tools/chatIntentSignals.js';
import { connectionNamedIn } from './toolRegistrySearch.js';
import { resolveMcpToolsForTurn } from './chatTurn.js';

const CONNECTED_AWARENESS_RE = /\b(connected|oauth|integration)\b/i;
const SKIP_RESOLVE_REASONS = new Set([
  'no_connections',
  'no_runtime',
  'no_external_need',
  'bot_connection_restricted',
]);

export function mcpContextFromConversation(conversation, { turns = 6, maxChars = 400 } = {}) {
  return (Array.isArray(conversation) ? conversation : [])
    .slice(-turns)
    .map((m) => String(m?.content || '').slice(0, maxChars))
    .filter(Boolean)
    .join('\n');
}

export function turnNeedsConnectedAppResolve({
  text,
  contextText,
  connectedApps,
  disclosure,
} = {}) {
  const msg = String(text || '');
  const ctx = String(contextText || '');
  const haystack = ctx ? `${msg}\n${ctx}` : msg;
  if (!haystack.trim()) return false;
  if (inferCapabilityNeeds(haystack).length) return true;
  if (inferExternalCapabilityNeeds(msg).length) return true;
  if (CONNECTED_AWARENESS_RE.test(haystack)) return true;
  if (Array.isArray(disclosure?.externalNeeds) && disclosure.externalNeeds.length) return true;
  if (Array.isArray(disclosure?.capabilities) && disclosure.capabilities.includes('connections.external')) {
    return true;
  }
  if ((connectedApps || []).some((conn) => connectionNamedIn(conn, haystack))) return true;
  return false;
}

export function shouldArmConnectedAppRegistry(mcpTurn) {
  if (!mcpTurn) return false;
  const reason = mcpTurn.resolution?.reason;
  if (SKIP_RESOLVE_REASONS.has(reason)) return false;
  const tools = mcpTurn.resolution?.tools || mcpTurn.tools || [];
  if (Array.isArray(tools) && tools.length) return true;
  if (mcpTurn.resolution?.ambiguous) return true;
  if (Array.isArray(mcpTurn.needs) && mcpTurn.needs.length) return true;
  return false;
}

export function connectedAppsNote(mcpTurn) {
  if (
    !mcpTurn?.resolution?.ambiguous ||
    !Array.isArray(mcpTurn.resolution.candidates) ||
    !mcpTurn.resolution.candidates.length
  ) {
    return '';
  }
  const names = mcpTurn.resolution.candidates
    .map((c) => c.accountIdentity || c.accountLabel || c.connectionName)
    .filter(Boolean)
    .join(', ');
  return (
    `[CONNECTED_APPS_NOTE]\nMore than one connected app could make the requested change (${names}). ` +
    'Their write tools are withheld for this turn only because the target is ambiguous - NOT a permissions problem. ' +
    'Ask the user which app to use; once they name it, the tools will be available.'
  );
}

export function publicConnectedApps(rows) {
  return (rows || [])
    .filter((row) => row.status === 'connected')
    .map((row) => ({
      id: row.id,
      name: row.name,
      accountLabel: row.accountLabel,
      accountIdentity: row.accountIdentity,
      catalogId: row.catalogId,
    }));
}

export async function loadConnectedAppRows({ manager, userId } = {}) {
  if (!manager || !userId) return [];
  try {
    return (await manager.store.list(userId)) || [];
  } catch {
    return [];
  }
}

export async function attachConnectedAppsToStreamTurn({
  manager,
  userId,
  authHeader,
  text,
  conversation,
  context,
  streamDisclosure,
  streamChatToolNames,
  connectedApps,
  connectedRows,
  fetchConnectedToolsSection,
} = {}) {
  let nextContext = context;
  let nextDisclosure = streamDisclosure;
  const nextToolNames = Array.isArray(streamChatToolNames) ? [...streamChatToolNames] : [];
  let mcpTurn = null;
  let useTools = false;

  try {
    const connectedSection = await fetchConnectedToolsSection(authHeader, userId);
    if (connectedSection) {
      nextContext = nextContext ? `${connectedSection}\n\n${nextContext}` : connectedSection;
    }
  } catch (e) {
    console.warn('⚠️ connected tools section skipped:', e?.message || e);
  }

  const mcpContextText = mcpContextFromConversation(conversation);
  if (
    turnNeedsConnectedAppResolve({
      text,
      contextText: mcpContextText,
      connectedApps,
      disclosure: streamDisclosure,
    })
  ) {
    try {
      mcpTurn = await resolveMcpToolsForTurn({
        manager,
        userId,
        text: String(text || ''),
        contextText: mcpContextText,
        connections: connectedRows,
      });
      const note = connectedAppsNote(mcpTurn);
      if (note) {
        nextContext = nextContext ? `${nextContext}\n\n${note}` : note;
      }
      if (shouldArmConnectedAppRegistry(mcpTurn)) {
        for (const name of ['lykn_search_connected_tools', 'lykn_call_connected_tool']) {
          if (!nextToolNames.includes(name)) nextToolNames.push(name);
        }
        nextDisclosure = {
          ...nextDisclosure,
          keepToolsOn: true,
          toolNames: nextToolNames,
        };
        useTools = true;
        console.log(
          '🔌 Stream: connected-app registry (search/call; ranked dump skipped)',
        );
      }
    } catch (e) {
      console.warn('⚠️ mcp turn resolve skipped:', e?.message || e);
    }
  }

  return {
    context: nextContext,
    streamDisclosure: nextDisclosure,
    streamChatToolNames: nextToolNames,
    mcpTurn,
    useTools,
  };
}
