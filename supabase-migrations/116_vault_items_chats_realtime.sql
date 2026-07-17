-- =====================================================================
-- 116 — Realtime for vault_items + lykn_chats (Synthesis live-sync fix)
-- =====================================================================
-- The Synthesis Layer subscribes to postgres_changes on the vault and
-- chats tables so the 3D mind map updates live when items are added /
-- edited / deleted elsewhere (Vault page, another tab, connectors).
--
-- Neither table was ever added to the `supabase_realtime` publication
-- (048 only covered facts / beliefs / project_state; 106 renamed
-- `notes` → `vault_items` leaving `notes` as a view, and views never
-- emit realtime events). Result: the client subscriptions returned
-- ok=true but no events were ever delivered — vault/chat neurons only
-- refreshed on a manual page reload.
--
-- Same idempotent pattern as migrations 048 / 086: publication add
-- guarded by pg_publication_tables, plus REPLICA IDENTITY FULL so
-- filtered UPDATE/DELETE events carry the user_id column.
-- RLS SELECT policies on both tables key off auth.uid() = user_id,
-- which Realtime enforces server-side before delivery.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'vault_items'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.vault_items';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_chats'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_chats';
  END IF;
END $$;

ALTER TABLE public.vault_items REPLICA IDENTITY FULL;
ALTER TABLE public.lykn_chats  REPLICA IDENTITY FULL;
