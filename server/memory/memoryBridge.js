// ============================================================================
// server/memory/memoryBridge.js — temporary dual-write from trusted legacy facts
// ============================================================================
// Phase 2 Chat reads Memory. A few remaining UI/tool producers still write
// lykn_user_model_facts (learned tags, confirm chips, lykn_proposeFact).
// This module copies ONLY those trusted writes into Markdown so new
// information does not live solely on the legacy table.
//
// Temporary. Phase 3 removes the legacy producers and this bridge.
// Never writes inferred / pending / external facts.

import { createMemoryDocument, patchMemoryDocument } from './memoryWriter.js';
import { invalidateMemoryThreadPath } from './memoryChat.js';
import {
  FACT_KIND_TO_PATH,
  FACT_KIND_TO_SECTION,
  documentHasFactText,
  isTrustworthyLegacyFact,
} from './memoryMigration.js';

/**
 * Copy one trusted fact into the matching memory document.
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {object} fact
 * @param {{ sourceType?: string, previousText?: string }} [opts]
 */
export async function syncTrustedFactToMemory(store, userId, fact, { sourceType = 'user_confirmed', previousText = '' } = {}) {
  if (!store || !userId) return { ok: false, error: 'user_required' };
  const trusted = { ...fact, status: fact.status || 'stated' };
  if (!isTrustworthyLegacyFact(trusted)) return { ok: false, error: 'not_trustworthy' };

  const path = FACT_KIND_TO_PATH[trusted.fact_kind];
  const section = FACT_KIND_TO_SECTION[trusted.fact_kind];
  if (!path || !section) return { ok: false, error: 'unsupported_kind' };

  const text = String(trusted.fact_text || '').trim();
  const oldText = String(previousText || '').trim();

  const existing = await store.getDocument(userId, path, { includeArchived: true });
  if (existing?.status === 'archived') return { ok: false, error: 'memory_archived' };

  if (!existing) {
    const created = await createMemoryDocument(store, userId, {
      path,
      markdown: `## ${section}\n\n- ${text}\n`,
      sourceType,
      meta: { bridge: 'legacy_fact', factId: trusted.id || null },
    });
    if (created.ok) invalidateMemoryThreadPath(userId, path);
    return created;
  }

  if (oldText && documentHasFactText(existing.markdown, oldText) && oldText !== text) {
    const replaced = await patchMemoryDocument(store, userId, {
      path,
      patch: { op: 'replace_text', find: oldText, replace: text },
      sourceType,
      meta: { bridge: 'legacy_fact', factId: trusted.id || null, op: 'replace_text' },
    });
    if (replaced.ok) {
      invalidateMemoryThreadPath(userId, path);
      return replaced;
    }
    // Fall through to append if the old text was not unique.
  }

  if (documentHasFactText(existing.markdown, text)) {
    return { ok: true, skipped: true, reason: 'already_present' };
  }

  const patched = await patchMemoryDocument(store, userId, {
    path,
    patch: { op: 'append_section', section, text: `- ${text}` },
    sourceType,
    meta: { bridge: 'legacy_fact', factId: trusted.id || null },
  });
  if (patched.ok) invalidateMemoryThreadPath(userId, path);
  return patched;
}
