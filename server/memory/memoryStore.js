// ============================================================================
// server/memory/memoryStore.js — data access for memory documents
// ============================================================================
// The only module that talks to the database. Everything above it (tools,
// writer, reader, registry, resolver) speaks this narrow store contract, so
// tests run against an in-memory implementation with identical semantics and
// no real Supabase/network is ever needed for core tests.
//
// OWNERSHIP IS ENFORCED HERE, UNCONDITIONALLY. The production client is the
// service-role Supabase client, which BYPASSES RLS — so every single query
// filters by user_id. RLS (migration 124) is defense in depth for
// user-token clients; this module is the working gate.
//
// Optimistic concurrency: updateDocument is compare-and-swap on `version`.
// A writer holding a stale version gets { staleVersion: true } instead of
// silently overwriting a concurrent write.
// Ownership queries go through userOwnedAccess so a caller cannot look up
// another user's document by id or path alone.

import {
  deleteUserRowById,
  requireUserId,
  userOwnedTable,
} from '../../lib/security/userOwnedAccess.js';

/**
 * @typedef {object} MemoryDocumentRow
 * @property {string} id
 * @property {string} user_id
 * @property {string} path
 * @property {string} name
 * @property {string|null} description
 * @property {string} type
 * @property {string} markdown
 * @property {string|null} summary
 * @property {string} status
 * @property {number} version
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string|null} archived_at
 */

/**
 * @typedef {object} MemoryStore
 * @property {(userId: string, path: string, opts?: { includeArchived?: boolean }) => Promise<MemoryDocumentRow|null>} getDocument
 * @property {(userId: string) => Promise<Array<Omit<MemoryDocumentRow, 'markdown'>>>} listActiveDocuments
 * @property {(userId: string, doc: object) => Promise<{ ok: true, row: MemoryDocumentRow } | { ok: false, conflict?: boolean, error?: string }>} insertDocument
 * @property {(userId: string, id: string, expectedVersion: number, fields: object) => Promise<{ ok: true, row: MemoryDocumentRow } | { ok: false, staleVersion?: boolean, error?: string }>} updateDocument
 * @property {(userId: string, versionRow: object) => Promise<{ ok: boolean, error?: string }>} insertVersion
 * @property {(userId: string, documentId: string, opts?: { limit?: number, includeMarkdown?: boolean }) => Promise<Array<object>>} listVersions
 * @property {(userId: string, id: string) => Promise<{ ok: boolean, deleted: boolean, error?: string }>} hardDeleteDocument
 */

const DOCUMENT_COLUMNS =
  'id, user_id, path, name, description, type, markdown, summary, status, version, created_at, updated_at, archived_at';
const REGISTRY_COLUMNS =
  'id, user_id, path, name, description, type, summary, status, version, created_at, updated_at, archived_at';
const VERSION_COLUMNS = 'id, memory_document_id, user_id, version, change_type, source_type, meta, created_at';

const PG_UNIQUE_VIOLATION = '23505';

/**
 * Supabase-backed MemoryStore.
 * @param {import('@supabase/supabase-js').SupabaseClient} client — usually the
 *   service-role admin client; ownership filters below are the actual gate.
 * @returns {MemoryStore}
 */
export function createSupabaseMemoryStore(client) {
  if (!client) throw new Error('createSupabaseMemoryStore: supabase client required');

  return {
    async getDocument(userId, path, { includeArchived = false } = {}) {
      requireUserId(userId);
      let q = userOwnedTable(client, 'lykn_memory_documents', userId)
        .select(DOCUMENT_COLUMNS)
        .eq('path', path);
      if (!includeArchived) q = q.eq('status', 'active');
      const { data, error } = await q.maybeSingle();
      if (error) throw new Error(`memory getDocument failed: ${error.message}`);
      return data || null;
    },

    async listActiveDocuments(userId) {
      const { data, error } = await userOwnedTable(client, 'lykn_memory_documents', userId)
        .select(REGISTRY_COLUMNS)
        .eq('status', 'active')
        .order('updated_at', { ascending: false });
      if (error) throw new Error(`memory listActiveDocuments failed: ${error.message}`);
      return data || [];
    },

    async insertDocument(userId, doc) {
      const { data, error } = await userOwnedTable(client, 'lykn_memory_documents', userId)
        .insert(doc)
        .select(DOCUMENT_COLUMNS)
        .single();
      if (error) {
        if (error.code === PG_UNIQUE_VIOLATION) return { ok: false, conflict: true };
        return { ok: false, error: error.message };
      }
      return { ok: true, row: data };
    },

    async updateDocument(userId, id, expectedVersion, fields) {
      // Compare-and-swap: the version predicate makes a stale write match
      // zero rows instead of clobbering a newer document. user_id is required
      // by userOwnedTable so a foreign id cannot be updated.
      const { data, error } = await userOwnedTable(client, 'lykn_memory_documents', userId)
        .update({ ...fields, version: expectedVersion + 1, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('version', expectedVersion)
        .select(DOCUMENT_COLUMNS);
      if (error) return { ok: false, error: error.message };
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return { ok: false, staleVersion: true };
      return { ok: true, row };
    },

    async insertVersion(userId, versionRow) {
      const { error } = await userOwnedTable(client, 'lykn_memory_document_versions', userId)
        .insert(versionRow);
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    },

    async listVersions(userId, documentId, { limit = 20, includeMarkdown = false } = {}) {
      const cols = includeMarkdown ? `${VERSION_COLUMNS}, markdown` : VERSION_COLUMNS;
      const { data, error } = await userOwnedTable(client, 'lykn_memory_document_versions', userId)
        .select(cols)
        .eq('memory_document_id', documentId)
        .order('version', { ascending: false })
        .limit(Math.max(1, Math.min(100, limit)));
      if (error) throw new Error(`memory listVersions failed: ${error.message}`);
      return data || [];
    },

    async hardDeleteDocument(userId, id) {
      // Versions cascade via FK (migration 124).
      const result = await deleteUserRowById(client, 'lykn_memory_documents', userId, id);
      if (result.error) return { ok: false, deleted: false, error: result.error.message };
      return { ok: true, deleted: result.deleted };
    },
  };
}
