// ============================================================================
// tests/memory/inMemoryMemoryStore.mjs — test double for the MemoryStore contract
// ============================================================================
// Implements the exact semantics of server/memory/memoryStore.js
// (createSupabaseMemoryStore) with a Map: user_id filtering on every call,
// unique (user_id, path) conflict on insert, and compare-and-swap on version.
// No Supabase, no network — core memory tests run fully offline.

import { randomUUID } from 'node:crypto';

export function createInMemoryMemoryStore() {
  /** @type {Map<string, any>} id → document row */
  const documents = new Map();
  /** @type {Array<any>} version rows, insertion order */
  const versions = [];

  const nowIso = () => new Date().toISOString();
  const clone = (row) => (row ? JSON.parse(JSON.stringify(row)) : row);

  return {
    // Test helpers (not part of the MemoryStore contract)
    _documents: documents,
    _versions: versions,

    async getDocument(userId, path, { includeArchived = false } = {}) {
      for (const row of documents.values()) {
        if (row.user_id !== userId || row.path !== path) continue;
        if (!includeArchived && row.status !== 'active') continue;
        return clone(row);
      }
      return null;
    },

    async listActiveDocuments(userId) {
      const rows = [...documents.values()]
        .filter((r) => r.user_id === userId && r.status === 'active')
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .map((r) => {
          const { markdown: _markdown, ...rest } = r;
          return clone(rest);
        });
      return rows;
    },

    async insertDocument(userId, doc) {
      for (const row of documents.values()) {
        if (row.user_id === userId && row.path === doc.path) {
          return { ok: false, conflict: true };
        }
      }
      const row = {
        id: randomUUID(),
        user_id: userId,
        description: null,
        summary: null,
        status: 'active',
        version: 1,
        archived_at: null,
        ...doc,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      documents.set(row.id, row);
      return { ok: true, row: clone(row) };
    },

    async updateDocument(userId, id, expectedVersion, fields) {
      const row = documents.get(id);
      if (!row || row.user_id !== userId || row.version !== expectedVersion) {
        return { ok: false, staleVersion: true };
      }
      Object.assign(row, fields, {
        version: expectedVersion + 1,
        updated_at: nowIso(),
      });
      return { ok: true, row: clone(row) };
    },

    async insertVersion(userId, versionRow) {
      versions.push({ id: randomUUID(), user_id: userId, created_at: nowIso(), ...clone(versionRow) });
      return { ok: true };
    },

    async listVersions(userId, documentId, { limit = 20, includeMarkdown = false } = {}) {
      return versions
        .filter((v) => v.user_id === userId && v.memory_document_id === documentId)
        .sort((a, b) => b.version - a.version)
        .slice(0, limit)
        .map((v) => {
          if (includeMarkdown) return clone(v);
          const { markdown: _markdown, ...rest } = v;
          return clone(rest);
        });
    },

    async hardDeleteDocument(userId, id) {
      const row = documents.get(id);
      if (!row || row.user_id !== userId) return { ok: true, deleted: false };
      documents.delete(id);
      // FK cascade emulation: version history dies with the document.
      for (let i = versions.length - 1; i >= 0; i -= 1) {
        if (versions[i].memory_document_id === id) versions.splice(i, 1);
      }
      return { ok: true, deleted: true };
    },
  };
}
