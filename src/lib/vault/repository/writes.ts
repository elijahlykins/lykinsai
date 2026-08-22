/**
 * Write helpers shaped like the Supabase calls they replace.
 *
 * `Vault.jsx` has fifteen-odd write sites, each following the same pattern:
 * build a patch, `await` it, destructure `{ error }`, and branch on specific
 * failure modes — a missing `comments` column, a vault cap trigger, a lost
 * update. Rewriting each into `try/catch` around a throwing repository would
 * have meant touching all that error handling too, in a nine-thousand-line
 * file, for no behavioural gain.
 *
 * So these return `{ data, error }` instead of throwing. The call sites lose
 * exactly one line each — the `.from("vault_items")` chain becomes a function
 * call — and every downstream branch keeps working against either backend.
 */

import type { VaultItem } from "@/lib/types/vault";
import { getVaultRepository } from "./index";

export interface WriteResult<T> {
  data: T | null;
  error: (Error & { code?: string }) | null;
}

function fail<T>(err: unknown): WriteResult<T> {
  const error = err instanceof Error ? err : new Error(String(err ?? "vault write failed"));
  return { data: null, error };
}

/**
 * The error a compare-and-set produces when the row moved on underneath.
 * Given a code so call sites can recognise it the way they already recognise
 * PostgREST's.
 */
export const STALE_WRITE_CODE = "LYKN_STALE_WRITE";

function staleError<T>(): WriteResult<T> {
  const error = Object.assign(new Error("row changed since it was read"), {
    code: STALE_WRITE_CODE,
  });
  return { data: null, error };
}

export function createVaultWrites(userId: string | null | undefined) {
  const repo = () => getVaultRepository(userId);

  return {
    get backend() {
      return repo().backend;
    },

    async insert(row: Partial<VaultItem>): Promise<WriteResult<VaultItem>> {
      try {
        return { data: await repo().create(row), error: null };
      } catch (err) {
        return fail(err);
      }
    },

    async update(id: string, patch: Partial<VaultItem>): Promise<WriteResult<VaultItem>> {
      try {
        return { data: await repo().update(id, patch), error: null };
      } catch (err) {
        return fail(err);
      }
    },

    /**
     * Update only if the row still carries the `updated_at` we read. Used by
     * the background enrichment passes, which must never trample a user edit
     * made while they were thinking.
     */
    async updateIfUnchanged(
      id: string,
      patch: Partial<VaultItem>,
      updatedAt: string | null | undefined,
    ): Promise<WriteResult<VaultItem>> {
      try {
        const data = await repo().update(id, patch, { ifUpdatedAt: updatedAt ?? null });
        if (!data && updatedAt) return staleError();
        return { data, error: null };
      } catch (err) {
        return fail(err);
      }
    },

    async remove(id: string): Promise<WriteResult<null>> {
      try {
        await repo().remove(id);
        return { data: null, error: null };
      } catch (err) {
        return fail(err);
      }
    },

    /** Read one row's current content and timestamp, for the guarded writes. */
    async readForUpdate(
      id: string,
    ): Promise<WriteResult<Pick<VaultItem, "content" | "updated_at">>> {
      try {
        const row = await repo().getById(id);
        return {
          data: row ? { content: row.content, updated_at: row.updated_at } : null,
          error: null,
        };
      } catch (err) {
        return fail(err);
      }
    },
  };
}

export type VaultWrites = ReturnType<typeof createVaultWrites>;
