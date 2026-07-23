// ============================================================================
// connectors/karakeep.js — Karakeep adapter (token + endpoint, self-hosted)
// ============================================================================
// Pulls a user's bookmarks from a Karakeep instance (formerly Hoarder) into
// the vault as bookmark notes. Karakeep is open-source and usually
// self-hosted, so we collect both an instance URL and an API key from the
// user at connect time.
//
// Auth model: Karakeep accepts a per-user API key as a Bearer token:
//   curl -H "Authorization: Bearer <KEY>" https://<host>/api/v1/bookmarks
// Keys are generated under Settings → API Keys inside Karakeep itself.
//
// Endpoint shape (paginated, cursor-based):
//   GET /api/v1/bookmarks?limit=50&cursor=<opaque>
//   →   { bookmarks: [...], nextCursor: "..." }
//
// Each bookmark has shape (truncated):
//   { id, createdAt, modifiedAt, title, archived, favourited, taggingStatus,
//     summary, note,
//     content: { type: "link"|"text"|"asset",
//                url, title, description, imageUrl, author, publisher, ... },
//     tags: [{ name, ... }] }
//
// We dedupe on the content.url (for link bookmarks) or the bookmark id
// otherwise. Cursor between syncs is the most-recent modifiedAt we saw.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { assertUrlSafe, safeFetch } from '../lib/exterior/ssrfGuard.js';
import { saveConnectorNote } from './_save.js';

const FETCH_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_SYNC = 20;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function normalizeEndpoint(input) {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  // If the user pasted a `/dashboard` or similar path, strip it.
  url = url.replace(/\/(dashboard|api|api\/v1).*$/, '');
  return url;
}

async function kkGet(endpoint, token, path, label, query = {}) {
  const url = new URL(`${endpoint}/api/v1${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const safe = await assertUrlSafe(url.toString());
  if (!safe.ok) {
    throw new Error('Karakeep URL is not allowed (private or internal addresses are blocked).');
  }
  const res = await withTimeout(
    safeFetch(safe.url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'User-Agent': 'LYKN-Connector/1.0',
      },
    }),
    FETCH_TIMEOUT_MS,
    `karakeep-${label}`,
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Karakeep ${res.status}: token rejected`);
  }
  if (res.status === 429) {
    throw new Error('Karakeep rate-limited; retry next cycle');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Karakeep ${label}: HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

export const karakeepAdapter = {
  id: 'karakeep',
  authMode: 'token',

  async connectWithToken({ fields }) {
    const endpoint = normalizeEndpoint(fields?.endpoint);
    const token = String(fields?.token || '').trim();
    if (!endpoint) throw new Error('Karakeep URL is required (e.g. https://karakeep.yourdomain.com).');
    if (!token) throw new Error('Karakeep API key is required.');

    // Touch the bookmarks endpoint with limit=1 — cheap validation that
    // hits both the host and the auth path.
    await kkGet(endpoint, token, '/bookmarks', 'validate', { limit: 1 }).catch((e) => {
      if (e instanceof ConnectorAuthError) throw e;
      throw new Error(`Karakeep at ${endpoint} did not respond. Check the URL and your API key.`);
    });

    const host = new URL(endpoint).host;
    const fp = await fingerprint(`${endpoint}|${token}`);

    return {
      providerUserId: `kk_${fp}`,
      accessToken: token,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['bookmarks:read'],
      account: {
        handle: host,
        displayName: `Karakeep · ${host}`,
        email: null,
        avatarUrl: null,
      },
      metadata: {
        endpoint,
        // ISO timestamp of the most recent bookmark we saved.
        last_modified_at: null,
      },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const endpoint = normalizeEndpoint(meta.endpoint);
    if (!endpoint) throw new Error('Karakeep connection is missing its endpoint URL.');

    const cursorIso = meta.last_modified_at || null;
    const cursorDate = cursorIso ? new Date(cursorIso) : null;

    let saved = 0;
    let skipped = 0;
    let newest = cursorDate;
    let nextCursor = null;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const data = await kkGet(endpoint, accessToken, '/bookmarks', `bookmarks-p${page}`, {
        limit: PAGE_SIZE,
        cursor: nextCursor || undefined,
      });

      const arr = Array.isArray(data?.bookmarks) ? data.bookmarks : [];
      if (arr.length === 0) break;

      for (const bm of arr) {
        const modifiedAt = bm?.modifiedAt ? new Date(bm.modifiedAt) : null;
        // Once we hit items older than our cursor we're caught up.
        if (cursorDate && modifiedAt && modifiedAt <= cursorDate) break pages;

        const result = await saveBookmarkAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          bookmark: bm,
          endpoint,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        if (modifiedAt && (!newest || modifiedAt > newest)) newest = modifiedAt;
      }

      nextCursor = data?.nextCursor || null;
      if (!nextCursor) break;
    }

    if (newest && (!cursorDate || newest > cursorDate)) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: { ...meta, last_modified_at: newest.toISOString() },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save one Karakeep bookmark as a vault note
// ---------------------------------------------------------------------------
async function saveBookmarkAsNote({ supabaseAdmin, userId, bookmark, endpoint }) {
  const content = bookmark?.content || {};
  const isLink = content?.type === 'link';
  const url = isLink && content?.url ? String(content.url) : '';

  // Karakeep dashboard URL for the bookmark itself — used as the canonical
  // vault link when the bookmark isn't a web link (notes, assets).
  const internalUrl = `${endpoint}/dashboard/preview/${encodeURIComponent(bookmark.id)}`;
  const canonicalUrl = url || internalUrl;
  const dedupeNeedle = url || `karakeep:${bookmark.id}`;

  const title =
    bookmark.title ||
    content.title ||
    (content?.text ? String(content.text).slice(0, 80) : '') ||
    canonicalUrl;

  const description = String(
    bookmark.summary ||
      content.description ||
      content.text ||
      bookmark.note ||
      '',
  )
    .trim()
    .slice(0, 1500);

  const tagsRaw = Array.isArray(bookmark.tags) ? bookmark.tags : [];
  const upstreamTags = tagsRaw
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter(Boolean)
    .map((t) => String(t).toLowerCase());

  const attachment = {
    type: 'bookmark',
    url: canonicalUrl,
    name: title,
    title,
    description,
    image: content.imageUrl || '',
    favicon: content.favicon || `${endpoint}/favicon.ico`,
    siteName: content.publisher || 'Karakeep',
    articleText: description,
    oembedType: 'karakeep',
    oembedHtml: '',
    authorName: content.author || '',
    authorHandle: '',
  };

  const tags = Array.from(
    new Set(['karakeep', 'bookmark', 'link', 'uploaded', ...upstreamTags]),
  );
  if (bookmark.favourited) tags.push('favorite');
  if (bookmark.archived) tags.push('archived');

  const body = [
    description,
    bookmark.note ? `\nMy note: ${String(bookmark.note).trim()}` : '',
    upstreamTags.length ? `\nKarakeep tags: ${upstreamTags.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const createdAt = bookmark.createdAt
    ? new Date(bookmark.createdAt).toISOString()
    : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url: canonicalUrl,
    dedupeNeedle,
    title,
    attachment,
    tags,
    source: 'karakeep',
    createdAt,
    body,
    embedMetadata: {
      source: 'karakeep',
      title,
      url: canonicalUrl,
      karakeep_id: bookmark.id,
      tags: upstreamTags,
    },
  });
}

// ---------------------------------------------------------------------------
async function fingerprint(input) {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
}
