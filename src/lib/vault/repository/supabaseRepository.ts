/**
 * The Supabase backend — today's behaviour, moved behind the interface.
 *
 * This is deliberately a faithful extraction rather than an improvement. The
 * queries, the keyset pagination and the progressive column fallback are the
 * ones `Vault.jsx` has been running; keeping them byte-for-byte identical is
 * what makes introducing the repository a no-op refactor that can ship before
 * anything switches to local.
 *
 * The column fallback deserves its comment: PostgREST fails the whole query on
 * an unknown column, and older databases lack `comments` / `why`, so the first
 * successful column set is remembered and reused.
 */

import { supabase } from "@/lib/supabase";
import type { VaultItem } from "@/lib/types/vault";
import type {
  VaultCursor,
  VaultPage,
  VaultRepository,
  VaultSearchHit,
  VaultTagCount,
} from "./types";

const TABLE = "vault_items";

const COLUMN_SETS = [
  // `source` and `folder` are what the listing groups by: the connector an item
  // was synced from, and the folder it was filed under ("Generated" for
  // everything the AI made). Older databases predate both columns, which is
  // what the fallback below is for — a missing column fails the whole query.
  "id, title, content, tags, source, folder, created_at, updated_at, comments, why",
  "id, title, content, tags, source, created_at, updated_at, comments, why",
  "id, title, content, tags, created_at, updated_at, comments, why",
  "id, title, content, tags, created_at, updated_at, comments",
  "id, title, content, tags, created_at, updated_at",
  "id, title, content, created_at, updated_at",
];

export function createSupabaseVaultRepository(userId: string): VaultRepository {
  let resolvedColumns: string | null = null;

  const buildQuery = (columns: string, cursor: VaultCursor | null, limit: number) => {
    let query = supabase
      .from(TABLE)
      .select(columns)
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit);

    if (cursor?.createdAt) {
      if (cursor.id) {
        // A plain `.lt("created_at", …)` would drop every row sharing the
        // boundary timestamp with the previous page's last row.
        query = query.or(
          `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
        );
      } else {
        query = query.lt("created_at", cursor.createdAt);
      }
    }
    return query;
  };

  return {
    backend: "supabase",

    async listPage({ cursor = null, limit = 100 }): Promise<VaultPage> {
      let rows: VaultItem[] = [];

      if (resolvedColumns) {
        const { data, error } = await buildQuery(resolvedColumns, cursor, limit);
        if (error) throw error;
        rows = (data as unknown as VaultItem[]) || [];
      } else {
        let lastError: unknown = null;
        for (const columns of COLUMN_SETS) {
          const { data, error } = await buildQuery(columns, cursor, limit);
          if (!error) {
            resolvedColumns = columns;
            rows = (data as unknown as VaultItem[]) || [];
            lastError = null;
            break;
          }
          lastError = error;
        }
        if (lastError) throw lastError;
      }

      const last = rows[rows.length - 1];
      return {
        rows,
        nextCursor:
          rows.length < limit || !last?.created_at
            ? null
            : { createdAt: last.created_at, id: last.id ?? null },
      };
    },

    async getById(id) {
      const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return (data as VaultItem) || null;
    },

    async getByIds(ids) {
      if (!ids?.length) return [];
      const { data, error } = await supabase.from(TABLE).select("*").in("id", ids);
      if (error) throw error;
      return (data as VaultItem[]) || [];
    },

    async create(input) {
      const { data, error } = await supabase
        .from(TABLE)
        .insert({ ...input, user_id: userId })
        .select()
        .single();
      if (error) throw error;
      return data as VaultItem;
    },

    async update(id, patch, options = {}) {
      let query = supabase.from(TABLE).update(patch).eq("id", id).eq("user_id", userId);
      if (options?.ifUpdatedAt) query = query.eq("updated_at", options.ifUpdatedAt);

      const { data, error } = await query.select().maybeSingle();
      if (error) throw error;
      return (data as VaultItem) || null;
    },

    async remove(id) {
      const { error } = await supabase.from(TABLE).delete().eq("id", id).eq("user_id", userId);
      if (error) throw error;
    },

    async count() {
      const { count, error } = await supabase
        .from(TABLE)
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (error) throw error;
      return count || 0;
    },

    async tagCounts(): Promise<VaultTagCount[]> {
      const { data, error } = await supabase.rpc("vault_tag_counts");
      if (error) throw error;
      return ((data as any[]) || []).map((row) => ({
        tag: String(row.tag ?? row.name ?? ""),
        count: Number(row.count ?? row.n ?? 0),
      }));
    },

    /**
     * Null, not an empty list: there is no on-device index in the cloud
     * backend, and an empty result would read as "nothing matched" rather than
     * "ask somewhere else". Callers fall back to the existing keyword pass.
     */
    async search(): Promise<VaultSearchHit[] | null> {
      return null;
    },
  };
}
