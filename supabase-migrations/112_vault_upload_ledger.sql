-- 112_vault_upload_ledger.sql
--
-- Authoritative in-flight tracking for vault uploads, so the reconciler can
-- SAFELY reap crash/tab-close leaks without reverse-scanning the shared
-- `user-files` bucket.
--
-- WHY THIS EXISTS:
--   `user-files` is shared — vault uploads, chat attachments, AI-generated
--   chat images, and capability artifacts all live there, and chat
--   attachments use the EXACT `<uuid>/<uuid>/original.ext` path shape as vault
--   uploads. That makes a reverse-scan ("delete any object no row references")
--   fundamentally unsafe: chat state is trimmed to the last 50 messages, so a
--   live file can legitimately be unreferenced in the DB. See migration 111's
--   reconciler notes.
--
--   The fix is positive tracking instead of reverse inference. The vault
--   pipeline writes a ledger row state='uploading' BEFORE pushing bytes, and
--   clears it the instant the row commits (the commit point in
--   src/lib/vault/uploadCancellation.ts). A ledger row that's still
--   'uploading' well past a grace window is therefore PROOF of an abandoned
--   vault upload — the only case where deleting the storage object is provably
--   safe. The ledger only ever holds IN-FLIGHT uploads (committed rows are
--   deleted), so it stays tiny.
--
-- Scope: the vault pipeline only. Chat/generated/capability uploaders are
-- owned elsewhere and are intentionally NOT swept by our reconciler.
--
-- Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS public.lykn_upload_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  bucket text NOT NULL DEFAULT 'user-files',
  storage_path text NOT NULL,
  -- Which feature created the object. Only 'vault' is swept today; the column
  -- lets other uploaders opt in later without a schema change.
  source text NOT NULL DEFAULT 'vault',
  -- 'uploading' (in flight) — committed uploads delete their row, so this is
  -- effectively always 'uploading' in practice. Kept as a column for clarity
  -- and future states (e.g. 'orphaned').
  state text NOT NULL DEFAULT 'uploading',
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  -- One ledger row per object. Upserts on (bucket, storage_path) make
  -- begin/clear idempotent under retries.
  UNIQUE (bucket, storage_path)
);

CREATE INDEX IF NOT EXISTS idx_upload_ledger_state_created
  ON public.lykn_upload_ledger (state, created_at);
CREATE INDEX IF NOT EXISTS idx_upload_ledger_user
  ON public.lykn_upload_ledger (user_id);

COMMENT ON TABLE public.lykn_upload_ledger IS
  'In-flight vault upload tracking (migration 112). A row state=''uploading'' older than the reconciler grace = an abandoned upload whose storage object is safe to delete. Rows are cleared at the commit point; the table holds only in-flight uploads.';

-- RLS: users manage only their own ledger rows. The reconciler runs as
-- service_role and bypasses RLS entirely.
ALTER TABLE public.lykn_upload_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lykn_upload_ledger_select_own ON public.lykn_upload_ledger;
CREATE POLICY lykn_upload_ledger_select_own
  ON public.lykn_upload_ledger FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_upload_ledger_insert_own ON public.lykn_upload_ledger;
CREATE POLICY lykn_upload_ledger_insert_own
  ON public.lykn_upload_ledger FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_upload_ledger_update_own ON public.lykn_upload_ledger;
CREATE POLICY lykn_upload_ledger_update_own
  ON public.lykn_upload_ledger FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS lykn_upload_ledger_delete_own ON public.lykn_upload_ledger;
CREATE POLICY lykn_upload_ledger_delete_own
  ON public.lykn_upload_ledger FOR DELETE TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lykn_upload_ledger TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lykn_upload_ledger TO service_role;

NOTIFY pgrst, 'reload schema';
