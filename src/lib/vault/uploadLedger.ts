/**
 * Client-side writer for the vault upload ledger (migration 112).
 *
 * The vault pipeline records a `lykn_upload_ledger` row state='uploading'
 * BEFORE it pushes bytes to storage, and clears it the instant the row commits
 * (or rolls back). A ledger row that's still 'uploading' long past the
 * reconciler's grace window is therefore positive proof of an abandoned
 * upload — a crash / tab-close between "bytes in storage" and "row inserted" —
 * which is the only case where deleting the storage object is provably safe on
 * the shared `user-files` bucket.
 *
 * Both functions are BEST-EFFORT and never throw: a failure here must not break
 * an otherwise-healthy upload, and they no-op gracefully on DBs that predate
 * migration 112. The reconciler's reverse-scan (report-only) remains the
 * backstop for any object the ledger failed to record.
 */
import { supabase } from "@/lib/supabase";

const LEDGER_TABLE = "lykn_upload_ledger";

/** Record an in-flight upload. Idempotent (upsert on bucket+storage_path). */
export async function beginUploadLedger(
  userId: string,
  storagePath: string,
  bucket = "user-files",
  source = "vault",
): Promise<void> {
  try {
    await supabase
      .from(LEDGER_TABLE)
      .upsert(
        { user_id: userId, storage_path: storagePath, bucket, source, state: "uploading" },
        { onConflict: "bucket,storage_path" },
      );
  } catch {
    /* best-effort — table may not exist pre-migration */
  }
}

/**
 * Clear an upload's ledger row — called at the commit point (success) and on
 * every rollback/abort path. After this, the upload is no longer considered
 * in-flight and can't be reaped by the reconciler.
 */
export async function clearUploadLedger(
  storagePath: string,
  bucket = "user-files",
): Promise<void> {
  try {
    await supabase
      .from(LEDGER_TABLE)
      .delete()
      .eq("bucket", bucket)
      .eq("storage_path", storagePath);
  } catch {
    /* best-effort */
  }
}
