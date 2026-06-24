-- 111_vault_upload_reconciler.sql
--
-- Durable backstop for the vault upload race that orphans storage objects /
-- dangling rows (see src/lib/vault/uploadCancellation.ts commit-point fix).
--
-- The client-side commit point stops NEW orphans for uploads this tab
-- finishes. But a crash, a force-quit, or a closed laptop lid between
-- "bytes in storage" and "row inserted" (or a cancel that the in-memory
-- registry never sees because the tab is gone) leaves an inconsistency no
-- client code can ever clean up. This migration adds the server-side
-- reconciler's schema:
--
--   1. `upload_state` column — lets the sweep flag rows whose storage object
--      has vanished as 'missing' (instead of leaving a row pointing at a
--      404'd [View File] link), without destroying the row's metadata.
--
--   2. `vault_find_missing_objects(grace_minutes)` — RPC returning
--      file_upload rows whose `storage_path` has no matching `storage.objects`
--      row, older than a grace window so genuinely in-flight uploads aren't
--      reaped. (The row-without-file direction — the bug we found in prod.)
--
--   3. `vault_list_storage_objects(bucket, older_than_minutes)` — read-only
--      RPC that surfaces `storage.objects` to the reconciler job so it can
--      detect truly-leaked files (the file-without-row direction). It only
--      LISTS; deletion is done by the job via the storage API, gated behind a
--      flag, and cross-checked in JS against the content marker (paths the
--      column doesn't know about) so a live file is never deleted.
--
-- Both RPCs are SECURITY DEFINER (they must read the `storage` schema, which
-- `authenticated` can't) and are granted to `service_role` ONLY — the cron
-- runs as service-role, no end user can call them.
--
-- Idempotent: safe to run more than once.

-- ── 1. upload_state column ────────────────────────────────────────────────
-- Values (validated in app code, not a DB CHECK so new states never need a
-- migration):
--   committed | missing | reaping
-- NULL = legacy/unknown (the reconciler treats "object exists" as healthy
-- regardless, so back-population is optional).
ALTER TABLE public.vault_items ADD COLUMN IF NOT EXISTS upload_state text;

COMMENT ON COLUMN public.vault_items.upload_state IS
  'Vault upload reconciliation state: committed|missing|reaping (NULL=legacy/unknown). Set by the upload reconciler when a row''s storage object is missing. Migration 111.';

-- Tiny partial index — only the handful of non-healthy rows are indexed.
CREATE INDEX IF NOT EXISTS idx_vault_items_upload_state
  ON public.vault_items (upload_state) WHERE upload_state IS NOT NULL;

-- Helps the reconciler / backfill scan only the rows that own a file.
CREATE INDEX IF NOT EXISTS idx_vault_items_storage_path
  ON public.vault_items (storage_path) WHERE storage_path IS NOT NULL;

-- ── 2. Missing-object detector (row-without-file) ─────────────────────────
CREATE OR REPLACE FUNCTION public.vault_find_missing_objects(grace_minutes integer DEFAULT 30)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  storage_path text,
  storage_bucket text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT v.id,
         v.user_id,
         v.storage_path,
         COALESCE(v.storage_bucket, 'user-files') AS storage_bucket,
         v.created_at
  FROM public.vault_items v
  LEFT JOIN storage.objects o
    ON o.bucket_id = COALESCE(v.storage_bucket, 'user-files')
   AND o.name = v.storage_path
  WHERE v.source = 'file_upload'
    AND v.storage_path IS NOT NULL
    AND o.id IS NULL
    AND v.created_at < now() - make_interval(mins => GREATEST(grace_minutes, 0))
$$;

COMMENT ON FUNCTION public.vault_find_missing_objects(integer) IS
  'Reconciler RPC: file_upload vault_items whose storage_path has no matching storage.objects row, older than grace_minutes. service_role only. Migration 111.';

-- ── 3. Storage object lister (for the file-without-row sweep) ──────────────
CREATE OR REPLACE FUNCTION public.vault_list_storage_objects(
  p_bucket text DEFAULT 'user-files',
  older_than_minutes integer DEFAULT 60
)
RETURNS TABLE (
  name text,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, storage
AS $$
  SELECT o.name, o.created_at
  FROM storage.objects o
  WHERE o.bucket_id = p_bucket
    AND o.name IS NOT NULL
    AND o.created_at < now() - make_interval(mins => GREATEST(older_than_minutes, 0))
$$;

COMMENT ON FUNCTION public.vault_list_storage_objects(text, integer) IS
  'Reconciler RPC: lists storage.objects names (+created_at) in a bucket older than the grace window so the job can detect leaked files. Read-only; deletion happens in the job, cross-checked against the content marker. service_role only. Migration 111.';

-- Lock both RPCs down to the cron identity only.
REVOKE ALL ON FUNCTION public.vault_find_missing_objects(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vault_list_storage_objects(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vault_find_missing_objects(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.vault_list_storage_objects(text, integer) TO service_role;

-- Tell PostgREST to pick up the new column + RPCs.
NOTIFY pgrst, 'reload schema';
