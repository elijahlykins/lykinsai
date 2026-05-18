// ============================================================================
// connectors/hackernews.js — Hacker News adapter (username-only, no token)
// ============================================================================
// Pulls a user's favorites + submissions from Hacker News into the vault as
// bookmark notes. Each item becomes one note pointing at the canonical HN
// item URL (https://news.ycombinator.com/item?id=<id>), so dedupe works the
// same way as every other connector and the original story link is carried
// in the attachment.
//
// Auth model: HN has no OAuth and no per-user API tokens. The user pastes
// their public username, and we use:
//
//   • The official read-only Firebase API (no key required) for the user's
//     `submitted` list and per-item hydration:
//       https://hacker-news.firebaseio.com/v0/user/<user>.json
//       https://hacker-news.firebaseio.com/v0/item/<id>.json
//
//   • The public HTML page at https://news.ycombinator.com/favorites?id=<user>
//     for favorites — HN doesn't expose favorites via the JSON API. The
//     HTML structure has been stable since 2007 (athing rows with id="<num>")
//     so a tiny regex scrape is acceptable here. If HN ever changes it,
//     the favorites path degrades to "skipped" without breaking submissions.
//
// Sync ceiling: cap each path at ~50 items per cycle. HN users with massive
// favorite/submission lists get caught up over subsequent syncs via the
// dedupe step in saveConnectorNote.
// ============================================================================

import { saveConnectorNote } from './_save.js';

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const HN_WEB = 'https://news.ycombinator.com';

const FETCH_TIMEOUT_MS = 12_000;
const MAX_FAVORITES_PAGES = 3;          // up to 30 favorites per page
const MAX_SUBMITTED_PER_SYNC = 50;
const MAX_TOTAL_HYDRATED_PER_SYNC = 80; // hard cap on individual /item lookups

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function hnApi(path, label) {
  const res = await withTimeout(
    fetch(`${HN_API}${path}`, {
      headers: { 'User-Agent': 'LYKN-Connector/1.0' },
    }),
    FETCH_TIMEOUT_MS,
    `hn-${label}`,
  );
  if (!res.ok) throw new Error(`hn-${label}: HTTP ${res.status}`);
  return res.json();
}

export const hackernewsAdapter = {
  id: 'hackernews',
  authMode: 'token',

  /**
   * "Connecting" Hacker News just means proving the username resolves to
   * a real user. We persist the username as the accessToken (the sync
   * step uses it as the only credential).
   */
  async connectWithToken({ fields }) {
    const username = String(fields?.username || '').trim();
    if (!username) throw new Error('Hacker News username is required.');
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) {
      throw new Error('That doesn\'t look like a valid HN username.');
    }

    const user = await hnApi(`/user/${encodeURIComponent(username)}.json`, 'user-lookup');
    if (!user || !user.id) {
      throw new Error(`No such Hacker News user: ${username}`);
    }

    return {
      providerUserId: String(user.id),
      accessToken: String(user.id),  // we treat the username as the credential
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['public_user'],
      account: {
        handle: user.id,
        displayName: user.id,
        email: null,
        avatarUrl: null,
      },
      metadata: {
        karma: user.karma || 0,
        // Highest item id we've seen on a previous sync. Submitted items
        // are descending by id, so we can stop walking once we cross this.
        last_seen_submitted_id: null,
      },
    };
  },

  /**
   * Pulls the user's favorites (HTML scrape) + submissions (API), hydrates
   * each into a full item, then saves as a bookmark note. Returns
   * { saved, skipped }.
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const username = accessToken;
    const meta = connection.metadata || {};
    const lastSeenSubmitted = meta.last_seen_submitted_id
      ? Number(meta.last_seen_submitted_id)
      : null;

    // ── 1. Favorites (scraped, in display order — newest favorited first)
    const favoriteIds = await scrapeFavoriteIds(username);

    // ── 2. Submissions (API, newest submitted first)
    const userData = await hnApi(
      `/user/${encodeURIComponent(username)}.json`,
      'user-submitted',
    );
    const submittedAll = Array.isArray(userData?.submitted) ? userData.submitted : [];
    const submittedFresh = lastSeenSubmitted
      ? submittedAll.filter((id) => Number(id) > lastSeenSubmitted)
      : submittedAll.slice(0, MAX_SUBMITTED_PER_SYNC);

    // Dedupe across the two lists, favorites first (so isFavorite gets set
    // before submitted-only items push it out of the cap).
    const isFavoriteSet = new Set(favoriteIds.map(String));
    const merged = [];
    const seen = new Set();
    for (const id of [...favoriteIds, ...submittedFresh]) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(key);
      if (merged.length >= MAX_TOTAL_HYDRATED_PER_SYNC) break;
    }

    let saved = 0;
    let skipped = 0;
    let newestSubmittedId = lastSeenSubmitted;

    for (const id of merged) {
      const item = await hnApi(`/item/${id}.json`, `item-${id}`).catch(() => null);
      if (!item || item.deleted || item.dead) {
        skipped++;
        continue;
      }
      const result = await saveItemAsNote({
        supabaseAdmin,
        userId: connection.user_id,
        item,
        isFavorite: isFavoriteSet.has(String(id)),
        username,
      });
      if (result === 'saved' || result === 'updated') saved++;
      else skipped++;

      // Track the highest submitted item id we've seen so the next sync
      // can early-out instead of refetching the whole submitted list.
      if (item.by === username) {
        const n = Number(item.id);
        if (!newestSubmittedId || n > newestSubmittedId) newestSubmittedId = n;
      }
    }

    if (newestSubmittedId && newestSubmittedId !== lastSeenSubmitted) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            last_seen_submitted_id: newestSubmittedId,
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Favorites scrape — HN has no JSON API for favorites. The favorites page
// renders each item as <tr class="athing" id="<itemid>"> with very stable
// markup. We pull up to MAX_FAVORITES_PAGES pages.
// ---------------------------------------------------------------------------
async function scrapeFavoriteIds(username) {
  const ids = [];
  for (let page = 1; page <= MAX_FAVORITES_PAGES; page++) {
    const url = `${HN_WEB}/favorites?id=${encodeURIComponent(username)}&p=${page}`;
    let html;
    try {
      const res = await withTimeout(
        fetch(url, {
          headers: {
            // HN sometimes 403s default UAs; a real-ish UA gets through.
            'User-Agent':
              'Mozilla/5.0 (compatible; LYKN-Connector/1.0; +https://lykn.ai)',
            Accept: 'text/html,application/xhtml+xml',
          },
        }),
        FETCH_TIMEOUT_MS,
        `hn-fav-p${page}`,
      );
      if (!res.ok) break;
      html = await res.text();
    } catch {
      break;
    }
    // <tr class="athing" id="12345678">
    const re = /<tr[^>]*class="athing"[^>]*id="(\d+)"/g;
    let m;
    let pageCount = 0;
    while ((m = re.exec(html)) !== null) {
      ids.push(m[1]);
      pageCount++;
    }
    if (pageCount < 30) break; // no full page → no further pages
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Save an HN item as a vault note
// ---------------------------------------------------------------------------
async function saveItemAsNote({ supabaseAdmin, userId, item, isFavorite, username }) {
  const hnUrl = `https://news.ycombinator.com/item?id=${item.id}`;
  const externalUrl = item.url || null;
  // Dedupe on the HN URL (canonical for every item type), not the external
  // URL — multiple HN submissions can point at the same article and we
  // want to keep them as distinct vault items.
  const dedupeNeedle = hnUrl;

  const title =
    item.title ||
    (item.text ? truncate(stripHtml(item.text), 120) : '(comment)') ||
    `Hacker News item ${item.id}`;

  const author = item.by || '';
  const score = typeof item.score === 'number' ? item.score : null;
  const descendants = typeof item.descendants === 'number' ? item.descendants : null;
  const metaBits = [];
  if (score !== null) metaBits.push(`${score} points`);
  if (descendants !== null) metaBits.push(`${descendants} comments`);
  if (author) metaBits.push(`by ${author}`);

  const description = item.text
    ? truncate(stripHtml(item.text), 1200)
    : metaBits.join(' · ');

  const attachment = {
    type: 'bookmark',
    url: externalUrl || hnUrl,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://news.ycombinator.com/favicon.ico',
    siteName: externalUrl ? `Hacker News · ${siteOf(externalUrl)}` : 'Hacker News',
    articleText: description,
    oembedType: 'hackernews',
    oembedHtml: '',
    authorName: author,
    authorHandle: author ? `@${author}` : '',
  };

  const tags = ['hackernews', 'link', 'uploaded'];
  if (isFavorite) tags.push('favorite');
  if (item.by === username) tags.push('submitted');
  if (item.type) tags.push(item.type); // 'story' | 'comment' | 'job' | 'poll'

  const body = [
    title,
    metaBits.length ? metaBits.join(' · ') : '',
    externalUrl ? `Article: ${externalUrl}` : '',
    `HN: ${hnUrl}`,
    item.text ? '\n' + stripHtml(item.text) : '',
  ]
    .filter(Boolean)
    .join('\n');

  const createdAt = item.time ? new Date(item.time * 1000).toISOString() : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url: externalUrl || hnUrl,
    dedupeNeedle,
    title,
    attachment,
    tags,
    source: isFavorite ? 'hackernews_favorite' : 'hackernews_submitted',
    createdAt,
    body,
    embedMetadata: {
      source: isFavorite ? 'hackernews_favorite' : 'hackernews_submitted',
      title,
      url: externalUrl || hnUrl,
      hn_id: item.id,
      author,
    },
  });
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------
function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
