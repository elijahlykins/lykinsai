// ============================================================================
// server/memory/memoryPolicy.js — who may write durable memory, and when
// ============================================================================
// The trust core of the new memory system. Every mutation passes through
// evaluateMemoryWrite before anything touches the store. The invariants:
//
//   EXPLICIT USER   — user directly stated durable info ("remember…",
//                     "I prefer…", "we decided…"). High trust; may write.
//   USER CONFIRMED  — an inference the user has explicitly confirmed. May write.
//   SYSTEM EVENT    — LYKN itself verified a state change (e.g. a refactor
//                     completed). May update project/topic current-state
//                     memory only — it must not rewrite who the user IS.
//   INFERRED        — model pattern-noticing. V1 is conservative: never
//                     persisted automatically; callers should surface it for
//                     confirmation instead (then it becomes user_confirmed).
//   MIGRATION       — Phase 2 import from the legacy Synthesis/User-Model
//                     stack. Server-initiated only.
//   EXTERNAL        — webpages, email, files, PDFs, connectors, search
//                     results. NEVER a durable-memory author. This is a
//                     security invariant, not a tuning knob: external content
//                     may inform a task, but it cannot silently become
//                     trusted user memory (memory poisoning).

/** Source types that may appear in version history (provenance). */
export const MEMORY_SOURCE_TYPES = Object.freeze([
  'explicit_user',
  'system_event',
  'user_confirmed',
  'inferred',
  'migration',
]);

/** Mutating operations the policy arbitrates. */
export const MEMORY_WRITE_OPERATIONS = Object.freeze([
  'create',
  'patch',
  'archive',
  'hard_delete',
  'compact',
]);

/** Document types a system_event is allowed to touch (current-state memory). */
const SYSTEM_EVENT_WRITABLE_TYPES = new Set(['project', 'topic', 'decisions']);

/**
 * Decide whether a proposed memory write is allowed.
 *
 * @param {object} proposal
 * @param {string} proposal.sourceType   claimed provenance of the write
 * @param {string} proposal.operation    one of MEMORY_WRITE_OPERATIONS
 * @param {string} [proposal.documentType] memory type being touched
 * @param {boolean} [proposal.confirmHardDelete] explicit user confirmation for
 *   irreversible deletion — hard deletes must never happen casually.
 * @returns {{ allowed: boolean, reason: string, deferred?: boolean }}
 *   `deferred` marks writes that are not hostile but must wait for user
 *   confirmation (inferred memory) — callers can turn them into a
 *   confirmation prompt instead of an error.
 */
export function evaluateMemoryWrite({ sourceType, operation, documentType, confirmHardDelete } = {}) {
  if (!MEMORY_WRITE_OPERATIONS.includes(operation)) {
    return { allowed: false, reason: 'unknown_operation' };
  }
  // Anything not in the closed provenance list is treated as external/hostile.
  // There is deliberately no "external" source type to grant — unknown IS denied.
  if (!MEMORY_SOURCE_TYPES.includes(sourceType)) {
    return { allowed: false, reason: 'external_content_forbidden' };
  }

  if (sourceType === 'inferred') {
    return { allowed: false, deferred: true, reason: 'inferred_requires_user_confirmation' };
  }

  if (sourceType === 'system_event') {
    if (operation === 'hard_delete' || operation === 'archive') {
      return { allowed: false, reason: 'system_event_cannot_delete' };
    }
    if (operation === 'compact') {
      // Maintenance compaction is system-initiated by design, any type.
      return { allowed: true, reason: 'ok' };
    }
    if (!SYSTEM_EVENT_WRITABLE_TYPES.has(String(documentType))) {
      return { allowed: false, reason: 'system_event_type_not_writable' };
    }
    return { allowed: true, reason: 'ok' };
  }

  if (operation === 'hard_delete') {
    // Irreversible erasure: only the user, saying so explicitly, twice.
    if (sourceType !== 'explicit_user' || confirmHardDelete !== true) {
      return { allowed: false, reason: 'hard_delete_requires_explicit_user_confirmation' };
    }
    return { allowed: true, reason: 'ok' };
  }

  // explicit_user, user_confirmed, migration: full write access.
  return { allowed: true, reason: 'ok' };
}
