-- ============================================
-- Sync synthesis connector source allowlists with the Vault UI
-- Migration: 097_vault_connector_sources_sync.sql
-- ============================================
--
-- Migration 073 introduced vault_connector_source_counts() and
-- vault_manual_notes_for_graph(), each carrying a hard-coded list of
-- connector `source` values used to decide which notes are "connector
-- rollups" vs "manual notes" in the Synthesis graph.
--
-- That list drifted from the connectors actually shipping + the Vault UI's
-- SOURCE_TO_CONNECTOR_ID map (src/pages/new/VaultNew.jsx):
--   • Reddit    -> reddit_saved_post, reddit_saved_comment   (missing)
--   • Mastodon  -> mastodon_favourite, mastodon_bookmark     (missing)
--   • Canva     -> canva_design                              (missing)
--   • Dribbble  -> dribbble_liked                            (missing)
--   • Todoist   -> connectors/todoist.js writes `todoist_task`, but 073
--                  allowlisted the bare `todoist` value (drift). We keep
--                  BOTH so any legacy rows still fold into the rollup.
--
-- Result of the drift: items synced from these connectors were treated as
-- individual manual notes (returned by vault_manual_notes_for_graph and
-- absent from the rollup counts), so the Synthesis graph rendered hundreds
-- of loose nodes instead of "Reddit · 142" folder rollups — slower loads
-- and inconsistent UX vs the Vault page.
--
-- This migration recreates both functions with the synced allowlist. The
-- canonical list is duplicated in both functions (mirroring 073); keep them
-- identical when adding future connectors.

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
      'slack_saved', 'github_starred', 'linear_issue', 'todoist', 'todoist_task',
      'trello_card', 'readwise', 'raindrop_bookmark', 'spotify_liked',
      'vimeo_liked', 'youtube_liked', 'x_bookmark', 'bluesky_like',
      'pinterest_pin', 'lastfm_loved', 'karakeep', 'linkding', 'pinboard',
      'goodreads', 'hardcover', 'gcal_event', 'gdrive_starred',
      'gdocs_starred', 'gsheets_starred', 'gslides_starred',
      'reddit_saved_post', 'reddit_saved_comment',
      'mastodon_favourite', 'mastodon_bookmark',
      'canva_design', 'dribbble_liked'
    )
  GROUP BY trim(n.source)
  ORDER BY count DESC, source ASC;
$$;

COMMENT ON FUNCTION public.vault_connector_source_counts() IS
  'Per-connector-source note counts for the signed-in user. Used by Synthesis to build rollup nodes without loading every synced row. Allowlist synced with Vault UI SOURCE_TO_CONNECTOR_ID (097).';

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
        'slack_saved', 'github_starred', 'linear_issue', 'todoist', 'todoist_task',
        'trello_card', 'readwise', 'raindrop_bookmark', 'spotify_liked',
        'vimeo_liked', 'youtube_liked', 'x_bookmark', 'bluesky_like',
        'pinterest_pin', 'lastfm_loved', 'karakeep', 'linkding', 'pinboard',
        'goodreads', 'hardcover', 'gcal_event', 'gdrive_starred',
        'gdocs_starred', 'gsheets_starred', 'gslides_starred',
        'reddit_saved_post', 'reddit_saved_comment',
        'mastodon_favourite', 'mastodon_bookmark',
        'canva_design', 'dribbble_liked'
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
  'Lightweight paginated fetch of manual/perspective vault notes for the synthesis graph (connector rows excluded). Allowlist synced with Vault UI SOURCE_TO_CONNECTOR_ID (097).';

REVOKE ALL ON FUNCTION public.vault_connector_source_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_connector_source_counts() TO authenticated;

REVOKE ALL ON FUNCTION public.vault_manual_notes_for_graph(integer, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.vault_manual_notes_for_graph(integer, timestamptz, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
