// ============================================================================
// server/memory/memoryWriter.js — authoritative mutation pipeline
// ============================================================================
// Every write to a memory document flows through here, in this order:
//   1. policy check (memoryPolicy — provenance decides trust)
//   2. path validation (memoryPaths)
//   3. load current document
//   4. optimistic version check (caller-supplied expectedVersion, if any)
//   5. apply the change (patch ops via memoryMarkdown; create/archive direct)
//   6. validate size/structure
//   7. persist via compare-and-swap + write a full-snapshot version row
//
// The version row is written AFTER the CAS succeeds, so history only records
// writes that actually landed. Provenance (source_type + small meta) lives in
// the version row, never in the visible Markdown.

import {
  MEMORY_MARKDOWN_MAX_CHARS,
  MEMORY_MIN_CREATE_CHARS,
  MEMORY_NAME_MAX_CHARS,
  MEMORY_DESCRIPTION_MAX_CHARS,
  MEMORY_META_MAX_CHARS,
} from './memoryConfig.js';
import { parseMemoryPath } from './memoryPaths.js';
import { evaluateMemoryWrite } from './memoryPolicy.js';
import {
  applyMemoryPatch,
  deriveMemorySummary,
  normalizeMemoryMarkdown,
} from './memoryMarkdown.js';

/** Clamp provenance meta to a small, JSON-serializable object. */
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  try {
    const serialized = JSON.stringify(meta);
    if (serialized.length > MEMORY_META_MAX_CHARS) return { truncated: true };
    return JSON.parse(serialized);
  } catch {
    return null;
  }
}

function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

/**
 * Create a new memory document.
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {object} args
 * @param {string} args.path       logical path (validated)
 * @param {string} args.markdown   initial body — must be meaningful content
 * @param {string} args.sourceType provenance
 * @param {string} [args.name]     display name (built-ins get a default)
 * @param {string} [args.description]
 * @param {object} [args.meta]     small structured provenance detail
 */
export async function createMemoryDocument(store, userId, { path, markdown, sourceType, name, description, meta } = {}) {
  if (!userId) return fail('user_required');
  const parsed = parseMemoryPath(path);
  if (!parsed.ok) return fail(parsed.error);

  const policy = evaluateMemoryWrite({ sourceType, operation: 'create', documentType: parsed.type });
  if (!policy.allowed) return fail(policy.reason, policy.deferred ? { deferred: true } : {});

  const body = normalizeMemoryMarkdown(markdown);
  if (body.trim().length < MEMORY_MIN_CREATE_CHARS) return fail('content_too_small');
  if (body.length > MEMORY_MARKDOWN_MAX_CHARS) return fail('content_too_large');

  const displayName = String(name || parsed.builtin?.name || parsed.slug || '').trim();
  if (!displayName || displayName.length > MEMORY_NAME_MAX_CHARS) return fail('invalid_name');
  const desc = String(description || parsed.builtin?.description || '').trim().slice(0, MEMORY_DESCRIPTION_MAX_CHARS) || null;

  const summary = deriveMemorySummary(body);
  const inserted = await store.insertDocument(userId, {
    path: parsed.path,
    name: displayName,
    description: desc,
    type: parsed.type,
    markdown: body,
    summary,
    status: 'active',
    version: 1,
  });
  if (!inserted.ok) {
    if (inserted.conflict) return fail('path_already_exists');
    return fail('create_failed');
  }

  await store.insertVersion(userId, {
    memory_document_id: inserted.row.id,
    version: 1,
    markdown: body,
    change_type: 'create',
    source_type: sourceType,
    meta: sanitizeMeta(meta),
  });
  return { ok: true, document: inserted.row };
}

/**
 * Patch an existing memory document (the preferred write mechanism — the
 * model proposes a small change, the server applies it).
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {object} args
 * @param {string} args.path
 * @param {object} args.patch          one memoryMarkdown patch op
 * @param {string} args.sourceType     provenance
 * @param {number} [args.expectedVersion] optimistic concurrency check
 * @param {object} [args.meta]
 */
export async function patchMemoryDocument(store, userId, { path, patch, sourceType, expectedVersion, meta } = {}) {
  if (!userId) return fail('user_required');
  const parsed = parseMemoryPath(path);
  if (!parsed.ok) return fail(parsed.error);

  const policy = evaluateMemoryWrite({ sourceType, operation: 'patch', documentType: parsed.type });
  if (!policy.allowed) return fail(policy.reason, policy.deferred ? { deferred: true } : {});

  const doc = await store.getDocument(userId, parsed.path);
  if (!doc) return fail('memory_not_found');
  if (Number.isFinite(expectedVersion) && Number(expectedVersion) !== doc.version) {
    return fail('version_conflict', { currentVersion: doc.version });
  }

  const applied = applyMemoryPatch(doc.markdown, patch);
  if (!applied.ok) return fail(applied.error);
  if (applied.markdown.length > MEMORY_MARKDOWN_MAX_CHARS) return fail('content_too_large');
  if (!applied.markdown.trim()) return fail('patch_would_empty_document');

  const summary = deriveMemorySummary(applied.markdown);
  const updated = await store.updateDocument(userId, doc.id, doc.version, {
    markdown: applied.markdown,
    summary,
  });
  if (!updated.ok) {
    // A concurrent writer landed between our read and our CAS.
    if (updated.staleVersion) return fail('version_conflict', { currentVersion: null });
    return fail('patch_failed');
  }

  await store.insertVersion(userId, {
    memory_document_id: doc.id,
    version: updated.row.version,
    markdown: applied.markdown,
    change_type: 'patch',
    source_type: sourceType,
    meta: sanitizeMeta({ ...(sanitizeMeta(meta) || {}), op: String(patch?.op || '') }),
  });
  return { ok: true, document: updated.row };
}

/**
 * Forget memory. Three shapes, increasing severity:
 *   • { patch }             — remove one fact/section (delegates to patch pipeline)
 *   • { mode: 'archive' }   — soft-delete the document (default product deletion)
 *   • { mode: 'hard_delete', confirmHardDelete: true } — irreversible erasure,
 *     for privacy/user-requested deletion only. Removes the document AND its
 *     entire version history (FK cascade).
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {object} args
 */
export async function forgetMemory(store, userId, { path, mode = 'archive', patch, sourceType, confirmHardDelete, meta } = {}) {
  if (!userId) return fail('user_required');

  if (patch) {
    return patchMemoryDocument(store, userId, { path, patch, sourceType, meta });
  }

  const parsed = parseMemoryPath(path);
  if (!parsed.ok) return fail(parsed.error);

  if (mode === 'hard_delete') {
    const policy = evaluateMemoryWrite({
      sourceType,
      operation: 'hard_delete',
      documentType: parsed.type,
      confirmHardDelete,
    });
    if (!policy.allowed) return fail(policy.reason);
    const doc = await store.getDocument(userId, parsed.path, { includeArchived: true });
    if (!doc) return fail('memory_not_found');
    const out = await store.hardDeleteDocument(userId, doc.id);
    if (!out.ok || !out.deleted) return fail('hard_delete_failed');
    return { ok: true, hardDeleted: true };
  }

  if (mode !== 'archive') return fail('unknown_forget_mode');

  const policy = evaluateMemoryWrite({ sourceType, operation: 'archive', documentType: parsed.type });
  if (!policy.allowed) return fail(policy.reason, policy.deferred ? { deferred: true } : {});

  const doc = await store.getDocument(userId, parsed.path);
  if (!doc) return fail('memory_not_found');
  const updated = await store.updateDocument(userId, doc.id, doc.version, {
    status: 'archived',
    archived_at: new Date().toISOString(),
  });
  if (!updated.ok) {
    if (updated.staleVersion) return fail('version_conflict');
    return fail('archive_failed');
  }
  await store.insertVersion(userId, {
    memory_document_id: doc.id,
    version: updated.row.version,
    markdown: updated.row.markdown,
    change_type: 'archive',
    source_type: sourceType,
    meta: sanitizeMeta(meta),
  });
  return { ok: true, archived: true, document: updated.row };
}
