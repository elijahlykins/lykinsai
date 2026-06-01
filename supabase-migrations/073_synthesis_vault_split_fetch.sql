-- ============================================
-- Synthesis split fetch: connector source counts RPC
-- Migration: 073_synthesis_vault_split_fetch.sql
-- ============================================
--
-- Pro-only product loads manual/perspective notes separately from
-- connector sync rows. This RPC returns per-source counts so the
-- synthesis graph can render accurate rollup labels (Gmail · 2,847)
-- without fetching thousands of connector rows on mount.
--
-- Manual notes continue to paginate via PostgREST; only connector
-- aggregates move server-side. Mirrors vault_tag_counts() (053).

CREATE OR REPLACE FUNCTION public.vault_connector_source_counts()
RETURNS TABLE(source text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    trim(n.source) AS source,
    count(*)::bigint AS count
  FROM public.notes n
  WHERE
    n.user_id = auth.uid()
    AND n.source IS NOT NULL
    AND trim(n.source) <> ''
    AND trim(n.source) IN (
      'gmail_starred', 'gmail_inbox', 'outlook_flagged', 'notion_page',
      'slack_saved', 'github_starred', 'linear_issue', 'todoist',
      'trello_card', 'readwise', 'raindrop_bookmark', 'spotify_liked',
      'vimeo_liked', 'youtube_liked', 'x_bookmark', 'bluesky_like',
      'pinterest_pin', 'lastfm_loved', 'karakeep', 'linkding', 'pinboard',
      'goodreads', 'hardcover', 'gcal_event', 'gdrive_starred',
      'gdocs_starred', 'gsheets_starred', 'gslides_starred'
    )
  GROUP BY trim(n.source)
  ORDER BY count DESC, source ASC;
$$;

COMMENT ON FUNCTION public.vault_connector_source_counts() IS
  'Per-connector-source note counts for the signed-in user. Used by Synthesis to build rollup nodes without loading every synced row.';

-- Paginated manual + perspective notes (excludes connector sync rows).
CREATE OR REPLACE FUNCTION public.vault_manual_notes_for_graph(
  p_limit             integer DEFAULT 200,
  p_cursor_updated_at timestamptz DEFAULT NULL,
  p_cursor_id         uuid DEFAULT NULL
)
RETURNS TABLE(
  id          uuid,
  title       text,
  tags        text[],
  ai_summary  text,
  ai_signals  jsonb,
  source      text,
  created_at  timestamptz,
  updated_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    n.id,
    n.title,
    n.tags,
    n.ai_summary,
    n.ai_signals,
    n.source,
    n.created_at,
    n.updated_at
  FROM public.notes n
  WHERE
    n.user_id = auth.uid()
    AND (
      n.source IS NULL
      OR trim(n.source) = ''
      OR trim(n.source) NOT IN (
        'gmail_starred', 'gmail_inbox', 'outlook_flagged', 'notion_page',
        'slack_saved', 'github_starred', 'linear_issue', 'todoist',
        'trello_card', 'readwise', 'raindrop_bookmark', 'spotify_liked',
        'vimeo_liked', 'youtube_liked', 'x_bookmark', 'bluesky_like',
        'pinterest_pin', 'lastfm_loved', 'karakeep', 'linkding', 'pinboard',
        'goodreads', 'hardcover', 'gcal_event', 'gdrive_starred',
        'gdocs_starred', 'gsheets_starred', 'gslides_starred'
      )
    )
    AND (
      p_cursor_updated_at IS NULL
      OR (n.updated_at, n.id) < (
        p_cursor_updated_at,
        COALESCE(p_cursor_id, '00000000-0000-0000-0000-000000000000'::uuid)
      )
    )
  ORDER BY n.updated_at DESC, n.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
$$;

COMMENT ON FUNCTION public.vault_manual_notes_for_graph(integer, timestamptz, uuid) IS
  'Lightweight paginated fetch of manual/perspective vault notes for the synthesis graph (connector rows excluded).';

REVOKE ALL ON FUNCTION public.vault_connector_source_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_connector_source_counts() TO authenticated;

REVOKE ALL ON FUNCTION public.vault_manual_notes_for_graph(integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_manual_notes_for_graph(integer, timestamptz, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
