// ============================================================================
// server/memory/memoryResolver.js — the future Chat memory seam
// ============================================================================
// Phase 2 will replace the legacy enrichment limbs around /api/lykn/invoke
// and /api/lykn/stream (fetchUserModelSection, fetchUserIdentitySection,
// fetchBeliefSection, fetchProjectSection, synthesis retrieval, related
// neighborhood) with ONE call:
//
//   const memory = await resolveMemoryContext(store, userId, { ... });
//
// NOT wired into production Chat yet — Phase 1 builds and proves it in
// isolation.
//
// Hybrid retrieval levels:
//   L0 — tiny automatic context: profile + preferences SUMMARIES only,
//        token-budgeted. Never whole documents.
//   L1 — compact registry: paths/descriptions/summaries so the model can
//        cheaply know what memories exist.
//   L2 — full Markdown for explicitly selected paths only, bounded by a
//        document count and a total token budget.
//
// Thread-level caching: callers pass `knownVersions` (path → version already
// present in the conversation). Unchanged documents come back as
// { unchanged: true } with no body, so repeated turns never re-fetch or
// re-inject identical memory.

import {
  MEMORY_L0_TOKEN_BUDGET,
  MEMORY_REGISTRY_TOKEN_BUDGET,
  MEMORY_MAX_SELECTED_DOCUMENTS,
  MEMORY_DEEP_READ_TOKEN_BUDGET,
  estimateMemoryTokens,
} from './memoryConfig.js';
import { listMemoryRegistry, formatMemoryRegistry } from './memoryRegistry.js';
import { readMemoryDocument } from './memoryReader.js';
import { parseMemoryPath } from './memoryPaths.js';

/** Memory types whose summaries feed the L0 automatic block. */
const L0_TYPES = new Set(['profile', 'preferences']);

/**
 * Build the tiny always-on context block from registry summaries.
 * @param {import('./memoryRegistry.js').MemoryRegistryEntry[]} entries
 * @param {number} tokenBudget
 * @returns {{ text: string, tokens: number }}
 */
export function buildMemoryL0Block(entries, tokenBudget = MEMORY_L0_TOKEN_BUDGET) {
  const lines = [];
  for (const e of entries) {
    if (!L0_TYPES.has(e.type) || !e.summary) continue;
    lines.push(`${e.name}: ${e.summary}`);
  }
  if (!lines.length) return { text: '', tokens: 0 };
  let text = ['[USER MEMORY]', ...lines].join('\n');
  while (lines.length > 1 && estimateMemoryTokens(text) > tokenBudget) {
    lines.pop();
    text = ['[USER MEMORY]', ...lines].join('\n');
  }
  if (estimateMemoryTokens(text) > tokenBudget) {
    // Even one summary is over budget — clamp it rather than drop everything.
    text = text.slice(0, tokenBudget * 4);
  }
  return { text, tokens: estimateMemoryTokens(text) };
}

/**
 * Resolve the memory context for one conversational turn.
 *
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {object} [opts]
 * @param {boolean} [opts.includeRegistry=true]  include the L1 index block
 * @param {string[]} [opts.selectPaths=[]]       L2: full documents to load
 *   (default NONE — deep reads are exceptional)
 * @param {Record<string, number>} [opts.knownVersions={}] path → version the
 *   thread already holds; unchanged docs are returned without bodies
 * @param {object} [opts.budgets] per-call overrides of the config budgets
 * @returns {Promise<{
 *   l0: { text: string, tokens: number },
 *   registry: { text: string, tokens: number, entries: import('./memoryRegistry.js').MemoryRegistryEntry[] },
 *   documents: Array<{ path: string, version: number, unchanged: boolean,
 *     markdown: string|null, tokens: number, error?: string }>,
 *   totalTokens: number,
 * }>}
 */
export async function resolveMemoryContext(store, userId, {
  includeRegistry = true,
  selectPaths = [],
  knownVersions = {},
  budgets = {},
} = {}) {
  const l0Budget = budgets.l0 ?? MEMORY_L0_TOKEN_BUDGET;
  const registryBudget = budgets.registry ?? MEMORY_REGISTRY_TOKEN_BUDGET;
  const maxDocuments = budgets.maxDocuments ?? MEMORY_MAX_SELECTED_DOCUMENTS;
  const deepReadBudget = budgets.deepRead ?? MEMORY_DEEP_READ_TOKEN_BUDGET;

  const entries = await listMemoryRegistry(store, userId);
  const l0 = buildMemoryL0Block(entries, l0Budget);
  const registryFormatted = includeRegistry
    ? formatMemoryRegistry(entries, { tokenBudget: registryBudget })
    : { text: '', tokens: 0, includedCount: 0 };

  const versionByPath = new Map(entries.map((e) => [e.path, e.version]));
  /** @type {Array<{ path: string, version: number, unchanged: boolean, markdown: string|null, tokens: number, error?: string }>} */
  const documents = [];
  let deepTokensUsed = 0;

  const uniquePaths = [...new Set((selectPaths || []).map(String))].slice(0, Math.max(0, maxDocuments));
  for (const rawPath of uniquePaths) {
    const parsed = parseMemoryPath(rawPath);
    if (!parsed.ok) {
      documents.push({ path: String(rawPath), version: 0, unchanged: false, markdown: null, tokens: 0, error: parsed.error });
      continue;
    }
    const currentVersion = versionByPath.get(parsed.path);
    if (currentVersion === undefined) {
      documents.push({ path: parsed.path, version: 0, unchanged: false, markdown: null, tokens: 0, error: 'memory_not_found' });
      continue;
    }
    // Thread cache hit: the conversation already holds this exact version.
    if (Number(knownVersions?.[parsed.path]) === currentVersion) {
      documents.push({ path: parsed.path, version: currentVersion, unchanged: true, markdown: null, tokens: 0 });
      continue;
    }
    const remaining = deepReadBudget - deepTokensUsed;
    if (remaining <= 0) {
      documents.push({ path: parsed.path, version: currentVersion, unchanged: false, markdown: null, tokens: 0, error: 'deep_read_budget_exhausted' });
      continue;
    }
    const read = await readMemoryDocument(store, userId, parsed.path, { maxTokens: remaining });
    if (!read.ok) {
      documents.push({ path: parsed.path, version: currentVersion, unchanged: false, markdown: null, tokens: 0, error: read.error });
      continue;
    }
    deepTokensUsed += read.tokens;
    documents.push({
      path: read.document.path,
      version: read.document.version,
      unchanged: false,
      markdown: read.document.markdown,
      tokens: read.tokens,
    });
  }

  return {
    l0,
    registry: { text: registryFormatted.text, tokens: registryFormatted.tokens, entries },
    documents,
    totalTokens: l0.tokens + registryFormatted.tokens + deepTokensUsed,
  };
}

/**
 * Instrumentation: sizes/counts only, never memory contents — safe to log.
 * Lets us prove this architecture is cheaper than Synthesis.
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 */
export async function measureMemoryFootprint(store, userId) {
  const entries = await listMemoryRegistry(store, userId);
  const l0 = buildMemoryL0Block(entries);
  const registry = formatMemoryRegistry(entries);
  return {
    documentCount: entries.length,
    l0Tokens: l0.tokens,
    registryTokens: registry.tokens,
    registryEntriesIncluded: registry.includedCount,
  };
}
