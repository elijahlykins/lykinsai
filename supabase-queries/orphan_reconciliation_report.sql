-- Orphaned-storage reconciliation report (READ-ONLY).
-- Classifies every folder in the `user-files` bucket against vault_items references.
-- Companion to scripts/reconcile-orphaned-storage.mjs and ORPHAN_RECONCILIATION_PLAN.md.
--
-- Background: the iOS client-side orphan-recovery sweep was deleted in the
-- 2026-07-16 audit-fix sweep (it would have minted duplicate rows for folders
-- whose <fileId> segment is not the vault_items row id). This report is the
-- server-side replacement for understanding what those bytes actually are.
--
-- Path scheme: user-files/<user_id>/<file_id>/original.<ext> (+ thumb.jpg / medium.jpg variants).
-- Reference channels, in order of strength:
--   1. vault_items.id = <file_id>                      (iOS uploads: folder id == row id)
--   2. storage_path / variant_medium_path / variant_thumb_path prefix match
--   3. <file_id> appearing in same-user content / url / attachment_preview
--      (web uploads embed signed URLs; folder id != row id)
--
-- Classes:
--   A  referenced by id or path            -> healthy, no action
--   B  referenced only in content columns   -> KEEP (deleting would break live notes);
--                                              optional later backfill of storage_path
--   C2 unreferenced, original present       -> quarantine (deleted-note leftovers and
--                                              never-attached uploads are indistinguishable;
--                                              never auto-resurrect)
--   C3 unreferenced, variants only          -> quarantine (garbage: derivatives without source)
--   X  <file_id> referenced by a DIFFERENT  -> manual review only (account-fragmentation
--      user's row                              signature; see vault account fragmentation notes)
--
-- Live counts when authored (2026-07-16): A=223 folders/503 objects/305MB,
-- B=92/343/211MB, C2=202/202/77MB (10 users), C3=12/29/6.5MB, X=3/3/2MB.
-- Counts drift; re-run this report before acting.

WITH objs AS (
  SELECT name,
    (string_to_array(name, '/'))[1] AS uid_seg,
    (string_to_array(name, '/'))[2] AS file_seg,
    (string_to_array(name, '/'))[3] AS leaf,
    created_at,
    COALESCE((metadata->>'size')::bigint, 0) AS size_bytes
  FROM storage.objects
  WHERE bucket_id = 'user-files'
    AND name NOT LIKE '\_quarantine/%'
),
folders AS (
  SELECT uid_seg, file_seg,
    count(*) AS n_objects,
    sum(size_bytes) AS folder_bytes,
    bool_or(leaf LIKE 'original.%') AS has_original,
    bool_or(leaf NOT LIKE 'original.%') AS has_variants,
    min(created_at) AS first_created,
    array_agg(leaf ORDER BY leaf) AS leaves
  FROM objs GROUP BY uid_seg, file_seg
),
folder_class AS (
  SELECT f.*,
    EXISTS (SELECT 1 FROM public.vault_items v WHERE v.id::text = f.file_seg) AS row_id_match,
    EXISTS (SELECT 1 FROM public.vault_items v WHERE
      v.storage_path LIKE f.uid_seg || '/' || f.file_seg || '/%'
      OR v.variant_medium_path LIKE f.uid_seg || '/' || f.file_seg || '/%'
      OR v.variant_thumb_path LIKE f.uid_seg || '/' || f.file_seg || '/%') AS path_match,
    EXISTS (SELECT 1 FROM public.vault_items v WHERE v.user_id::text = f.uid_seg AND
      (v.content ILIKE '%' || f.file_seg || '%'
       OR v.url ILIKE '%' || f.file_seg || '%'
       OR v.attachment_preview::text ILIKE '%' || f.file_seg || '%')) AS content_match_same_user,
    EXISTS (SELECT 1 FROM public.vault_items v WHERE v.user_id::text <> f.uid_seg AND
      (v.storage_path LIKE '%' || f.file_seg || '%'
       OR v.content ILIKE '%' || f.file_seg || '%')) AS cross_user_ref
  FROM folders f
),
labeled AS (
  SELECT *,
    CASE
      WHEN row_id_match OR path_match THEN 'A'
      WHEN content_match_same_user THEN 'B'
      WHEN cross_user_ref THEN 'X'
      WHEN has_original THEN 'C2'
      ELSE 'C3'
    END AS class
  FROM folder_class
)

-- Summary rollup. Swap the final SELECT for the commented one below to get
-- the full per-folder manifest.
SELECT class,
  count(*) AS folders,
  sum(n_objects) AS objects,
  pg_size_pretty(sum(folder_bytes)) AS bytes,
  count(DISTINCT uid_seg) AS users,
  min(first_created)::date AS oldest,
  max(first_created)::date AS newest
FROM labeled
GROUP BY class ORDER BY class;

-- Per-folder manifest (uncomment to use):
-- SELECT class, uid_seg AS user_id, file_seg AS file_id, n_objects, folder_bytes,
--        has_original, has_variants, leaves, first_created
-- FROM labeled
-- WHERE class IN ('B','C2','C3','X')
-- ORDER BY class, uid_seg, first_created;
