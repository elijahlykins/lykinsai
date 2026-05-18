// ============================================================================
// connectors/goodreads.js — Goodreads adapter (public RSS shelves)
// ============================================================================
// Goodreads retired its public REST API in 2020. Every shelf, however, still
// publishes a public RSS feed with rich custom fields (book_id, author_name,
// user_rating, user_review, book_image_url, ...). For our purposes this is
// plenty: each item becomes a vault note with the cover image, author, and
// the user's review text.
//
// Connect UX: the user pastes their shelf's RSS URL. They can find it on
// any of their shelves at https://www.goodreads.com/review/list/USERID?shelf=X
// via the "share" / RSS icon at the bottom of the page.
//
// We support pasting either a full feed URL or just a Goodreads user-id
// number — if the user gives us the id, we default to their "read" shelf.
//
// Auth: none. Public RSS feeds are unauthenticated.
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
  // Already a Goodreads RSS URL — pass through.
  if (/^https?:\/\/(www\.)?goodreads\.com\/review\/list_rss\//i.test(input)) {
    return input;
  }
  // Numeric user id → default to the "read" shelf.
  if (/^\d+$/.test(input)) {
    return `https://www.goodreads.com/review/list_rss/${input}?shelf=read`;
  }
  // Anything else (including https://www.goodreads.com/review/list/123 paths)
  // — try to extract a user id, otherwise treat as opaque URL.
  const m = input.match(/\/(?:list|list_rss|show)\/(\d+)/);
  if (m) return `https://www.goodreads.com/review/list_rss/${m[1]}?shelf=read`;
  return input;
}

async function fetchFeed(url) {
  const res = await withTimeout(
    fetch(url, {
      headers: {
        'User-Agent': 'LYKN-Connector/1.0 (+https://lykn.ai)',
        Accept: 'application/rss+xml, application/xml, text/xml',
      },
    }),
    FETCH_TIMEOUT_MS,
    'goodreads-feed',
  );
  if (!res.ok) throw new Error(`Goodreads feed: HTTP ${res.status}`);
  return res.text();
}

export const goodreadsAdapter = {
  id: 'goodreads',
  authMode: 'token',

  async connectWithToken({ fields }) {
    const feedUrl = buildFeedUrl(fields?.feed || fields?.username || fields?.token);
    if (!feedUrl) throw new Error('Goodreads RSS URL or user id is required.');

    // Validate by actually fetching the feed and checking it has items.
    const xml = await fetchFeed(feedUrl);
    const items = parseItems(xml);
    if (items.length === 0) {
      throw new Error(
        'Goodreads returned an empty or unreadable feed at that URL. Make sure your shelf is set to public.',
      );
    }

    const channelTitle = (xml.match(/<title>([^<]+)<\/title>/) || [])[1] || 'Goodreads';
    const fp = await fingerprint(feedUrl);

    return {
      providerUserId: `gr_${fp}`,
      accessToken: feedUrl,             // the URL IS the credential
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['shelf:read'],
      account: {
        handle: channelTitle.slice(0, 40),
        displayName: channelTitle.slice(0, 60),
        email: null,
        avatarUrl: null,
      },
      metadata: {
        feed_url: feedUrl,
        // ISO of the most recent pubDate / user_date_added we saved.
        last_seen_at: null,
      },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const feedUrl = meta.feed_url || accessToken;
    if (!feedUrl) throw new Error('Goodreads connection is missing its feed URL.');

    const xml = await fetchFeed(feedUrl);
    const items = parseItems(xml).slice(0, MAX_ITEMS_PER_SYNC);

    const cursorIso = meta.last_seen_at || null;
    const cursorDate = cursorIso ? new Date(cursorIso) : null;

    let saved = 0;
    let skipped = 0;
    let newest = cursorDate;

    for (const item of items) {
      const ts = item.userDateAdded || item.pubDate;
      const itemDate = ts ? new Date(ts) : null;
      if (cursorDate && itemDate && itemDate <= cursorDate) continue;

      const result = await saveBookAsNote({
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
// Save one Goodreads RSS item as a vault note
// ---------------------------------------------------------------------------
async function saveBookAsNote({ supabaseAdmin, userId, item }) {
  const url = item.link || (item.bookId ? `https://www.goodreads.com/book/show/${item.bookId}` : '');
  if (!url) return 'skipped';

  const title = item.title || 'Goodreads book';
  const description = (item.bookDescription || item.description || '')
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 1500);

  const ratingLine = item.userRating && Number(item.userRating) > 0
    ? `★ ${item.userRating}/5`
    : '';
  const shelfLine = item.userShelves ? `Shelf: ${item.userShelves}` : '';
  const authorLine = item.authorName ? `by ${item.authorName}` : '';
  const review = (item.userReview || '').replace(/<[^>]+>/g, '').trim();

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: item.bookImageUrl || '',
    favicon: 'https://www.goodreads.com/favicon.ico',
    siteName: 'Goodreads',
    articleText: description,
    oembedType: 'goodreads',
    oembedHtml: '',
    authorName: item.authorName || '',
    authorHandle: '',
  };

  const tags = ['goodreads', 'book', 'link', 'uploaded'];
  if (item.userShelves) {
    for (const shelf of String(item.userShelves).split(/[,\s]+/).filter(Boolean)) {
      tags.push(shelf.toLowerCase());
    }
  }

  const body = [
    [authorLine, ratingLine, shelfLine].filter(Boolean).join(' · '),
    description ? `\n${description}` : '',
    review ? `\nMy review:\n${review}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const createdAt = item.userDateAdded
    ? new Date(item.userDateAdded).toISOString()
    : item.pubDate
      ? new Date(item.pubDate).toISOString()
      : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'goodreads',
    createdAt,
    body,
    embedMetadata: {
      source: 'goodreads',
      title,
      url,
      author: item.authorName || '',
      rating: item.userRating ? Number(item.userRating) : null,
      shelves: item.userShelves || '',
    },
  });
}

// ---------------------------------------------------------------------------
// Mini RSS parser — Goodreads' RSS has custom fields (book_image_url,
// user_rating, user_review, etc.) on top of standard RSS, so we walk
// <item>…</item> blocks and pluck the tags we care about. Avoiding a
// full XML parser dependency since the data here is well-formed and the
// surface area is tiny.
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
      bookId: pickCdataOrText(block, 'book_id'),
      bookImageUrl:
        pickCdataOrText(block, 'book_large_image_url') ||
        pickCdataOrText(block, 'book_medium_image_url') ||
        pickCdataOrText(block, 'book_image_url') ||
        pickCdataOrText(block, 'book_small_image_url'),
      bookDescription: pickCdataOrText(block, 'book_description'),
      authorName: pickCdataOrText(block, 'author_name'),
      userRating: pickCdataOrText(block, 'user_rating'),
      userReview: pickCdataOrText(block, 'user_review'),
      userDateAdded: pickCdataOrText(block, 'user_date_added'),
      userShelves: pickCdataOrText(block, 'user_shelves'),
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
