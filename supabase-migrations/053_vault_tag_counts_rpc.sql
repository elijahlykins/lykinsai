-- ============================================
-- Vault tag directory aggregation
-- Migration: 053_vault_tag_counts_rpc.sql
-- ============================================
--
-- Background
-- ----------
-- `VaultNew.jsx` builds the tag directory by `select("tags")` against
-- `notes` filtered by `user_id`, then aggregates in JavaScript on the
-- main thread. For accounts with thousands of notes that's:
--   * a megabyte-scale payload
--   * a long JSON.parse + array allocation
--   * a synchronous reduce on the main thread
--   * recomputed on every refetch trigger
--
-- This RPC pushes the aggregation into Postgres where it can run on a
-- GIN index of the `tags` column (already created by 020) and return
-- only the (tag, count) pairs the UI actually needs.
--
-- The function is SECURITY DEFINER + RLS-honoring: we hard-restrict the
-- query to `auth.uid()` so a caller can't ever read another user's tag
-- distribution by passing a user id (see WHERE clause below).
--
-- The function returns rows ordered by count desc, then tag asc, so the
-- client can render directly without a second sort.

CREATE OR REPLACE FUNCTION public.vault_tag_counts()
RETURNS TABLE(tag text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    trim(unnested.tag) AS tag,
    count(*)::bigint AS count
  FROM public.notes n
  CROSS JOIN LATERAL unnest(n.tags) AS unnested(tag)
  WHERE
    n.user_id = auth.uid()
    AND n.tags IS NOT NULL
    AND trim(unnested.tag) <> ''
  GROUP BY trim(unnested.tag)
  ORDER BY count DESC, tag ASC;
$$;

-- Lock down execution: anonymous callers MUST NOT run this. Authenticated
-- callers get access; service-role can call it but auth.uid() will be NULL
-- in that context so it returns zero rows (which is fine — service role
-- doesn't need this function).
REVOKE ALL ON FUNCTION public.vault_tag_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_tag_counts() TO authenticated;
