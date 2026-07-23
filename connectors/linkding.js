// ============================================================================
// connectors/linkding.js — Linkding adapter (token + endpoint, self-hosted)
// ============================================================================
// Pulls a user's bookmarks from a Linkding instance into the vault as
// bookmark notes. Linkding is open-source and almost always self-hosted,
// so we collect both an instance URL and a REST API token from the user
// at connect time.
//
// Auth model: Linkding (built on Django REST Framework) accepts a per-user
// token in the literal `Authorization: Token <TOKEN>` form — note "Token",
// not "Bearer". Tokens are generated in Linkding under
// Settings → Integrations → REST API.
//
// Endpoint shape (offset-paginated):
//   GET /api/bookmarks/?limit=100&offset=N&q=...
//   →   { results: [...], next, previous, count }
//
// Bookmark shape:
//   { id, url, title, description, notes, website_title, website_description,
//     is_archived, unread, shared, tag_names: [...],
//     date_added, date_modified, favicon_url, preview_image_url }
//
// Cursor: `date_modified` of the most recent bookmark we saved. We use
// the `?q=` filter very lightly (Linkding's bookmark search supports
// `>date:` filters, but plain offset pagination is simpler and reliable
// across versions — caps + dedupe keep it bounded).
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { assertUrlSafe, safeFetch } from '../lib/exterior/ssrfGuard.js';
import { saveConnectorNote } from './_save.js';

const FETCH_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
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
  url = url.replace(/\/(bookmarks|api).*$/, '');
  return url;
}

async function ldGet(endpoint, token, path, label, query = {}) {
  const url = new URL(`${endpoint}/api${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  // Self-hosted endpoints must still be publicly resolvable — private/
  // loopback/metadata targets are blocked so a connect form can't SSRF
  // the LYKN API host into an internal network.
  const safe = await assertUrlSafe(url.toString());
  if (!safe.ok) {
    throw new Error('Linkding URL is not allowed (private or internal addresses are blocked).');
  }
  const res = await withTimeout(
    safeFetch(safe.url, {
      headers: {
        // Linkding uses DRF's `Token` scheme (not Bearer). Easy to get wrong.
        Authorization: `Token ${token}`,
        Accept: 'application/json',
        'User-Agent': 'LYKN-Connector/1.0',
      },
    }),
    FETCH_TIMEOUT_MS,
    `linkding-${label}`,
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Linkding ${res.status}: token rejected`);
  }
  if (res.status === 429) {
    throw new Error('Linkding rate-limited; retry next cycle');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Linkding ${label}: HTTP ${res.status} ${body.slice(0, 120)}`);
  }
  return res.json();
}

export const linkdingAdapter = {
  id: 'linkding',
  authMode: 'token',

  async connectWithToken({ fields }) {
    const endpoint = normalizeEndpoint(fields?.endpoint);
    const token = String(fields?.token || '').trim();
    if (!endpoint) throw new Error('Linkding URL is required (e.g. https://linkding.yourdomain.com).');
    if (!token) throw new Error('Linkding REST API token is required.');

    await ldGet(endpoint, token, '/bookmarks/', 'validate', { limit: 1 }).catch((e) => {
      if (e instanceof ConnectorAuthError) throw e;
      throw new Error(`Linkding at ${endpoint} did not respond. Check the URL and your API token.`);
    });

    const host = new URL(endpoint).host;
    const fp = await fingerprint(`${endpoint}|${token}`);

    return {
      providerUserId: `ld_${fp}`,
      accessToken: token,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['bookmarks:read'],
      account: {
        handle: host,
        displayName: `Linkding · ${host}`,
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
    if (!endpoint) throw new Error('Linkding connection is missing its endpoint URL.');

    const cursorIso = meta.last_modified_at || null;
    const cursorDate = cursorIso ? new Date(cursorIso) : null;

    let saved = 0;
    let skipped = 0;
    let newest = cursorDate;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const data = await ldGet(endpoint, accessToken, '/bookmarks/', `bookmarks-p${page}`, {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });

      const arr = Array.isArray(data?.results) ? data.results : [];
      if (arr.length === 0) break;

      for (const bm of arr) {
        const modifiedAt = bm?.date_modified ? new Date(bm.date_modified) : null;
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

      if (arr.length < PAGE_SIZE) break;
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
// Save one Linkding bookmark as a vault note
// ---------------------------------------------------------------------------
async function saveBookmarkAsNote({ supabaseAdmin, userId, bookmark, endpoint }) {
  const url = String(bookmark?.url || '').trim();
  if (!url) return 'skipped';

  const title = (bookmark.title || bookmark.website_title || url).trim();
  const description = String(
    bookmark.description || bookmark.website_description || '',
  )
    .trim()
    .slice(0, 1500);
  const note = String(bookmark.notes || '').trim();

  const upstreamTags = Array.isArray(bookmark.tag_names)
    ? bookmark.tag_names.map((t) => String(t).toLowerCase()).slice(0, 12)
    : [];

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: bookmark.preview_image_url || '',
    favicon: bookmark.favicon_url || `${endpoint}/favicon.ico`,
    siteName: 'Linkding',
    articleText: description,
    oembedType: 'linkding',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  const tags = Array.from(
    new Set(['linkding', 'bookmark', 'link', 'uploaded', ...upstreamTags]),
  );
  if (bookmark.unread) tags.push('unread');
  if (bookmark.is_archived) tags.push('archived');

  const body = [
    description,
    note ? `\nMy note: ${note}` : '',
    upstreamTags.length ? `\nLinkding tags: ${upstreamTags.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const createdAt = bookmark.date_added
    ? new Date(bookmark.date_added).toISOString()
    : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'linkding',
    createdAt,
    body,
    embedMetadata: {
      source: 'linkding',
      title,
      url,
      linkding_id: bookmark.id,
      tags: upstreamTags,
    },
  });
}

// ---------------------------------------------------------------------------
async function fingerprint(input) {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
}
