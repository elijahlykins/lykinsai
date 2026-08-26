// ============================================================================
// server/memory/memoryChat.js — production Chat seam over MemoryResolver
// ============================================================================
// The only module server.js should call for personal-memory prompt context.
// Resolution stays in memoryResolver.js; this file decides Chat policy:
//
//   L0 — always (when the turn is allowed to have personal memory)
//   L1 — first turn of a thread, or after a mutation / user-recall
//   L2 — default ZERO; deepen-recall may select profile + preferences
//
// Thread cache: knownVersions + registryShown, keyed by userId + chatId.
// Successful writes must call invalidateMemoryThreadPath so the next turn
// cannot keep a stale full document or a stale registry summary.

import { createSupabaseMemoryStore } from './memoryStore.js';
import { resolveMemoryContext, measureMemoryFootprint } from './memoryResolver.js';
import { estimateMemoryTokens } from './memoryConfig.js';

/** @type {import('./memoryStore.js').MemoryStore | null} */
let _store = null;

/**
 * Process-lifetime store bound to the service-role client.
 * @param {import('@supabase/supabase-js').SupabaseClient | null} supabaseAdmin
 */
export function getMemoryStore(supabaseAdmin) {
  if (!supabaseAdmin) return null;
  if (_store) return _store;
  _store = createSupabaseMemoryStore(supabaseAdmin);
  return _store;
}

/** Test-only: swap/clear the singleton (never used in production). */
export function _setMemoryStoreForTests(store) {
  _store = store;
}

/**
 * @param {string} userId
 * @param {string} [chatId]
 */
export function memoryThreadKey(userId, chatId) {
  return `${userId}:${String(chatId || '').trim() || 'default'}`;
}

/** @type {Map<string, { knownVersions: Record<string, number>, registryShown: boolean, registryFingerprint: string }>} */
const threadState = new Map();

function emptyThreadState() {
  return { knownVersions: {}, registryShown: false, registryFingerprint: '' };
}

export function getMemoryThreadState(userId, chatId) {
  const key = memoryThreadKey(userId, chatId);
  const existing = threadState.get(key);
  if (existing) return existing;
  const fresh = emptyThreadState();
  threadState.set(key, fresh);
  return fresh;
}

export function registryFingerprint(entries) {
  return (entries || []).map((e) => `${e.path}:${e.version}`).join('|');
}

/**
 * After a mutation, drop cached versions for that path across the user's
 * threads and force the next turn to re-show the registry (summaries change).
 * @param {string} userId
 * @param {string} [path]
 */
export function invalidateMemoryThreadPath(userId, path) {
  if (!userId) return;
  const prefix = `${userId}:`;
  for (const [key, state] of threadState) {
    if (!key.startsWith(prefix)) continue;
    if (path) delete state.knownVersions[path];
    else state.knownVersions = {};
    state.registryShown = false;
    state.registryFingerprint = '';
  }
}

export function resetMemoryThreadCache() {
  threadState.clear();
}

/**
 * Format resolver output for the Chat prompt. Never includes unchanged
 * L2 bodies (the thread already has them).
 * @param {Awaited<ReturnType<typeof resolveMemoryContext>>} resolved
 */
export function formatChatMemoryPrompt(resolved) {
  if (!resolved) return '';
  const parts = [];
  if (resolved.l0?.text) parts.push(resolved.l0.text);
  if (resolved.registry?.text) parts.push(resolved.registry.text);
  for (const doc of resolved.documents || []) {
    if (doc.unchanged || doc.error || !doc.markdown) continue;
    parts.push(`[USER MEMORY — ${doc.path} v${doc.version}]\n${doc.markdown}`);
  }
  return parts.join('\n\n');
}

/**
 * Resolve one Chat turn. Authority is MemoryResolver; this only picks
 * includeRegistry / selectPaths / knownVersions.
 *
 * @param {import('./memoryStore.js').MemoryStore} store
 * @param {string} userId
 * @param {{ chatId?: string, recall?: boolean, deepen?: boolean }} [opts]
 */
export async function resolveChatMemoryTurn(store, userId, { chatId = '', recall = false, deepen = false } = {}) {
  if (!store || !userId) {
    return {
      text: '',
      resolved: null,
      metrics: { l0Tokens: 0, registryTokens: 0, documentCount: 0, deepDocuments: 0, totalTokens: 0, includeRegistry: false },
    };
  }

  const state = getMemoryThreadState(userId, chatId);
  const includeRegistry = recall || !state.registryShown;
  const selectPaths = deepen ? ['profile.md', 'preferences.md'] : [];

  const resolved = await resolveMemoryContext(store, userId, {
    includeRegistry,
    selectPaths,
    knownVersions: state.knownVersions,
  });

  const fp = registryFingerprint(resolved.registry.entries);
  if (includeRegistry) {
    state.registryShown = true;
    state.registryFingerprint = fp;
  } else if (fp && fp !== state.registryFingerprint) {
    // A document changed out of band — show the new index next turn.
    state.registryShown = false;
    state.registryFingerprint = fp;
  }

  for (const doc of resolved.documents) {
    if (!doc.error && doc.version) state.knownVersions[doc.path] = doc.version;
  }

  const text = formatChatMemoryPrompt(resolved);
  const deepDocuments = resolved.documents.filter((d) => d.markdown && !d.unchanged).length;
  return {
    text,
    resolved,
    metrics: {
      l0Tokens: resolved.l0.tokens,
      registryTokens: resolved.registry.tokens,
      documentCount: resolved.registry.entries.length,
      deepDocuments,
      totalTokens: estimateMemoryTokens(text),
      includeRegistry,
    },
  };
}

export { measureMemoryFootprint };
