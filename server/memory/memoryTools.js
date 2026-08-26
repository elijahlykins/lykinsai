// ============================================================================
// server/memory/memoryTools.js — the controlled memory tool surface
// ============================================================================
// The ONLY interface the model (and, in Phase 2, chat/agent runtimes) gets to
// memory: memory_list, memory_read, memory_patch, memory_create,
// memory_forget. No database access, no filesystem, no arbitrary paths —
// every call is scoped to the authenticated user and passes through path
// validation and write policy.
//
// Phase 1: exported functions + tool definitions, proven by tests, NOT yet
// registered in any chat tool loop or HTTP route. Phase 2 wires them in.

import { listMemoryRegistry } from './memoryRegistry.js';
import { readMemoryDocument } from './memoryReader.js';
import { createMemoryDocument, patchMemoryDocument, forgetMemory } from './memoryWriter.js';
import { MEMORY_PATCH_OPS } from './memoryMarkdown.js';
import { MEMORY_SOURCE_TYPES } from './memoryPolicy.js';

/**
 * @typedef {object} MemoryToolContext
 * @property {import('./memoryStore.js').MemoryStore} store user-agnostic store
 * @property {string} userId the AUTHENTICATED user — never model-supplied
 */

/**
 * memory_list — compact active-memory metadata. Never returns bodies.
 * @param {MemoryToolContext} ctx
 */
export async function memoryList(ctx) {
  if (!ctx?.userId) return { ok: false, error: 'user_required' };
  const memories = await listMemoryRegistry(ctx.store, ctx.userId);
  return { ok: true, memories };
}

/**
 * memory_read — full Markdown + metadata for one validated logical path.
 * @param {MemoryToolContext} ctx
 * @param {{ path: string, maxTokens?: number }} args
 */
export async function memoryRead(ctx, { path, maxTokens } = {}) {
  if (!ctx?.userId) return { ok: false, error: 'user_required' };
  return readMemoryDocument(ctx.store, ctx.userId, path, { maxTokens });
}

/**
 * memory_patch — the preferred write. The model proposes one small operation;
 * the server applies it (policy → load → version check → history → persist).
 * @param {MemoryToolContext} ctx
 * @param {{ path: string, patch: object, sourceType: string,
 *           expectedVersion?: number, meta?: object }} args
 */
export async function memoryPatch(ctx, { path, patch, sourceType, expectedVersion, meta } = {}) {
  if (!ctx?.userId) return { ok: false, error: 'user_required' };
  return patchMemoryDocument(ctx.store, ctx.userId, { path, patch, sourceType, expectedVersion, meta });
}

/**
 * memory_create — new memory document for a valid built-in path or a
 * projects/topics slug. Requires meaningful durable content.
 * @param {MemoryToolContext} ctx
 * @param {{ path: string, markdown: string, sourceType: string,
 *           name?: string, description?: string, meta?: object }} args
 */
export async function memoryCreate(ctx, { path, markdown, sourceType, name, description, meta } = {}) {
  if (!ctx?.userId) return { ok: false, error: 'user_required' };
  return createMemoryDocument(ctx.store, ctx.userId, { path, markdown, sourceType, name, description, meta });
}

/**
 * memory_forget — remove a fact/section (via patch), archive a memory
 * (default), or hard-delete on explicit user request.
 * @param {MemoryToolContext} ctx
 * @param {{ path: string, mode?: 'archive'|'hard_delete', patch?: object,
 *           sourceType: string, confirmHardDelete?: boolean, meta?: object }} args
 */
export async function memoryForget(ctx, { path, mode, patch, sourceType, confirmHardDelete, meta } = {}) {
  if (!ctx?.userId) return { ok: false, error: 'user_required' };
  return forgetMemory(ctx.store, ctx.userId, { path, mode, patch, sourceType, confirmHardDelete, meta });
}

/**
 * Declarative tool specs for the Phase 2 chat/agent wiring. Shapes mirror the
 * function contracts above; kept here so the tool loop and the implementation
 * cannot drift apart.
 */
export const MEMORY_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'memory_list',
    description: 'List the memories you have about this user: logical path, type, one-line description, and a compact summary. Cheap — call this before deciding whether a full read is needed.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'memory_read',
    description: 'Read one full memory document (Markdown) by logical path, e.g. "preferences.md" or "projects/lykn.md". Use only when the task clearly needs the details — summaries from memory_list are usually enough.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Logical memory path from memory_list.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_patch',
    description: 'Propose one small change to a memory document. Prefer replace_text to supersede an outdated statement instead of appending a contradiction. The server validates and applies the change.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: [...MEMORY_PATCH_OPS] },
            section: { type: 'string', description: 'Section heading text (for *_section ops).' },
            text: { type: 'string', description: 'New content (append_section / update_section).' },
            find: { type: 'string', description: 'Exact existing text, must match exactly once (replace_text / remove_text).' },
            replace: { type: 'string', description: 'Replacement text (replace_text).' },
          },
          required: ['op'],
          additionalProperties: false,
        },
        sourceType: { type: 'string', enum: [...MEMORY_SOURCE_TYPES] },
        expectedVersion: { type: 'number', description: 'Version you last saw — rejects lost updates.' },
      },
      required: ['path', 'patch', 'sourceType'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_create',
    description: 'Create a new memory document. Allowed paths: profile.md, preferences.md, goals.md, decisions.md, relationships.md, projects/<slug>.md, topics/<slug>.md. Only create when there is meaningful durable content — not for every passing subject.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        markdown: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        sourceType: { type: 'string', enum: [...MEMORY_SOURCE_TYPES] },
      },
      required: ['path', 'markdown', 'sourceType'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_forget',
    description: 'Forget memory: pass a patch (remove_text / remove_section) to drop one fact, or mode "archive" to soft-delete a whole document. Hard deletion requires the user explicitly asking for permanent erasure.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        mode: { type: 'string', enum: ['archive', 'hard_delete'] },
        patch: { type: 'object' },
        sourceType: { type: 'string', enum: [...MEMORY_SOURCE_TYPES] },
        confirmHardDelete: { type: 'boolean' },
      },
      required: ['path', 'sourceType'],
      additionalProperties: false,
    },
  },
]);
