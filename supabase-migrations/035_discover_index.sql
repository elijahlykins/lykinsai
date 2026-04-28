-- ============================================
-- LYKN Discover content index
-- Migration: 035_discover_index.sql
-- ============================================
-- A global, cross-user index of articles + videos that the Discover feed
-- reads from instead of hitting Serper / YouTube live on every page load.
--
-- Lifecycle:
--   1. POST /api/discover/ingest (admin-only, bearer-secret) periodically
--      ingests fresh content keyed by the union of all users' synthesis
--      themes. Rows live for ~14 days, then are pruned by the same job.
--   2. POST /api/discover/feed reads from these tables using keyset
--      (cursor) pagination on (popularity_score DESC, id DESC).
--   3. If DB coverage for a user's themes is thin, the feed endpoint
--      falls back to the existing live Serper/YouTube path.
--
-- Both content tables are GLOBAL (no user_id) — the same article surfaces
-- for any user whose themes overlap with topic_tags. Authenticated users
-- can read; only the service role writes.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Articles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_discover_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  image_url TEXT,
  source TEXT,                         -- "The Verge"
  source_host TEXT,                    -- "theverge.com"
  published_at TIMESTAMPTZ,
  topic_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ai_takeaway TEXT,                    -- LLM "why this matters" (1–2 lines)
  popularity_score REAL NOT NULL DEFAULT 0,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Topic-overlap searches dominate read traffic; GIN handles array intersection well.
CREATE INDEX IF NOT EXISTS idx_disc_articles_topic
  ON lykn_discover_articles USING GIN (topic_tags);
-- Keyset pagination: ORDER BY popularity_score DESC, id DESC.
CREATE INDEX IF NOT EXISTS idx_disc_articles_score
  ON lykn_discover_articles (popularity_score DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_disc_articles_ingested
  ON lykn_discover_articles (ingested_at DESC);

ALTER TABLE lykn_discover_articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "discover read articles"
  ON lykn_discover_articles FOR SELECT
  TO authenticated
  USING (true);

-- No insert/update/delete policies → only the service role can write,
-- which means our ingest endpoint (using SUPABASE_SERVICE_ROLE_KEY) has
-- write access while regular clients are read-only.

-- ---------------------------------------------------------------------------
-- Videos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_discover_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id TEXT NOT NULL UNIQUE,       -- YouTube video ID
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  channel_title TEXT,
  thumbnail_url TEXT,
  published_at TIMESTAMPTZ,
  view_count BIGINT NOT NULL DEFAULT 0,
  like_count INT NOT NULL DEFAULT 0,
  duration_sec INT NOT NULL DEFAULT 0,
  topic_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ai_takeaway TEXT,
  popularity_score REAL NOT NULL DEFAULT 0,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disc_videos_topic
  ON lykn_discover_videos USING GIN (topic_tags);
CREATE INDEX IF NOT EXISTS idx_disc_videos_score
  ON lykn_discover_videos (popularity_score DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_disc_videos_ingested
  ON lykn_discover_videos (ingested_at DESC);

ALTER TABLE lykn_discover_videos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "discover read videos"
  ON lykn_discover_videos FOR SELECT
  TO authenticated
  USING (true);

-- ---------------------------------------------------------------------------
-- Per-user "seen" tracking (cross-device dedup, optional but cheap)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lykn_discover_seen (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('article', 'video')),
  item_id UUID NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_kind, item_id)
);

CREATE INDEX IF NOT EXISTS idx_disc_seen_user_seen_at
  ON lykn_discover_seen (user_id, seen_at DESC);

ALTER TABLE lykn_discover_seen ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own seen"
  ON lykn_discover_seen FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "users write own seen"
  ON lykn_discover_seen FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users delete own seen"
  ON lykn_discover_seen FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
