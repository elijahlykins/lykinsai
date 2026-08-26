// ============================================================================
// server/routes/feeds.routes.js — RSS/Atom feeds + poll-due cron endpoints
// ============================================================================
// Extracted verbatim from server.js (Wave 1 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.
//
// The poll-due trio (/api/feeds/poll-due, /api/connections/poll-due,
// /api/ai/cursor-builds/poll-due) is an EXTERNAL cron contract: paths and
// Bearer shared-secret semantics are frozen. verifyAdminIngestSecret moved
// here because these three routes are its only callers.
//
// The in-process RSS/connector/cursor-build pollers do NOT live here — they
// stay in server.js's app.listen callback (identical startup timing).

import crypto from 'crypto';
import { z, validate } from '../../validation.js';
import {
  discoverFeed,
  fetchAndSaveNewEntries,
  pollDueFeeds,
} from '../../rss-service.js';
import { pollDueConnections } from '../../connectors-service.js';
import { pollRunningBuilds } from '../../lib/cursor/cursorBuilds.js';

/**
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons. Identity matters:
 *   supabaseAdmin is the shared service client; requireAuth/isUrlSafe are
 *   the same functions every other route uses.
 */
export function registerFeedsRoutes(app, {
  requireAuth,
  supabaseAdmin,
  isUrlSafe,
}) {
  // ============================================
  // RSS / ATOM FEEDS
  // ============================================
  // Pull-style connector. The user pastes any URL — site or feed — and we
  // auto-discover the canonical feed, store the subscription, and a background
  // poller fetches new entries on a schedule, dropping each one into `notes`
  // in the same shape that /share + the bookmarklet produce.

  app.post('/api/feeds/discover', requireAuth, async (req, res) => {
    try {
      const { url } = req.body || {};
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Missing url' });
      }
      if (!(await isUrlSafe(url))) {
        return res.status(400).json({ error: 'URL not allowed' });
      }
      const result = await discoverFeed(url);
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ error: 'Could not discover feed' });
    }
  });

  app.get('/api/feeds', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { data, error } = await supabaseAdmin
        .from('rss_feeds')
        .select(
          'id, feed_url, site_url, title, description, icon_url, status, ' +
          'last_fetched_at, last_success_at, last_entry_pub_at, ' +
          'poll_interval_minutes, consecutive_errors, last_error, created_at',
        )
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) { console.error('[supabase]', req.method, req.path, error); return res.status(500).json({ error: 'database_error' }); }

      // Annotate each feed with a count of items saved so far.
      const ids = (data || []).map((f) => f.id);
      let counts = {};
      if (ids.length) {
        // Supabase JS doesn't yet support GROUP BY directly; fall back to a
        // small per-feed query. Cheap because most users will have <20 feeds.
        const results = await Promise.all(
          ids.map(async (id) => {
            const { count } = await supabaseAdmin
              .from('rss_seen_entries')
              .select('*', { count: 'exact', head: true })
              .eq('feed_id', id)
              .not('note_id', 'is', null);
            return [id, count || 0];
          }),
        );
        counts = Object.fromEntries(results);
      }

      return res.json({
        feeds: (data || []).map((f) => ({ ...f, items_saved: counts[f.id] || 0 })),
      });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to list feeds' });
    }
  });

  // SECURITY (Agent 04): Zod schema strips unknown fields and enforces types
  // before any Supabase call. Replaces the prior hand-rolled if/typeof checks.
  const createFeedSchema = z.object({
    url: z.string().min(1).max(2048),
    initialBackfillCount: z.number().int().min(0).max(50).optional(),
  });

  app.post('/api/feeds', requireAuth, validate(createFeedSchema), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { url, initialBackfillCount } = req.body;
      if (!(await isUrlSafe(url))) {
        return res.status(400).json({ error: 'URL not allowed' });
      }

      // Re-discover on save so we always store the canonical feed_url, and
      // we get the initial title/description/icon for free.
      const discovery = await discoverFeed(url);

      const backfill = Math.max(
        0,
        Math.min(50, Number.isFinite(initialBackfillCount) ? initialBackfillCount : 5),
      );

      const { data: feed, error } = await supabaseAdmin
        .from('rss_feeds')
        .insert({
          user_id: userId,
          feed_url: discovery.feedUrl,
          site_url: discovery.siteUrl,
          title: discovery.title,
          description: discovery.description,
          icon_url: discovery.iconUrl,
          initial_backfill_count: backfill,
          status: 'pending',
        })
        .select('*')
        .single();

      if (error) {
        // Unique violation = already subscribed.
        if (error.code === '23505') {
          return res.status(409).json({ error: 'Already subscribed to this feed' });
        }
        console.error('[supabase] POST /api/feeds insert', error);
        return res.status(500).json({ error: 'database_error' });
      }

      // Kick off the first poll right away so the user sees immediate value.
      // Run async without blocking the response.
      fetchAndSaveNewEntries({ supabaseAdmin, feed }).catch((e) =>
        console.error(`[rss] initial poll failed for ${feed.feed_url}:`, e.message),
      );

      return res.json({ feed, preview: discovery.recentEntries });
    } catch (err) {
      return res.status(400).json({ error: 'Could not add feed' });
    }
  });

  // SECURITY (Agent 04): Zod schema strips unknown fields and clamps the
  // poll-interval to its declared range before any DB call.
  const patchFeedSchema = z.object({
    status: z.enum(['active', 'paused']).optional(),
    poll_interval_minutes: z.number().int().min(5).max(1440).optional(),
  }).refine(
    (v) => v.status !== undefined || v.poll_interval_minutes !== undefined,
    { message: 'Nothing to update' },
  );

  app.patch('/api/feeds/:id', requireAuth, validate(patchFeedSchema), async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { id } = req.params;
      const allowed = {};
      if (req.body.status !== undefined) allowed.status = req.body.status;
      if (req.body.poll_interval_minutes !== undefined) {
        allowed.poll_interval_minutes = req.body.poll_interval_minutes;
      }

      const { data, error } = await supabaseAdmin
        .from('rss_feeds')
        .update(allowed)
        .eq('id', id)
        .eq('user_id', userId)
        .select('*')
        .single();

      if (error) { console.error('[supabase]', req.method, req.path, error); return res.status(500).json({ error: 'database_error' }); }
      if (!data) return res.status(404).json({ error: 'Feed not found' });
      return res.json({ feed: data });
    } catch (err) {
      return res.status(500).json({ error: 'Update failed' });
    }
  });

  app.delete('/api/feeds/:id', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { id } = req.params;
      const { error } = await supabaseAdmin
        .from('rss_feeds')
        .delete()
        .eq('id', id)
        .eq('user_id', userId);

      if (error) { console.error('[supabase]', req.method, req.path, error); return res.status(500).json({ error: 'database_error' }); }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'Delete failed' });
    }
  });

  app.post('/api/feeds/:id/refresh', requireAuth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Not authenticated' });
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const { id } = req.params;
      const { data: feed, error } = await supabaseAdmin
        .from('rss_feeds')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

      if (error || !feed) return res.status(404).json({ error: 'Feed not found' });

      const result = await fetchAndSaveNewEntries({ supabaseAdmin, feed });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Refresh failed' });
    }
  });

  // Admin / cron endpoint shared-secret verification. Mirrors the shape of
  // verifyBackfillSecret / verifyDiscoverIngestSecret — same Bearer header
  // extraction, same `crypto.timingSafeEqual` constant-time compare. Plain
  // `===` / `!==` on a long-lived cron secret leaks one byte at a time on a
  // network with measurable jitter; timingSafeEqual closes that side channel.
  // Falls back from ADMIN_INGEST_SECRET → DISCOVER_INGEST_SECRET so the same
  // cron config keeps working across deploys that haven't been migrated to
  // the dedicated env var yet.
  function verifyAdminIngestSecret(req) {
    const expected = process.env.ADMIN_INGEST_SECRET || process.env.DISCOVER_INGEST_SECRET;
    if (!expected || String(expected).length < 32) return false;
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return false;
    try {
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(String(expected), 'utf8');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  // Admin / cron endpoint: poll every feed that's currently due. Protected by
  // the same shared secret used by /api/discover/ingest.
  app.post('/api/feeds/poll-due', async (req, res) => {
    try {
      if (!verifyAdminIngestSecret(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const limit = Math.max(1, Math.min(200, Number(req.body?.limit) || 25));
      const result = await pollDueFeeds({ supabaseAdmin, limit });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Poll failed' });
    }
  });

  // Admin / cron endpoint: poll every connector that's currently due. Mirrors
  // the RSS `POST /api/feeds/poll-due` endpoint, protected by the same shared
  // secret. This is the entry point a serverless deployment (Vercel / Lambda /
  // Netlify) hits on a 1-minute cron, since `setInterval` doesn't survive
  // between requests there. Long-lived hosts (Render, self-hosted) get the
  // same fan-out via `makeConnectorPoller` below; this endpoint is the
  // fallback path for environments where the in-process poller is disabled.
  app.post('/api/connections/poll-due', async (req, res) => {
    try {
      if (!verifyAdminIngestSecret(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });

      const limit = Math.max(1, Math.min(100, Number(req.body?.limit) || 25));
      const result = await pollDueConnections({ supabaseAdmin, limit });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: 'Poll failed' });
    }
  });

  // Admin / cron endpoint: sync in-flight Cursor cloud-agent builds. Serverless
  // fallback for the in-process poller (which Render/self-hosted run on an
  // interval). Same shared-secret auth as the other poll-due endpoints.
  app.post('/api/ai/cursor-builds/poll-due', async (req, res) => {
    try {
      if (!verifyAdminIngestSecret(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (!supabaseAdmin) return res.status(503).json({ error: 'Database unavailable' });
      const result = await pollRunningBuilds(supabaseAdmin);
      let stewardSync = { synced: 0, completed: 0 };
      try {
        const { syncStewardDelegations } = await import('../../lib/nightShift/stewardCompletion.js');
        stewardSync = await syncStewardDelegations(supabaseAdmin);
      } catch (e) {
        console.warn('[cursor-builds poll-due] steward sync:', e?.message || e);
      }
      return res.json({ ok: true, ...result, steward: stewardSync });
    } catch (err) {
      return res.status(500).json({ error: 'Poll failed' });
    }
  });
}
