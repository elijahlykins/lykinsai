-- 106_rename_notes_to_vault_items.sql
--
-- Phase 5 (Vault Normalization Program) — legacy naming pass.
--
-- Renames the core `notes` table to `vault_items` and installs a
-- backward-compatible `notes` VIEW so the ~40 files / 130+ call sites in this
-- app AND the separate iOS app (which still reads `notes`) keep working without
-- a coordinated big-bang change. New code should target `vault_items`; the
-- `notes` view is retired only after every client migrates.
--
-- WHY A VIEW (and why security_invoker):
--   * RENAME TABLE carries indexes, triggers, FKs, sequences and RLS policies
--     with it automatically (they bind by OID, not name), so the policies that
--     protect per-user rows continue to apply to `vault_items`.
--   * A simple single-table view is auto-updatable in PostgreSQL, so
--     INSERT/UPDATE/DELETE through `notes` still hit `vault_items`.
--   * `security_invoker = on` (PG15+, which Supabase runs) makes the view run
--     with the QUERYING user's privileges, so the underlying RLS on
--     `vault_items` is evaluated against the real caller — NOT the view owner.
--     Without this the view owner's rights would apply and could bypass RLS
--     (cross-user data leak). This flag is mandatory.
--
-- ⚠️ DESTRUCTIVE / COORDINATE WITH iOS before running in production. The dual
--    name (table `vault_items` + view `notes`) is the transition bridge.
--
-- Idempotent: safe to run more than once.

DO $$
BEGIN
  -- Only rename if the table still exists under the old name and the new name
  -- is not already taken (by a prior run or a leftover view).
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'notes' AND table_type = 'BASE TABLE'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'vault_items'
  ) THEN
    EXECUTE 'ALTER TABLE public.notes RENAME TO vault_items';
  END IF;
END $$;

-- Backward-compatible view under the old name. Replaceable so reruns are safe.
-- security_invoker MUST stay on so RLS on vault_items is enforced per-caller.
CREATE OR REPLACE VIEW public.notes
  WITH (security_invoker = on)
  AS SELECT * FROM public.vault_items;

-- Mirror the broad role grants the base table carried; RLS on vault_items is
-- the actual row-level gate, the view just forwards.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO anon;

COMMENT ON VIEW public.notes IS
  'Backward-compat alias for vault_items (Phase 5 rename). security_invoker=on so RLS is enforced against the querying user. Retire after all clients (incl. iOS) read vault_items.';

NOTIFY pgrst, 'reload schema';
