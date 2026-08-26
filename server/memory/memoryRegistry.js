// ============================================================================
// server/memory/memoryRegistry.js — L1: what memories exist (compact)
// ============================================================================
// The registry is DERIVED from active memory documents — there is no separate
// hand-maintained index that can drift. It is deliberately cheap: metadata +
// summaries only, never Markdown bodies.

import { MEMORY_REGISTRY_TOKEN_BUDGET, estimateMemoryTokens } from './memoryConfig.js';

/**
 * @typedef {object} MemoryRegistryEntry
 * @property {string} path
 * @property {string} name
 * @property {string|null} description
 * @property {string} type
 * @property {string|null} summary
 * @property {number} version
 * @property {string} updatedAt
 */

/**
 * List the user's active memories as compact metadata (no bodies).
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @returns {Promise<MemoryRegistryEntry[]>}
 */
export async function listMemoryRegistry(store, userId) {
  if (!userId) return [];
  const rows = await store.listActiveDocuments(userId);
  return rows.map((r) => ({
    path: r.path,
    name: r.name,
    description: r.description ?? null,
    type: r.type,
    summary: r.summary ?? null,
    version: r.version,
    updatedAt: r.updated_at,
  }));
}

/**
 * Format registry entries as a compact prompt block within a token budget.
 * Entries are most-recently-updated first; when over budget we first drop
 * summaries (keeping path + description), then drop whole stale entries.
 * @param {MemoryRegistryEntry[]} entries
 * @param {{ tokenBudget?: number }} [opts]
 * @returns {{ text: string, tokens: number, includedCount: number }}
 */
export function formatMemoryRegistry(entries, { tokenBudget = MEMORY_REGISTRY_TOKEN_BUDGET } = {}) {
  if (!entries?.length) return { text: '', tokens: 0, includedCount: 0 };

  const line = (e, withSummary) => {
    const desc = e.description ? ` — ${e.description}` : '';
    const sum = withSummary && e.summary ? ` :: ${e.summary}` : '';
    return `- ${e.path} (${e.type})${desc}${sum}`;
  };
  const render = (list, withSummary) =>
    ['[USER MEMORY INDEX]', ...list.map((e) => line(e, withSummary))].join('\n');

  let withSummary = true;
  let list = entries;
  let text = render(list, withSummary);
  if (estimateMemoryTokens(text) > tokenBudget) {
    withSummary = false;
    text = render(list, withSummary);
  }
  while (list.length > 1 && estimateMemoryTokens(text) > tokenBudget) {
    list = list.slice(0, -1); // entries are updated_at DESC — drop stalest
    text = render(list, withSummary);
  }
  if (estimateMemoryTokens(text) > tokenBudget) {
    return { text: '', tokens: 0, includedCount: 0 };
  }
  return { text, tokens: estimateMemoryTokens(text), includedCount: list.length };
}
