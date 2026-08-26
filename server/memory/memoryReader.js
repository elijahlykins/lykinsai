// ============================================================================
// server/memory/memoryReader.js — L2: read one full memory document
// ============================================================================
// Deep reads are exceptional, not default — the resolver and tool surface
// gate how many happen per turn. This module enforces the per-read contract:
// validated path, user ownership (via the user-scoped store), active status,
// and a token ceiling on output.

import { MEMORY_READ_MAX_TOKENS, estimateMemoryTokens } from './memoryConfig.js';
import { parseMemoryPath } from './memoryPaths.js';
import { clampMemoryMarkdownToTokens } from './memoryMarkdown.js';

/**
 * Read a single active memory document by logical path.
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {string} rawPath
 * @param {{ maxTokens?: number }} [opts]
 * @returns {Promise<{ ok: true, document: { path: string, name: string,
 *   description: string|null, type: string, version: number,
 *   updatedAt: string, summary: string|null, markdown: string },
 *   truncated: boolean, tokens: number } | { ok: false, error: string }>}
 */
export async function readMemoryDocument(store, userId, rawPath, { maxTokens = MEMORY_READ_MAX_TOKENS } = {}) {
  if (!userId) return { ok: false, error: 'user_required' };
  const parsed = parseMemoryPath(rawPath);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const row = await store.getDocument(userId, parsed.path);
  if (!row) return { ok: false, error: 'memory_not_found' };

  const capped = clampMemoryMarkdownToTokens(row.markdown, Math.min(maxTokens, MEMORY_READ_MAX_TOKENS));
  return {
    ok: true,
    document: {
      path: row.path,
      name: row.name,
      description: row.description ?? null,
      type: row.type,
      version: row.version,
      updatedAt: row.updated_at,
      summary: row.summary ?? null,
      markdown: capped.markdown,
    },
    truncated: capped.truncated,
    tokens: estimateMemoryTokens(capped.markdown),
  };
}
