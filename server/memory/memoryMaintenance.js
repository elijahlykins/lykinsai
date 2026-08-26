// ============================================================================
// server/memory/memoryMaintenance.js — event/threshold-driven compaction
// ============================================================================
// Deliberately NOT a nightly global Synthesis replacement. Maintenance is
// per-document and trigger-driven: when a write leaves a document over the
// size threshold or visibly duplicated, that ONE document gets compacted.
// No cron, no whole-user re-synthesis.
//
// V1 compaction is deterministic (dedupe + whitespace). An async `compactor`
// hook exists so a future LLM-backed compactor can plug in with its cost
// isolated here — it is never called implicitly.

import {
  MEMORY_COMPACTION_TRIGGER_CHARS,
  MEMORY_COMPACTION_DUPLICATE_RATIO,
} from './memoryConfig.js';
import { evaluateMemoryWrite } from './memoryPolicy.js';
import { parseMemoryPath } from './memoryPaths.js';
import { deriveMemorySummary, normalizeMemoryMarkdown } from './memoryMarkdown.js';

/**
 * Should this document be compacted?
 * @param {{ markdown: string }} doc
 * @returns {{ needed: boolean, reasons: string[] }}
 */
export function memoryNeedsCompaction(doc) {
  const markdown = String(doc?.markdown || '');
  const reasons = [];
  if (markdown.length >= MEMORY_COMPACTION_TRIGGER_CHARS) reasons.push('size_threshold');

  const lines = markdown.split('\n').map((l) => l.trim()).filter((l) => l.length > 3);
  if (lines.length >= 10) {
    const unique = new Set(lines);
    const duplicateRatio = (lines.length - unique.size) / lines.length;
    if (duplicateRatio >= MEMORY_COMPACTION_DUPLICATE_RATIO) reasons.push('duplication');
  }
  return { needed: reasons.length > 0, reasons };
}

/**
 * Deterministic compaction: drop exact-duplicate content lines (first
 * occurrence wins; headings and blank lines untouched), normalize whitespace.
 * @param {string} markdown
 * @returns {string}
 */
export function compactMemoryMarkdown(markdown) {
  const seen = new Set();
  const out = [];
  for (const line of String(markdown || '').split('\n')) {
    const trimmed = line.trim();
    const isContent = trimmed.length > 3 && !trimmed.startsWith('#');
    if (isContent) {
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
    }
    out.push(line);
  }
  return normalizeMemoryMarkdown(out.join('\n'));
}

/**
 * Compact ONE document: apply the deterministic pass (plus the optional
 * caller-supplied async compactor), persist via compare-and-swap, and record
 * a 'compact' version. No-ops when compaction changes nothing.
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {string} path
 * @param {{ sourceType?: string, compactor?: (markdown: string) => Promise<string> }} [opts]
 */
export async function compactMemoryDocument(store, userId, path, { sourceType = 'system_event', compactor } = {}) {
  if (!userId) return { ok: false, error: 'user_required' };
  const parsed = parseMemoryPath(path);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const policy = evaluateMemoryWrite({ sourceType, operation: 'compact', documentType: parsed.type });
  if (!policy.allowed) return { ok: false, error: policy.reason };

  const doc = await store.getDocument(userId, parsed.path);
  if (!doc) return { ok: false, error: 'memory_not_found' };

  let compacted = compactMemoryMarkdown(doc.markdown);
  if (typeof compactor === 'function') {
    const custom = normalizeMemoryMarkdown(await compactor(compacted));
    // A compactor that grows or empties the document is broken — ignore it.
    if (custom.trim() && custom.length <= compacted.length) compacted = custom;
  }
  if (compacted === doc.markdown) return { ok: true, changed: false };

  const updated = await store.updateDocument(userId, doc.id, doc.version, {
    markdown: compacted,
    summary: deriveMemorySummary(compacted),
  });
  if (!updated.ok) {
    if (updated.staleVersion) return { ok: false, error: 'version_conflict' };
    return { ok: false, error: 'compact_failed' };
  }
  await store.insertVersion(userId, {
    memory_document_id: doc.id,
    version: updated.row.version,
    markdown: compacted,
    change_type: 'compact',
    source_type: sourceType,
    meta: { beforeChars: doc.markdown.length, afterChars: compacted.length },
  });
  return { ok: true, changed: true, document: updated.row };
}
