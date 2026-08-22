/**
 * The local backend: SQLite in the Electron main process, reached over IPC.
 *
 * Everything here is translation. The store's columns diverged from Supabase's
 * for good reasons (`blob_path` names a file on disk, not an object in a
 * bucket) but the UI should not have to care, so rows are converted back into
 * the Supabase shape on the way out and forward on the way in.
 *
 * The bridge always resolves to `{ ok, data }` rather than rejecting, because a
 * rejected IPC promise loses its stack and surfaces as "Error invoking remote
 * method". `unwrap()` turns that back into a real throw with the real message.
 */

import type { VaultItem } from "@/lib/types/vault";
import {
  LOCAL_BUCKET,
  type VaultCursor,
  type VaultPage,
  type VaultRepository,
  type VaultSearchHit,
  type VaultTagCount,
} from "./types";

/** Shape of a row as the local store stores it. */
interface LocalRow {
  id: string;
  kind?: string | null;
  title?: string | null;
  content?: string | null;
  why?: string | null;
  tags?: unknown;
  source?: string | null;
  folder?: string | null;
  att_type?: string | null;
  platform?: string | null;
  url?: string | null;
  blob_path?: string | null;
  variant_med?: string | null;
  variant_thumb?: string | null;
  mime_type?: string | null;
  byte_size?: number | null;
  duration_seconds?: number | null;
  page_count?: number | null;
  host_name?: string | null;
  media_width?: number | null;
  media_height?: number | null;
  preview?: unknown;
  comments?: unknown;
  ai_summary?: string | null;
  ai_signals?: unknown;
  origin?: string | null;
  created_at: string;
  updated_at?: string | null;
  deleted_at?: string | null;
}

type Bridge = {
  listItems: (args: Record<string, unknown>) => Promise<any>;
  getItem: (id: string) => Promise<any>;
  getItems: (ids: string[]) => Promise<any>;
  saveItem: (item: Record<string, unknown>) => Promise<any>;
  updateItem: (
    id: string,
    patch: Record<string, unknown>,
    opts?: { ifUpdatedAt?: string | null },
  ) => Promise<any>;
  deleteItem: (id: string) => Promise<any>;
  countItems: (args?: Record<string, unknown>) => Promise<any>;
  tagCounts: () => Promise<any>;
  search: (query: string, args?: Record<string, unknown>) => Promise<any>;
};

function bridge(): Bridge {
  const store = (globalThis as any)?.window?.lykn?.store;
  if (!store) throw new Error("local store bridge is unavailable");
  return store as Bridge;
}

/** Turn the bridge's `{ ok, data }` envelope into a value or a real error. */
function unwrap<T>(response: any, fallback: T): T {
  if (!response) return fallback;
  if (response.ok === false) throw new Error(response.error || "local store call failed");
  return (response.data ?? fallback) as T;
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Local row → the Supabase shape the UI reads.
 *
 * `storage_bucket` is set to the local sentinel so the media layer knows not to
 * try signing these paths. Everything downstream of `parseStorageTarget` keeps
 * working unchanged.
 */
export function toVaultItem(row: LocalRow): VaultItem {
  return {
    id: String(row.id),
    // The local store is single-user by construction; the column exists in the
    // cloud only to scope rows, and nothing in the UI reads it for display.
    user_id: "",
    title: row.title ?? null,
    content: row.content ?? null,
    why: row.why ?? null,
    tags: asArray(row.tags) as string[],
    source: row.source ?? null,
    folder: row.folder ?? null,
    att_type: (row.att_type ?? null) as VaultItem["att_type"],
    platform: (row.platform ?? null) as VaultItem["platform"],
    url: row.url ?? null,
    storage_path: row.blob_path ?? null,
    storage_bucket: row.blob_path ? LOCAL_BUCKET : null,
    variant_medium_path: row.variant_med ?? null,
    variant_thumb_path: row.variant_thumb ?? null,
    mime_type: row.mime_type ?? null,
    byte_size: row.byte_size ?? null,
    duration_seconds: row.duration_seconds ?? null,
    page_count: row.page_count ?? null,
    host_name: row.host_name ?? null,
    media_width: row.media_width ?? null,
    media_height: row.media_height ?? null,
    attachment_preview: asObject(row.preview),
    comments: asArray(row.comments) as VaultItem["comments"],
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
  };
}

/**
 * The Supabase shape → a local row. Only keys actually present are emitted, so
 * this doubles as the patch builder for partial updates: sending `undefined`
 * for an untouched column would blank it.
 */
export function toLocalRow(input: Partial<VaultItem>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined) out[key] = value;
  };

  put("id", input.id);
  put("title", input.title);
  put("content", input.content);
  put("why", input.why);
  put("tags", input.tags);
  put("source", input.source);
  put("folder", input.folder);
  put("att_type", input.att_type);
  put("platform", input.platform);
  put("url", input.url);
  put("blob_path", input.storage_path);
  put("variant_med", input.variant_medium_path);
  put("variant_thumb", input.variant_thumb_path);
  put("mime_type", input.mime_type);
  put("byte_size", input.byte_size);
  put("duration_seconds", input.duration_seconds);
  put("page_count", input.page_count);
  put("host_name", input.host_name);
  put("media_width", input.media_width);
  put("media_height", input.media_height);
  put("preview", input.attachment_preview);
  put("comments", input.comments);
  put("created_at", input.created_at);
  put("updated_at", input.updated_at);

  // `kind` distinguishes vault rows from chat artifacts in the same table.
  if (input.id === undefined || out.title !== undefined || out.content !== undefined) {
    out.kind = "vault";
  }

  return out;
}

export function createLocalVaultRepository(): VaultRepository {
  return {
    backend: "local",

    async listPage({ cursor = null, limit = 100 }): Promise<VaultPage> {
      const rows = unwrap<LocalRow[]>(
        await bridge().listItems({
          kind: "vault",
          limit,
          after: cursor?.createdAt ? { created_at: cursor.createdAt, id: cursor.id } : undefined,
        }),
        [],
      );

      const items = rows.map(toVaultItem);
      const last = items[items.length - 1];
      return {
        rows: items,
        nextCursor:
          items.length < limit || !last?.created_at
            ? null
            : { createdAt: last.created_at, id: last.id ?? null },
      };
    },

    async getById(id) {
      const row = unwrap<LocalRow | null>(await bridge().getItem(id), null);
      return row ? toVaultItem(row) : null;
    },

    async getByIds(ids) {
      const rows = unwrap<LocalRow[]>(await bridge().getItems(ids), []);
      return rows.map(toVaultItem);
    },

    async create(input) {
      // saveItem writes the row and then indexes it, so a new note is
      // searchable without waiting for the next backfill pass.
      const row = unwrap<LocalRow>(await bridge().saveItem(toLocalRow(input)), null as any);
      return toVaultItem(row);
    },

    async update(id, patch, options = {}) {
      const row = unwrap<LocalRow | null>(
        await bridge().updateItem(id, toLocalRow(patch), {
          ifUpdatedAt: options?.ifUpdatedAt ?? null,
        }),
        null,
      );
      return row ? toVaultItem(row) : null;
    },

    async remove(id) {
      unwrap(await bridge().deleteItem(id), null);
    },

    async count() {
      return unwrap<number>(await bridge().countItems({ kind: "vault" }), 0);
    },

    async tagCounts(): Promise<VaultTagCount[]> {
      return unwrap<VaultTagCount[]>(await bridge().tagCounts(), []);
    },

    async search(query, { limit = 50 } = {}): Promise<VaultSearchHit[]> {
      const results = unwrap<any[]>(await bridge().search(query, { limit }), []);
      return (results || [])
        .filter((hit) => hit?.source_kind === "item" || hit?.sourceKind === "item" || hit?.id)
        .map((hit) => ({
          id: String(hit.source_id ?? hit.sourceId ?? hit.id),
          score: Number(hit.score ?? hit.rank ?? 0),
          snippet: hit.snippet ?? hit.text ?? null,
        }));
    },
  };
}
