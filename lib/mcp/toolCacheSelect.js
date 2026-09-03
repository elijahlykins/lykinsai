/**
 * Large MCP catalogs (GitHub is 500+) cannot all be stored. Taking the
 * first N alphabetically drops the tools an agent needs first: list /
 * search / authenticated-user entry points that happen to sort late.
 *
 * Selection is schema-driven and app-agnostic.
 */

import { MCP_BOUNDS } from './bounds.js';
import { isOpaqueArgKey } from './toolRegistrySearch.js';

export const TOOL_CACHE_POLICY_VERSION = 1;

function toolName(tool) {
  return String(tool?.name || tool?.toolName || tool?.serverToolName || '');
}

function requiredOf(tool) {
  const required = tool?.inputSchema?.required;
  return Array.isArray(required) ? required.map(String) : [];
}

export function toolCachePriority(tool) {
  const name = toolName(tool).replace(/[^a-z0-9]+/gi, ' ').trim();
  const required = requiredOf(tool);
  const opaqueCount = required.filter((key) => isOpaqueArgKey(key)).length;
  let score = 0;
  if (/\b(authenticated|current.?user|for_the_user|viewer)\b/i.test(name)) score += 50;
  if (/\b(list|search|fetch)\b/i.test(name) && opaqueCount === 0) score += 40;
  if (required.length === 0) score += 15;
  if (/\b(get|read)\b/i.test(name) && opaqueCount === 0 && required.length <= 3) score += 12;
  if (/\b(alpha|beta|deprecated|legacy)\b/i.test(name)) score -= 20;
  if (opaqueCount > 0 && opaqueCount === required.length) score -= 8;
  return score;
}

/**
 * Keep at most `max` tools, preferring discovery entry points over
 * early-alphabet GET_A_* / id-gated lists.
 */
export function selectToolsForCache(tools, max = MCP_BOUNDS.MAX_TOOLS_CACHED) {
  const list = Array.isArray(tools) ? tools : [];
  const cap = Math.min(Math.max(Number(max) || MCP_BOUNDS.MAX_TOOLS_CACHED, 1), MCP_BOUNDS.MAX_TOOLS_DISCOVERED);
  if (list.length <= cap) return list;
  return list
    .map((tool, index) => ({ tool, index, score: toolCachePriority(tool) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, cap)
    .sort((a, b) => a.index - b.index)
    .map((row) => row.tool);
}

export function toolCachePolicyIsCurrent(summary) {
  return Number(summary?.toolCachePolicy) === TOOL_CACHE_POLICY_VERSION;
}
