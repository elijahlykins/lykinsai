/**
 * The contract the vault UI talks to, instead of talking to Supabase.
 *
 * Both backends hand back rows in the *Supabase* shape (`VaultItem`), even the
 * local one whose columns are named differently underneath. That is the whole
 * point: `Vault.jsx` is 9,000 lines that already understand `storage_path`,
 * `attachment_preview` and an `[ATTACHMENTS_JSON:…]` marker inside `content`.
 * Translating at the boundary means the UI does not have to learn a second
 * vocabulary, and the two backends stay swappable at runtime.
 *
 * Media is the one place the shapes genuinely differ, and it is handled
 * explicitly rather than pretended away: a local row reports
 * `storage_bucket: "local"`, and mediaUrl.ts turns that into a `lykn-blob://`
 * URL instead of signing anything. See resolveVaultMediaUrl().
 */

import type { VaultItem } from "@/lib/types/vault";

export type VaultBackend = "local" | "supabase";

/**
 * Keyset cursor, matching the grid's existing pagination: `created_at` DESC
 * with `id` DESC as the tie-break. Offsets are not an option — rows arrive
 * while the user scrolls, and an offset would skip or repeat cards.
 */
export interface VaultCursor {
  createdAt: string;
  id: string | null;
}

export interface VaultPage {
  rows: VaultItem[];
  /** Null when there is nothing after this page. */
  nextCursor: VaultCursor | null;
}

export interface VaultTagCount {
  tag: string;
  count: number;
}

export interface VaultSearchHit {
  id: string;
  score: number;
  snippet?: string | null;
}

export interface VaultRepository {
  readonly backend: VaultBackend;

  /** One page of the grid, newest first. */
  listPage(options: { cursor?: VaultCursor | null; limit?: number }): Promise<VaultPage>;

  getById(id: string): Promise<VaultItem | null>;
  getByIds(ids: string[]): Promise<VaultItem[]>;

  create(input: Partial<VaultItem>): Promise<VaultItem>;

  /**
   * `ifUpdatedAt` is a compare-and-set. Background enrichment reads a row,
   * spends seconds or minutes deriving something, then writes it back; without
   * the guard it would silently overwrite an edit the user made in between.
   * Resolves to null when the row has moved on.
   */
  update(
    id: string,
    patch: Partial<VaultItem>,
    options?: { ifUpdatedAt?: string | null },
  ): Promise<VaultItem | null>;

  /** Removes the row, its files, and anything derived from it. */
  remove(id: string): Promise<void>;

  count(): Promise<number>;
  tagCounts(): Promise<VaultTagCount[]>;

  /**
   * Retrieval. The local backend answers from on-device embeddings plus FTS5;
   * the Supabase backend has no equivalent and returns null so callers can
   * fall back to the existing client-side keyword pass.
   */
  search(query: string, options?: { limit?: number }): Promise<VaultSearchHit[] | null>;
}

/** Bucket sentinel marking a row whose bytes live on this device. */
export const LOCAL_BUCKET = "local";
