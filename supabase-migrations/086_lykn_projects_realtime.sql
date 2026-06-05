-- =====================================================================
-- 086 — Realtime for lykn_projects + lykn_project_neurons
-- =====================================================================
-- Migration 048 enabled realtime for lykn_project_state so the Updates
-- panel can reflect MCP pushes. Membership changes (addProjectNeurons,
-- user cluster flow) touch lykn_projects + lykn_project_neurons but
-- were not on the publication — the synthesis graph stayed stale until
-- a manual refresh. Mirror 048's publication + REPLICA IDENTITY FULL.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_projects'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_projects';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'lykn_project_neurons'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.lykn_project_neurons';
  END IF;
END $$;

ALTER TABLE public.lykn_projects        REPLICA IDENTITY FULL;
ALTER TABLE public.lykn_project_neurons REPLICA IDENTITY FULL;

COMMENT ON TABLE public.lykn_projects IS
  'Middle-tier synthesis project container. Realtime-enabled so the synthesis Projects cluster + side panel reflect AI/chat membership + metadata changes live. See migrations 048 + 086.';
COMMENT ON TABLE public.lykn_project_neurons IS
  'Project ↔ neuron membership. Realtime-enabled so clustered neurons appear in the project panel without refresh. See migration 086.';
