// ============================================================================
// connectors/amazon-wishlist.js — Amazon Wishlist adapter (public RSS)
// ============================================================================
// Amazon has no first-party Wishlist API. For public wishlists, however,
// the legacy registry RSS endpoint at
//
//   https://www.amazon.com/registry/wishlist/<LIST_ID>/rss
//
// still serves (in inconsistent regions). When that URL works, items are
// returned as standard RSS items with title/link/description fields, and
// each link points at the underlying product page.
//
// To paper over Amazon's flakiness across regions, this adapter is built
// as a generic "wishlist-as-RSS" tile:
//
//   • If the user pastes a full RSS URL (Amazon's or a third-party bridge
//     like wishlistrss or a self-hosted scraper), we use it as-is.
//   • If the user pastes a wishlist URL or just a LIST_ID, we'll try to
//     build the canonical Amazon URL for them.
//
// This way the tile keeps working even if Amazon drops its RSS endpoint
// entirely — the user just points us at any feed that exposes their list.
//
// Auth: none. RSS is unauthenticated.
// ============================================================================

import { saveConnectorNote } from './_save.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS_PER_SYNC = 200;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function buildFeedUrl(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  // Already an RSS URL → pass through.
  if (/\.rss(\?|$)|\/rss(\/|$|\?)/i.test(input)) return input;
  // Looks like a bare list id (alphanumeric 10–40 chars).
  if (/^[A-Z0-9]{10,40}$/i.test(input)) {
    return `https://www.amazon.com/registry/wishlist/${input}/rss`;
  }
  // Try to extract a LIST_ID from a paste like
  // https://www.amazon.com/hz/wishlist/ls/XXXXXXXX...
  const m =
    input.match(/\/wishlist\/(?:ls\/)?([A-Z0-9]{10,40})/i) ||
    input.match(/\/registry\/wishlist\/([A-Z0-9]{10,40})/i);
  if (m) return `https://www.amazon.com/registry/wishlist/${m[1]}/rss`;
  return input;
}

async function fetchFeed(url) {
  const res = await withTimeout(
    fetch(url, {
      headers: {
        'User-Agent': 'LYKN-Connector/1.0 (+https://lykn.ai)',
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    }),
    FETCH_TIMEOUT_MS,
    'amazon-wishlist-feed',
  );
  if (!res.ok) throw new Error(`Amazon wishlist feed: HTTP ${res.status}`);
  return res.text();
}

export const amazonWishlistAdapter = {
  id: 'amazon-wishlist',
  authMode: 'token',

  async connectWithToken({ fields }) {
    const feedUrl = buildFeedUrl(fields?.feed || fields?.list_id || fields?.token);
    if (!feedUrl) throw new Error('Amazon wishlist URL, RSS feed, or list ID is required.');

    const xml = await fetchFeed(feedUrl).catch(() => '');
    const items = parseItems(xml);
    if (items.length === 0) {
      throw new Error(
        'No items found at that wishlist feed. Make sure the wishlist is set to public.',
      );
    }

    const channelTitle =
      (xml.match(/<title>([^<]+)<\/title>/) || [])[1] || 'Amazon Wishlist';
    const fp = await fingerprint(feedUrl);

    return {
      providerUserId: `amz_${fp}`,
      accessToken: feedUrl,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['wishlist:read'],
      account: {
        handle: channelTitle.slice(0, 40),
        displayName: channelTitle.slice(0, 60),
        email: null,
        avatarUrl: null,
      },
      metadata: {
        feed_url: feedUrl,
        // ISO of the most recent pubDate we saved.
        last_seen_at: null,
      },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const feedUrl = meta.feed_url || accessToken;
    if (!feedUrl) throw new Error('Amazon wishlist connection is missing its feed URL.');

    const xml = await fetchFeed(feedUrl);
    const items = parseItems(xml).slice(0, MAX_ITEMS_PER_SYNC);

    const cursorIso = meta.last_seen_at || null;
    const cursorDate = cursorIso ? new Date(cursorIso) : null;

    let saved = 0;
    let skipped = 0;
    let newest = cursorDate;

    for (const item of items) {
      const itemDate = item.pubDate ? new Date(item.pubDate) : null;
      if (cursorDate && itemDate && itemDate <= cursorDate) continue;

      const result = await saveWishlistItemAsNote({
        supabaseAdmin,
        userId: connection.user_id,
        item,
      });
      if (result === 'saved' || result === 'updated') saved++;
      else skipped++;

      if (itemDate && (!newest || itemDate > newest)) newest = itemDate;
    }

    if (newest && (!cursorDate || newest > cursorDate)) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: { ...meta, last_seen_at: newest.toISOString() },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save one wishlist RSS item as a vault note
// ---------------------------------------------------------------------------
async function saveWishlistItemAsNote({ supabaseAdmin, userId, item }) {
  const url = item.link || '';
  if (!url) return 'skipped';

  const title = (item.title || 'Wishlist item').trim();
  const description = (item.description || '')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 1500);

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://www.amazon.com/favicon.ico',
    siteName: 'Amazon Wishlist',
    articleText: description,
    oembedType: 'amazon-wishlist',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  const tags = ['amazon', 'wishlist', 'link', 'uploaded'];

  const createdAt = item.pubDate
    ? new Date(item.pubDate).toISOString()
    : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'amazon_wishlist',
    createdAt,
    body: description,
    embedMetadata: { source: 'amazon_wishlist', title, url },
  });
}

// ---------------------------------------------------------------------------
function parseItems(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    items.push({
      title: pickCdataOrText(block, 'title'),
      link: pickCdataOrText(block, 'link'),
      pubDate: pickCdataOrText(block, 'pubDate'),
      description: pickCdataOrText(block, 'description'),
    });
  }
  return items;
}

function pickCdataOrText(block, tag) {
  const re = new RegExp(
    `<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*<\\/${tag}>`,
    'i',
  );
  const m = block.match(re);
  if (!m) return '';
  return (m[1] || m[2] || '').trim();
}

async function fingerprint(input) {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
}
