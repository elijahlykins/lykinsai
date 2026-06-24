/**
 * Per-item cancellation registry for the vault upload pipeline.
 *
 * Lives in its own module (no React, no store, no Supabase) so both
 * `uploadPipeline.ts` and `vaultUploadStore.ts` can import it without
 * creating a circular dependency.
 *
 * The pipeline registers an `AbortController` (and the storage path it's
 * uploading to, if known) when it begins working on an item, then
 * unregisters when the work is finished. The store calls
 * `cancelVaultUpload` from `clearAll` / `remove` so the user dismissing
 * the toast actually stops the in-flight TUS upload and best-effort
 * cleans up any partial object that already landed on Supabase.
 */

interface CancelEntry {
  controller: AbortController;
  /** The current storage path, populated once we start uploading. */
  storagePath: string | null;
  /** Bucket the partial object lives in, default `user-files`. */
  bucket: string;
}

const registry = new Map<string, CancelEntry>();

export function registerVaultUploadCancellation(
  itemId: string,
  controller: AbortController,
): void {
  registry.set(itemId, { controller, storagePath: null, bucket: "user-files" });
}

export function setVaultUploadStoragePath(
  itemId: string,
  storagePath: string,
  bucket = "user-files",
): void {
  const entry = registry.get(itemId);
  if (!entry) return;
  entry.storagePath = storagePath;
  entry.bucket = bucket;
}

export function unregisterVaultUploadCancellation(itemId: string): void {
  registry.delete(itemId);
}

/**
 * The COMMIT POINT for an upload.
 *
 * Call this synchronously the instant a `vault_items` row has been
 * successfully inserted — *before* any `await`, `return`, or fire-and-forget
 * post-processing. It atomically decides, in a single JS turn (no `await`
 * inside, so no `cancelVaultUpload` can interleave), whether the upload is
 * safe to keep:
 *
 *   - returns `true`  → the item was still live and un-aborted. The registry
 *                       entry is deleted, so every *later* `cancelVaultUpload`
 *                       for this id becomes a guaranteed no-op. The file and
 *                       row are now committed and can't be reaped out from
 *                       under each other.
 *   - returns `false` → the user cancelled during/just before the insert
 *                       (the entry is gone or its signal is aborted). The
 *                       caller must roll back the just-created row (and the
 *                       file) so we don't leave a row pointing at a storage
 *                       object that `cancelVaultUpload` already deleted — the
 *                       exact race this guards against.
 *
 * This replaces the old "unregister in `finally`" timing, which left a window
 * between insert-commit and unregister where a dismiss could delete the file
 * while the row survived.
 */
export function commitVaultUpload(itemId: string): boolean {
  const entry = registry.get(itemId);
  // Gone already → a cancel fired during the insert await. Aborted → the
  // user dismissed but our `finally` hasn't run yet. Either way: not safe.
  if (!entry || entry.controller.signal.aborted) return false;
  registry.delete(itemId);
  return true;
}

/**
 * Aborts the in-flight upload for `itemId` (if any) and best-effort
 * removes the partial storage object so we don't leak bytes. Safe to
 * call for unknown ids or items that have already finished — it's a
 * no-op in those cases.
 */
export function cancelVaultUpload(itemId: string): void {
  const entry = registry.get(itemId);
  if (!entry) return;
  registry.delete(itemId);
  try {
    entry.controller.abort();
  } catch {
    /* abort can't really throw, but be defensive */
  }
  // Best-effort cleanup of the partial TUS object. We can't do this
  // synchronously and we deliberately don't `await` — the user already
  // dismissed the toast and we don't want a slow Supabase round-trip
  // blocking the UI.
  if (entry.storagePath) {
    void (async () => {
      try {
        const { supabase } = await import("@/lib/supabase");
        await supabase.storage
          .from(entry.bucket)
          .remove([entry.storagePath as string]);
      } catch {
        /* best-effort */
      }
    })();
  }
}
