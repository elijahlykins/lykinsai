// ============================================================================
// rss-service.js — RSS / Atom / JSON-Feed ingestion
// ============================================================================
// Self-contained module imported only by server.js. Provides:
//
//   discoverFeed(url)           — given any URL (page or feed), return the
//                                  canonical feed URL + recent entries preview
//   fetchAndSaveNewEntries(...) — poll one feed, save new items as vault notes
//   pollDueFeeds(...)           — fan out across all due feeds (admin/cron)
//   makeRssPoller(...)          — long-running setInterval for local dev
//
// Entry storage piggy-backs on the existing `notes` table — same shape used by
// /share, drag-drop, and the bookmarklet — so RSS items show up in Vault next
// to everything else with no UI changes downstream.
// ============================================================================

import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Configurable constants
// ---------------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 12_000;
const PREVIEW_ENTRIES = 5;
// Cap how many entries we ever process in one poll — guards against feeds
// that suddenly republish everything (e.g. CMS migrations).
const MAX_ENTRIES_PER_POLL = 50;
// Backoff schedule for feeds that keep failing.
const ERROR_BACKOFF_MIN = [5, 15, 60, 240, 1440]; // last value = 1 day

// `rss-parser` is happy with most real feeds out of the box. The customFields
// teach it about a few things we want to surface in previews.
const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: {
    'User-Agent': 'LYKN-RSS/1.0 (+https://lykn.app)',
    Accept:
      'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml;q=0.9, */*;q=0.8',
  },
  customFields: {
    item: [
      ['media:content', 'mediaContent'],
      ['media:thumbnail', 'mediaThumbnail'],
      ['content:encoded', 'contentEncoded'],
    ],
  },
});

// ---------------------------------------------------------------------------
// Tiny utils
// ---------------------------------------------------------------------------
function withTimeout(promise, ms, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    // Strip common tracking params so equivalent URLs dedupe correctly.
    [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'ref',
    ].forEach((p) => x.searchParams.delete(p));
    x.hash = '';
    return x.toString();
  } catch {
    return u;
  }
}

function hashGuid(guid) {
  // Hex-encoded SHA-256. Stable, bounded, and clean to round-trip through
  // PostgREST as a TEXT column.
  return crypto.createHash('sha256').update(String(guid)).digest('hex');
}

function stripHtml(html, max = 600) {
  if (!html) return '';
  const text = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function pickEntryGuid(item) {
  // `guid` (RSS), `id` (Atom), `link` as fallback. We only need stability,
  // not human-readability, so any of these works.
  return String(item.guid || item.id || item.link || item.title || '').trim();
}

function pickEntryImage(item) {
  if (item.enclosure?.url && /^image\//i.test(item.enclosure.type || ''))
    return item.enclosure.url;
  if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;
  if (item.mediaContent?.$?.url && /^image\//i.test(item.mediaContent.$.medium || item.mediaContent.$.type || ''))
    return item.mediaContent.$.url;
  // Fall back to first <img src> inside the body.
  const html = item['content:encoded'] || item.contentEncoded || item.content || '';
  const m = String(html).match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------
// Feed discovery
// ---------------------------------------------------------------------------
/**
 * Given any URL the user pasted, return:
 *   { feedUrl, siteUrl, title, description, iconUrl, recentEntries: [...] }
 *
 * Three paths:
 *   1. URL is already a feed → parse directly.
 *   2. URL is HTML → look for <link rel="alternate" type="application/rss+xml">.
 *   3. Nothing found → throw.
 */
export async function discoverFeed(rawUrl) {
  const inputUrl = normalizeUrl(rawUrl);
  let urlObj;
  try {
    urlObj = new URL(inputUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!/^https?:$/.test(urlObj.protocol)) {
    throw new Error('Only http(s) URLs are supported');
  }

  // Step 1: GET the URL and inspect content-type.
  const headers = {
    'User-Agent': 'LYKN-RSS/1.0 (+https://lykn.app)',
    Accept:
      'application/rss+xml, application/atom+xml, application/feed+json, text/html;q=0.9, */*;q=0.8',
  };

  let res;
  try {
    res = await withTimeout(fetch(inputUrl, { headers, redirect: 'follow' }), FETCH_TIMEOUT_MS, 'discover');
  } catch (err) {
    throw new Error(`Could not reach ${urlObj.host}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`Source returned HTTP ${res.status}`);
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const text = await res.text();
  const finalUrl = res.url || inputUrl;

  const looksLikeFeed =
    contentType.includes('rss') ||
    contentType.includes('atom') ||
    contentType.includes('xml') ||
    /^\s*<\?xml|^\s*<(rss|feed)\b/i.test(text);

  // Step 2a: Direct feed parse.
  if (looksLikeFeed) {
    const parsed = await parser.parseString(text);
    return shapeDiscovery({
      feedUrl: normalizeUrl(finalUrl),
      siteUrl: parsed.link || urlObj.origin,
      parsed,
    });
  }

  // Step 2b: HTML — look for <link rel="alternate"> entries.
  const $ = cheerio.load(text);
  const candidates = [];
  $('link[rel="alternate"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    const href = $(el).attr('href');
    if (!href) return;
    if (type.includes('rss') || type.includes('atom') || type.includes('feed+json')) {
      // Resolve relative URLs against finalUrl.
      let abs;
      try {
        abs = new URL(href, finalUrl).toString();
      } catch {
        return;
      }
      candidates.push({ href: abs, type, title: $(el).attr('title') || '' });
    }
  });

  if (!candidates.length) {
    throw new Error(
      "No RSS or Atom feed found on this page. Try pasting the feed URL directly (often /feed, /rss, or /atom.xml).",
    );
  }

  // Prefer atom > rss > json, but accept the first usable one.
  candidates.sort((a, b) => rankFeedType(a.type) - rankFeedType(b.type));
  for (const cand of candidates) {
    try {
      const feed = await parser.parseURL(cand.href);
      return shapeDiscovery({
        feedUrl: normalizeUrl(cand.href),
        siteUrl: finalUrl,
        parsed: feed,
        // Surface the page favicon as a fallback for feeds without one.
        fallbackIcon: faviconFor(finalUrl),
      });
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('Found feed link(s) but none could be parsed.');
}

function rankFeedType(t) {
  if (t.includes('atom')) return 0;
  if (t.includes('rss')) return 1;
  if (t.includes('feed+json')) return 2;
  return 3;
}

function faviconFor(pageUrl) {
  try {
    const u = new URL(pageUrl);
    return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
  } catch {
    return '';
  }
}

function shapeDiscovery({ feedUrl, siteUrl, parsed, fallbackIcon }) {
  const items = (parsed.items || []).slice(0, PREVIEW_ENTRIES).map((it) => ({
    title: it.title || '(untitled)',
    link: it.link || '',
    pubDate: it.isoDate || it.pubDate || null,
    summary: stripHtml(it.contentSnippet || it.content || it.summary || '', 240),
    image: pickEntryImage(it),
  }));
  return {
    feedUrl,
    siteUrl: parsed.link || siteUrl,
    title: parsed.title || '(untitled feed)',
    description: stripHtml(parsed.description || '', 300),
    iconUrl: parsed.image?.url || fallbackIcon || faviconFor(siteUrl),
    recentEntries: items,
  };
}

// ---------------------------------------------------------------------------
// Saving entries to the vault (mirrors saveLinkToVault server-side)
// ---------------------------------------------------------------------------
/**
 * Insert one feed entry as a `notes` row using the service-role client.
 * Returns the new note id, or null if skipped (duplicate or insert failed).
 */
async function saveEntryAsNote({ supabaseAdmin, userId, feed, item }) {
  const url = normalizeUrl(item.link || '');
  if (!url) return null;

  // Cheap pre-check against `notes` to avoid double-saving when the user
  // saved this URL earlier via /share, drag-drop, etc. Same check shape as
  // saveLinkToVault on the client.
  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .ilike('content', `%${url}%`)
    .limit(1);
  if (existing && existing.length > 0) return null;

  const title = (item.title || feed.title || url).slice(0, 280);
  const description = stripHtml(
    item.contentSnippet || item.content || item.summary || '',
    1200,
  );
  const image = pickEntryImage(item);
  const pubDate = item.isoDate || item.pubDate || null;
  const author = item.creator || item.author || '';
  const sourceLabel = feed.title || feed.site_url || feed.feed_url;

  // Match the attachment shape produced by /api/unfurl so the existing
  // bookmark renderer in the vault picks it up with no special-case code.
  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: image || '',
    favicon: feed.icon_url || faviconFor(url),
    siteName: sourceLabel || '',
    articleText: description,
    oembedType: 'rss',
    oembedHtml: '',
    authorName: author,
    authorHandle: '',
  };

  const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

  const { data: inserted, error } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: userId,
      title,
      content: noteContent,
      source: 'rss',
      tags: ['rss', 'link', 'uploaded'],
      created_at: pubDate ? new Date(pubDate).toISOString() : undefined,
    })
    .select('id')
    .single();

  if (error) {
    // Fall back to a minimal insert if the schema doesn't have all columns.
    const { data: minimal, error: err2 } = await supabaseAdmin
      .from('notes')
      .insert({ user_id: userId, title, content: noteContent })
      .select('id')
      .single();
    if (err2) {
      console.error(`[rss] note insert failed for feed=${feed.id}:`, err2.message);
      return null;
    }
    return minimal.id;
  }
  return inserted.id;
}

// ---------------------------------------------------------------------------
// Per-feed poll
// ---------------------------------------------------------------------------
/**
 * Fetch a single feed (with conditional GET), parse it, and save any new
 * entries as vault notes. Updates the rss_feeds row with cache headers,
 * status, and last_*_at timestamps in one call at the end.
 *
 * Returns { saved: <count>, skipped: <count>, status: '304'|'ok'|'error' }.
 */
export async function fetchAndSaveNewEntries({ supabaseAdmin, feed }) {
  const headers = {
    'User-Agent': 'LYKN-RSS/1.0 (+https://lykn.app)',
    Accept:
      'application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.8',
  };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  let res;
  try {
    res = await withTimeout(
      fetch(feed.feed_url, { headers, redirect: 'follow' }),
      FETCH_TIMEOUT_MS,
      'rss-fetch',
    );
  } catch (err) {
    await markFeedError(supabaseAdmin, feed, err.message || 'fetch failed');
    return { saved: 0, skipped: 0, status: 'error' };
  }

  // 304 Not Modified — nothing changed since last poll. Cheapest path.
  if (res.status === 304) {
    await supabaseAdmin
      .from('rss_feeds')
      .update({
        last_fetched_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        consecutive_errors: 0,
        status: 'active',
        last_error: null,
      })
      .eq('id', feed.id);
    return { saved: 0, skipped: 0, status: '304' };
  }

  if (!res.ok) {
    await markFeedError(supabaseAdmin, feed, `HTTP ${res.status}`);
    return { saved: 0, skipped: 0, status: 'error' };
  }

  const newEtag = res.headers.get('etag') || null;
  const newLastModified = res.headers.get('last-modified') || null;
  const text = await res.text();

  let parsed;
  try {
    parsed = await parser.parseString(text);
  } catch (err) {
    await markFeedError(supabaseAdmin, feed, `parse: ${err.message}`);
    return { saved: 0, skipped: 0, status: 'error' };
  }

  const allItems = (parsed.items || []).slice(0, MAX_ENTRIES_PER_POLL);
  // Newest-first ordering — most feeds publish that way; sort to be safe.
  allItems.sort((a, b) => {
    const da = new Date(a.isoDate || a.pubDate || 0).getTime();
    const db = new Date(b.isoDate || b.pubDate || 0).getTime();
    return db - da;
  });

  // First poll? Cap to initial_backfill_count.
  const isFirstPoll = !feed.last_success_at;
  const itemsToConsider = isFirstPoll
    ? allItems.slice(0, feed.initial_backfill_count || 0)
    : allItems;

  // Filter out anything we've already saved (per-feed GUID dedupe). One
  // round trip to ask "which of these guid hashes have we seen?".
  const guids = itemsToConsider.map((it) => hashGuid(pickEntryGuid(it)));
  let alreadySeen = new Set();
  if (guids.length) {
    const { data: seen } = await supabaseAdmin
      .from('rss_seen_entries')
      .select('guid_hash')
      .eq('feed_id', feed.id)
      .in('guid_hash', guids);
    if (seen) alreadySeen = new Set(seen.map((r) => r.guid_hash));
  }

  let saved = 0;
  let skipped = 0;
  let newestPub = feed.last_entry_pub_at ? new Date(feed.last_entry_pub_at) : null;

  for (const item of itemsToConsider) {
    const guidHash = hashGuid(pickEntryGuid(item));
    if (alreadySeen.has(guidHash)) {
      skipped++;
      continue;
    }

    const noteId = await saveEntryAsNote({ supabaseAdmin, userId: feed.user_id, feed, item });

    // Record the GUID even if save was skipped (existing note); prevents
    // retrying it on every poll. Upsert with ignoreDuplicates so a race
    // between two pollers doesn't 23505.
    await supabaseAdmin
      .from('rss_seen_entries')
      .upsert(
        { feed_id: feed.id, guid_hash: guidHash, note_id: noteId },
        { onConflict: 'feed_id,guid_hash', ignoreDuplicates: true },
      );

    if (noteId) saved++;
    else skipped++;

    const pub = new Date(item.isoDate || item.pubDate || 0);
    if (!isNaN(pub) && (!newestPub || pub > newestPub)) newestPub = pub;
  }

  await supabaseAdmin
    .from('rss_feeds')
    .update({
      etag: newEtag,
      last_modified: newLastModified,
      last_fetched_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      last_entry_pub_at: newestPub ? newestPub.toISOString() : feed.last_entry_pub_at,
      title: feed.title || parsed.title || null,
      description: feed.description || stripHtml(parsed.description || '', 300) || null,
      consecutive_errors: 0,
      status: 'active',
      last_error: null,
    })
    .eq('id', feed.id);

  return { saved, skipped, status: 'ok' };
}

async function markFeedError(supabaseAdmin, feed, message) {
  const consecutive = (feed.consecutive_errors || 0) + 1;
  await supabaseAdmin
    .from('rss_feeds')
    .update({
      last_fetched_at: new Date().toISOString(),
      consecutive_errors: consecutive,
      status: consecutive >= 3 ? 'error' : feed.status || 'active',
      last_error: String(message).slice(0, 500),
    })
    .eq('id', feed.id);
}

// ---------------------------------------------------------------------------
// Fan-out across all due feeds
// ---------------------------------------------------------------------------
/**
 * Returns the list of feeds whose last_fetched_at is older than their
 * configured interval (or never fetched). Skips paused feeds. Errored
 * feeds get a longer cooldown via ERROR_BACKOFF_MIN.
 */
async function selectDueFeeds(supabaseAdmin, limit = 50) {
  const { data, error } = await supabaseAdmin
    .from('rss_feeds')
    .select('*')
    .in('status', ['pending', 'active', 'error'])
    .order('last_fetched_at', { ascending: true, nullsFirst: true })
    .limit(limit * 2); // overfetch; we filter below

  if (error || !data) return [];
  const now = Date.now();
  return data.filter((f) => {
    if (f.status === 'paused') return false;
    if (!f.last_fetched_at) return true;
    let intervalMin = f.poll_interval_minutes || 30;
    if (f.status === 'error') {
      const idx = Math.min((f.consecutive_errors || 1) - 1, ERROR_BACKOFF_MIN.length - 1);
      intervalMin = Math.max(intervalMin, ERROR_BACKOFF_MIN[idx]);
    }
    const due = new Date(f.last_fetched_at).getTime() + intervalMin * 60_000;
    return now >= due;
  }).slice(0, limit);
}

/**
 * Poll up to `limit` feeds that are due. Used by both the in-process
 * setInterval loop (dev) and the `POST /api/feeds/poll-due` endpoint
 * (admin / cron).
 */
export async function pollDueFeeds({ supabaseAdmin, limit = 25 }) {
  const feeds = await selectDueFeeds(supabaseAdmin, limit);
  if (!feeds.length) return { polled: 0, totalSaved: 0 };

  let totalSaved = 0;
  for (const feed of feeds) {
    try {
      const result = await fetchAndSaveNewEntries({ supabaseAdmin, feed });
      totalSaved += result.saved;
      if (result.saved > 0) {
        console.log(`[rss] polled "${feed.title || feed.feed_url}" → +${result.saved} note(s)`);
      }
    } catch (err) {
      console.error(`[rss] poll failed for ${feed.feed_url}:`, err.message);
    }
  }
  return { polled: feeds.length, totalSaved };
}

// ---------------------------------------------------------------------------
// Long-running poller (dev / single-instance deployments)
// ---------------------------------------------------------------------------
export function makeRssPoller({ supabaseAdmin, intervalMs = 60_000 }) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await pollDueFeeds({ supabaseAdmin, limit: 25 });
    } catch (err) {
      console.error('[rss] poller tick error:', err.message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  return {
    start() {
      if (timer) return;
      // First tick a few seconds after boot so it doesn't compete with
      // request handling startup.
      timer = setTimeout(tick, 5_000);
      console.log(`→ RSS poller: ✅ enabled (every ${Math.round(intervalMs / 1000)}s)`);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
