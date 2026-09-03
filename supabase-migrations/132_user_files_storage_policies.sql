-- Version Storage RLS for the `user-files` bucket.
--
-- Objects are written as `{userId}/...` (see uploadFileToStorage,
-- persistCapabilityArtifact, and overlay snip uploads). Dashboard-only
-- policies are not represented in git, so this migration is the source of
-- truth for authenticated access.
--
-- The bucket stays private. Service role continues to bypass these
-- policies for signed-URL minting and account-deletion purge.
--
-- Applying this to production is an operational step (run the migration
-- against the live project). Existing dashboard policies with other names
-- are not dropped here; review them after apply and remove duplicates
-- that are broader than `{auth.uid()}/...`.

UPDATE storage.buckets
SET public = false
WHERE id = 'user-files';

DROP POLICY IF EXISTS "user_files_select_own" ON storage.objects;
DROP POLICY IF EXISTS "user_files_insert_own" ON storage.objects;
DROP POLICY IF EXISTS "user_files_update_own" ON storage.objects;
DROP POLICY IF EXISTS "user_files_delete_own" ON storage.objects;

CREATE POLICY "user_files_select_own"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'user-files'
  AND name LIKE (auth.uid()::text || '/%')
);

CREATE POLICY "user_files_insert_own"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'user-files'
  AND name LIKE (auth.uid()::text || '/%')
);

CREATE POLICY "user_files_update_own"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'user-files'
  AND name LIKE (auth.uid()::text || '/%')
)
WITH CHECK (
  bucket_id = 'user-files'
  AND name LIKE (auth.uid()::text || '/%')
);

CREATE POLICY "user_files_delete_own"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'user-files'
  AND name LIKE (auth.uid()::text || '/%')
);
