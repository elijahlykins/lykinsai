# Discover Feed — Ops Notes

Discover is now a Perplexity-style content index: the server crawls Serper /
YouTube on a schedule and writes results into Supabase, and the per-user feed
reads from those tables (with a live-API fallback when DB coverage is thin).

This doc covers (1) applying the schema migration and (2) wiring up the
periodic ingest job.

## 1. Apply the migration

The migration file is `supabase-migrations/035_discover_index.sql`. It creates:

- `lykn_discover_articles` — global article index (RLS: read-only for
  authenticated users; writes via service role only)
- `lykn_discover_videos` — global video index (same RLS)
- `lykn_discover_seen` — per-user "already seen" tracking (RLS: per-user)

Apply it in the Supabase dashboard:

1. Open the project → **SQL Editor** → **New query**
2. Paste the contents of `035_discover_index.sql`
3. Run

Or via the Supabase CLI if you use it:

```bash
supabase db push
```

## 2. Ingest endpoint

`POST /api/discover/ingest` is bearer-secret-auth'd. It:

- Reads the union of all users' synthesis themes (capped at 50, plus a few
  defaults so the index is never empty)
- Fans out 5 themes at a time to Serper `/news` + Serper `/search` +
  YouTube `search.list`
- Enriches videos with `videos.list` (view counts, durations) and drops
  Shorts / 4h+ uploads / low-view items
- Backfills missing `og:image` thumbnails for the strongest articles
- Upserts results into `lykn_discover_articles` / `lykn_discover_videos`
  (`ON CONFLICT (url|video_id)` → refreshes scores + topic_tags)
- Generates 1-sentence editorial blurbs (`ai_takeaway`) for the top 80
  items lacking one (uses `gpt-4o-mini`)
- Prunes rows older than 14 days

The endpoint requires:

- `DISCOVER_INGEST_SECRET` env var on the server (8+ chars)
- `SUPABASE_SERVICE_ROLE_KEY` env var on the server
- `SERPER_API_KEY` and/or `YOUTUBE_API_KEY`
- `OPENAI_API_KEY` (for the takeaway blurbs; without it ingest still
  runs, just no blurbs)

Manual trigger (smoke test):

```bash
curl -X POST https://your-server/api/discover/ingest \
  -H "Authorization: Bearer $DISCOVER_INGEST_SECRET" \
  -H "Content-Type: application/json"
```

You should get back something like:

```json
{
  "ok": true,
  "themes": 12,
  "articlesUpserted": 280,
  "videosUpserted": 145,
  "takeawaysGenerated": 60,
  "prunedArticles": 0,
  "prunedVideos": 0,
  "elapsedMs": 42130
}
```

## 3. Wiring up the cron

### Recommended: Supabase pg_cron + pg_net

Free, no external dep, works regardless of your backend host. Run this once
in the Supabase SQL editor:

```sql
-- Enable extensions (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Drop a previous schedule if you're re-running this
SELECT cron.unschedule('lykn-discover-ingest')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lykn-discover-ingest');

-- Schedule: every 4 hours, at minute 7 (off-the-hour avoids contention)
SELECT cron.schedule(
  'lykn-discover-ingest',
  '7 */4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_BACKEND_HOST/api/discover/ingest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer YOUR_DISCOVER_INGEST_SECRET',
      'Content-Type',  'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
```

Replace `YOUR_BACKEND_HOST` with your Render URL (e.g.
`https://lykn-ideation.onrender.com`) and `YOUR_DISCOVER_INGEST_SECRET` with
the value from your `.env`.

Inspect runs:

```sql
SELECT * FROM cron.job_run_details
WHERE jobname = 'lykn-discover-ingest'
ORDER BY start_time DESC
LIMIT 20;
```

### Alternative: GitHub Actions

If you'd rather keep it in version control, drop this in
`.github/workflows/discover-ingest.yml`:

```yaml
name: Discover ingest
on:
  schedule:
    - cron: "7 */4 * * *"
  workflow_dispatch:
jobs:
  ingest:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST "$URL/api/discover/ingest" \
            -H "Authorization: Bearer $SECRET" \
            -H "Content-Type: application/json" \
            --max-time 180
        env:
          URL: ${{ secrets.BACKEND_URL }}
          SECRET: ${{ secrets.DISCOVER_INGEST_SECRET }}
```

### Alternative: Render cron job

If you're already on Render, you can add a cron service in `render.yaml`:

```yaml
- type: cron
  name: lykn-discover-ingest
  schedule: "7 */4 * * *"
  buildCommand: ""
  startCommand: |
    curl -fsS -X POST "$BACKEND_URL/api/discover/ingest" \
      -H "Authorization: Bearer $DISCOVER_INGEST_SECRET" \
      --max-time 180
  envVars:
    - key: BACKEND_URL
      value: https://lykn-ideation.onrender.com
    - key: DISCOVER_INGEST_SECRET
      sync: false
```

## 4. Cost notes (per ingest run)

With 50 unique themes per run, every 4h:

- **Serper**: ~100 requests/run (50 `/news` + 50 `/search`) → 600/day → ~18k/mo.
  Serper Starter is $50/mo for 50k requests.
- **YouTube**: 50 `search.list` (100 quota each) + 1 `videos.list` (1 quota) =
  5,001 quota/run → 30,006/day. YouTube's daily quota cap is 10,000 by
  default — you'll need a quota increase, or drop to every 8h, or cap
  themes at ~25.
- **OpenAI**: `gpt-4o-mini` for ~80 blurbs/run → ~$0.01/run → ~$2/mo.

Tune `DISCOVER_INGEST_THEMES_CAP` (server.js) and the cron cadence to fit
your budget.
