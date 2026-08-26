/**
 * Internal capability index search. Not a model-visible catalog.
 * Resolver uses this to pick candidates before schema injection.
 */

import { capabilitySatisfies, parseCapability } from './capabilityRegistry.js';

export function buildExternalToolIndex(connections, classifiedByConnectionId) {
  const entries = [];
  for (const conn of connections || []) {
    const tools = classifiedByConnectionId?.[conn.id] || conn.classifiedTools || [];
    for (const tool of tools) {
      entries.push({
        connectionId: conn.id,
        connectionName: conn.name,
        accountLabel: conn.accountLabel,
        accountIdentity: conn.accountIdentity,
        trustLevel: conn.trustLevel,
        toolName: tool.toolName || tool.serverToolName,
        semanticCapabilities: tool.semanticCapabilities || tool.capabilities || [],
        consequenceHint: tool.consequenceHint || tool.consequence,
        confidence: tool.confidence,
        schemaFingerprint: tool.schemaFingerprint,
      });
    }
  }
  return entries;
}

export function searchExternalToolIndex(index, needs, { limit = 24 } = {}) {
  const want = Array.isArray(needs) ? needs : [];
  const scored = [];
  for (const entry of index || []) {
    let score = 0;
    for (const cap of entry.semanticCapabilities || []) {
      for (const need of want) {
        if (capabilitySatisfies(cap, need)) score += 10;
        const have = parseCapability(cap);
        const needed = parseCapability(need);
        if (have && needed && have.domain === needed.domain) score += 3;
      }
    }
    if (score >= 10) scored.push({ ...entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
