-- =====================================================================
-- 059 — concept run counters on lykn_synthesis_runs
-- =====================================================================
-- The nightly concepts job (jobs/conceptsJob.js) records its funnel
-- alongside the existing belief synthesis run audit so a single
-- "last night the AI noticed..." UI can show both pipelines without
-- a second table. The shape mirrors the belief counters from 047.
--
-- We extend in-place (additive columns, default 0) rather than
-- minting a new table so the existing dashboards keep working and
-- a single ran_at row covers both pipelines per user-night.
--
-- Columns:
--   concepts_clusters_found    — chunk clusters DBSCAN found
--   concepts_candidates        — clusters that hit the size threshold
--   concepts_proposed          — new lykn_concepts rows written
--   concepts_attached          — existing concepts that gained links
--                                without minting a new row (cosine-dedup)
--   concepts_skipped_duplicate — clusters whose centroid was too close
--                                to an existing concept embedding
--   concepts_skipped_threshold — clusters with too few chunks
--   concepts_links_written     — total concept_{notes,facts,beliefs,chats}
--                                rows written this run
--   concepts_error_count       — clusters that errored during naming
--
-- The `details` JSONB already carries arbitrary per-run payload;
-- the concepts job appends a `concepts` subkey describing each
-- cluster + the names the LLM chose so the audit UI has rich data
-- without a second migration.
--
-- ----------------------------------------------------------------------
-- Prerequisite: lykn_synthesis_runs (migration 047). If 047 has not
-- been applied yet, this migration is a no-op rather than a hard
-- failure — the concepts job tolerates the table being absent (the
-- finalize() insert errors get swallowed) so applying this file
-- early should never block you. Re-run this file once 047 lands and
-- the columns will get added the second time around.
-- ----------------------------------------------------------------------

DO $$
BEGIN
  IF to_regclass('public.lykn_synthesis_runs') IS NULL THEN
    RAISE NOTICE
      '059: skipping concept counter columns — lykn_synthesis_runs does not exist yet (apply migration 047 first, then re-run this file).';
    RETURN;
  END IF;

  ALTER TABLE lykn_synthesis_runs
    ADD COLUMN IF NOT EXISTS concepts_clusters_found INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concepts_candidates INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concepts_proposed INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concepts_attached INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concepts_skipped_duplicate INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concepts_skipped_threshold INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concepts_links_written INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS concepts_error_count INT NOT NULL DEFAULT 0;
END
$$;

-- Comments are issued unconditionally outside the DO block so they
-- become effective the moment the columns exist; if the columns
-- aren't there yet, the COMMENT statements will themselves error,
-- so we also guard them.
DO $$
BEGIN
  IF to_regclass('public.lykn_synthesis_runs') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $cmt$
    COMMENT ON COLUMN lykn_synthesis_runs.concepts_proposed IS
      'Count of new lykn_concepts rows written this run (status=proposed, source=ai_clustered).';
  $cmt$;
  EXECUTE $cmt$
    COMMENT ON COLUMN lykn_synthesis_runs.concepts_attached IS
      'Count of clusters whose centroid matched an existing concept (cosine > 0.85) and were attached via concept_* join rows instead of minting a new concept.';
  $cmt$;
  EXECUTE $cmt$
    COMMENT ON COLUMN lykn_synthesis_runs.concepts_links_written IS
      'Total concept_{notes,facts,beliefs,chats} rows written or upserted this run.';
  $cmt$;
END
$$;
