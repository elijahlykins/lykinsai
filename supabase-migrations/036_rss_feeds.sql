-- ============================================
-- LYKN RSS / Atom feed subscriptions
-- Migration: 036_rss_feeds.sql
-- ============================================
-- The first real "pull"-style connector. Each row is a feed a user has
-- subscribed to; a server-side poll loop walks the table, fetches each
-- feed (with conditional GET), parses it, and writes new entries to the
-- existing `notes` table via saveLinkToVault-style logic.
--
-- Design decisions:
--   * Per-user dedupe by (user_id, feed_url) — the same blog can be
--     subscribed to by every user independently.
--   * Conditional GET via etag + last_modified to keep poll cost near
--     zero for unchanged feeds.
--   * `rss_seen_entries` is a small (feed_id, guid) table — much more
--     reliable dedupe than pubDate alone, since plenty of feeds republish
--     items with new timestamps. We hash the guid to keep the index small
--     and bounded for feeds with weird/long guids.
--   * `initial_backfill_count` controls how many items we save the first
--     poll, so adding a feed with 1000 entries doesn't drop 1000 notes
--     into someone's vault.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- rss_feeds — one row per subscription
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rss_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Canonical feed URL we actually fetch (RSS 2.0, Atom, or JSON Feed).
  feed_url TEXT NOT NULL,
  -- The original page the user pasted (may differ from feed_url when we
  -- autodiscovered the feed via <link rel="alternate">). Display only.
  site_url TEXT,

  title TEXT,
  description TEXT,
  icon_url TEXT,                          -- favicon for the source

  -- HTTP cache headers from the last successful fetch — used to send
  -- If-Modified-Since / If-None-Match on subsequent polls.
  etag TEXT,
  last_modified TEXT,

  last_fetched_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_entry_pub_at TIMESTAMPTZ,          -- newest entry pubDate we've seen

  -- How often we poll. We default to 30 min; users can pause via status.
  poll_interval_minutes INT NOT NULL DEFAULT 30
    CHECK (poll_interval_minutes >= 5 AND poll_interval_minutes <= 1440),

  -- Lifecycle:
  --   pending  → just created, never polled
  --   active   → polling normally
  --   paused   → user disabled it; skipped by poller
  --   error    → repeated failures; backed off but still retried
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'paused', 'error')),
  consecutive_errors INT NOT NULL DEFAULT 0,
  last_error TEXT,

  -- On the very first poll we save up to this many recent entries; after
  -- that it's strictly new-entries-only. Set to 0 to skip backfill.
  initial_backfill_count INT NOT NULL DEFAULT 5
    CHECK (initial_backfill_count >= 0 AND initial_backfill_count <= 50),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Same user can't subscribe to the exact same feed URL twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_feeds_user_feed
  ON rss_feeds (user_id, feed_url);

-- Poller scans by "due to be polled": active feeds whose last_fetched_at
-- is older than now() - poll_interval. This composite serves it well.
CREATE INDEX IF NOT EXISTS idx_rss_feeds_due
  ON rss_feeds (status, last_fetched_at NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_rss_feeds_user
  ON rss_feeds (user_id, created_at DESC);

ALTER TABLE rss_feeds ENABLE ROW LEVEL SECURITY;

-- All client traffic for this table is brokered through the Express
-- server using the service role; we still want RLS on for safety in case
-- someone hits the table from the anon client.
CREATE POLICY "users read own rss feeds"
  ON rss_feeds FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "users insert own rss feeds"
  ON rss_feeds FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users update own rss feeds"
  ON rss_feeds FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "users delete own rss feeds"
  ON rss_feeds FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- rss_seen_entries — per-feed GUID dedupe
-- ---------------------------------------------------------------------------
-- We don't store full entry contents here (those go to `notes` directly).
-- This is just a tiny lookup so we can ask "have we already saved this
-- entry?" without scanning notes for every fetched item.
CREATE TABLE IF NOT EXISTS rss_seen_entries (
  feed_id UUID NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
  -- We hash whatever stable id the feed provides (guid > id > link) and
  -- store the SHA-256 as a fixed-width hex string. Bounded size, easy to
  -- query through PostgREST, and stable across feed quirks.
  guid_hash TEXT NOT NULL,
  note_id UUID,                            -- the resulting vault note, if saved
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (feed_id, guid_hash)
);

ALTER TABLE rss_seen_entries ENABLE ROW LEVEL SECURITY;

-- Only the service role writes here; reads go through the server too.
-- Provide a SELECT policy so a user could in principle query their own
-- history (for an "items saved by this feed" view down the line).
CREATE POLICY "users read own rss seen"
  ON rss_seen_entries FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM rss_feeds f
      WHERE f.id = rss_seen_entries.feed_id
        AND f.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- updated_at trigger for rss_feeds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION rss_feeds_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rss_feeds_updated_at ON rss_feeds;
CREATE TRIGGER rss_feeds_updated_at
  BEFORE UPDATE ON rss_feeds
  FOR EACH ROW
  EXECUTE FUNCTION rss_feeds_set_updated_at();
