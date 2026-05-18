// ============================================================================
// connectors/readwise.js — Readwise adapter (token-paste, no OAuth)
// ============================================================================
// Pulls every book / article the user has highlights for via Readwise's
// /api/v2/export/ endpoint. Each "user_book" becomes a single vault note
// titled with the source's title/author and bodied with the user's
// highlights from that source.
//
// Why a "user_book" per note (not per highlight)?
//   • Vault items are meant to feel like sources, not snippets.
//   • Cluster of highlights from the same article reads as one curated
//     bookmark with quotes, which is exactly how people remember them.
//   • Far fewer items in the vault — Readwise power users have tens of
//     thousands of highlights but only hundreds of sources.
//
// Auth: user pastes their Readwise access token (readwise.io/access_token).
// Header is `Authorization: Token <token>` — note the literal word "Token",
// NOT "Bearer". This is a Django REST Framework convention Readwise inherited.
//
// Validation: GET /api/v2/auth/ returns 204 No Content when the token is
// valid; 401 otherwise. Cheap, no payload.
//
// Rate limits: 20 requests / minute on /export, 240 on most other v2
// endpoints. We cap pages per sync to stay well under that.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const RW_AUTH_URL = 'https://readwise.io/api/v2/auth/';
const RW_EXPORT_URL = 'https://readwise.io/api/v2/export/';

const FETCH_TIMEOUT_MS = 20_000; // Readwise export can be slow on first sync
const MAX_PAGES_PER_SYNC = 8;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function rwHeaders(token) {
  // Readwise inherits Django REST Framework's "Token" auth scheme — the
  // literal word "Token", not "Bearer". Easy thing to get wrong.
  return { Authorization: `Token ${token}` };
}

async function rwFetch(url, token, label) {
  const res = await withTimeout(
    fetch(url, { headers: rwHeaders(token) }),
    FETCH_TIMEOUT_MS,
    label,
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Readwise ${res.status}: token rejected`);
  }
  if (res.status === 429) {
    throw new Error('Readwise rate-limited; retry next cycle');
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}

export const readwiseAdapter = {
  id: 'readwise',
  authMode: 'token',

  /**
   * Validates a user-supplied access token and produces a connection-ready
   * object. Mirrors the OAuth path's exchangeCode return shape so the
   * server endpoint handles both flows identically.
   *
   * fields: { token: string }
   */
  async connectWithToken({ fields }) {
    const token = String(fields?.token || '').trim();
    if (!token) throw new Error('Readwise access token is required.');

    // Validate the token cheaply before persisting anything.
    const validateRes = await withTimeout(
      fetch(RW_AUTH_URL, { headers: rwHeaders(token) }),
      FETCH_TIMEOUT_MS,
      'readwise-auth',
    );
    if (validateRes.status === 401 || validateRes.status === 403) {
      throw new Error('Readwise rejected this token. Get a fresh one at readwise.io/access_token.');
    }
    if (!validateRes.ok && validateRes.status !== 204) {
      throw new Error(`Readwise validation failed: HTTP ${validateRes.status}`);
    }

    // Readwise has no /me endpoint, so we synthesize a stable id from a
    // hash of the token. The user can override the display label later.
    const tokenFp = await fingerprint(token);

    return {
      providerUserId: `rw_${tokenFp}`,
      accessToken: token,
      refreshToken: null,
      tokenExpiresAt: null, // Readwise tokens never expire unless revoked
      scopes: ['highlights:read', 'books:read'],
      account: {
        handle: 'readwise',
        displayName: 'Readwise',
        email: null,
        avatarUrl: null,
      },
      metadata: {
        // ISO timestamp; we ask Readwise for everything updated after this.
        updated_after: null,
      },
    };
  },

  /**
   * Pulls books with their highlights via /api/v2/export/. Each user_book
   * → one vault note. Cursor is the most recent updated_at we saw.
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const updatedAfterIso = meta.updated_after || null;

    let saved = 0;
    let skipped = 0;
    let pageCursor = null;
    let newestIso = updatedAfterIso;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const params = new URLSearchParams();
      if (updatedAfterIso) params.set('updatedAfter', updatedAfterIso);
      if (pageCursor) params.set('pageCursor', pageCursor);

      const url = `${RW_EXPORT_URL}${params.toString() ? '?' + params.toString() : ''}`;
      const data = await rwFetch(url, accessToken, `readwise-export-p${page}`);

      const results = Array.isArray(data?.results) ? data.results : [];
      if (!results.length) break;

      for (const book of results) {
        const result = await saveBookAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          book,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        // Track the latest updated_at so the next sync only asks for
        // newer rows. Highlights have their own updated_at; book has
        // last_highlight_at + readable_title — we use last_highlight_at.
        const lastIso = book.last_highlight_at || null;
        if (lastIso && (!newestIso || new Date(lastIso) > new Date(newestIso))) {
          newestIso = lastIso;
        }
      }

      pageCursor = data?.nextPageCursor || null;
      if (!pageCursor) break;
    }

    if (newestIso && newestIso !== updatedAfterIso) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            updated_after: newestIso,
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save a Readwise "user_book" as a vault note
// ---------------------------------------------------------------------------
async function saveBookAsNote({ supabaseAdmin, userId, book }) {
  if (!book || !(book.user_book_id || book.title)) return 'skipped';

  // Choose a stable URL for dedupe. Order of preference:
  //   1. The source URL (Substack/Medium/web articles always have one)
  //   2. A synthetic readwise.io URL using the user_book_id
  const url =
    book.source_url ||
    `https://readwise.io/bookreview/${book.user_book_id}`;

  const title = book.readable_title || book.title || 'Readwise highlight';
  const author = book.author || '';
  const category = book.category || ''; // books, articles, tweets, supplementals, podcasts
  const source = book.source || '';     // kindle, instapaper, pocket, web, etc.

  const highlights = Array.isArray(book.highlights) ? book.highlights : [];
  const top = highlights.slice(0, 30); // bound the body length

  const lines = [];
  if (author) lines.push(`by ${author}`);
  if (category || source) {
    lines.push(`${[category, source].filter(Boolean).join(' · ')}`);
  }
  if (lines.length) lines.push('');

  for (const h of top) {
    const text = (h.text || '').trim();
    if (!text) continue;
    lines.push(`> ${text.replace(/\n+/g, '\n> ')}`);
    if (h.note) lines.push(`Note: ${String(h.note).trim()}`);
    lines.push('');
  }

  const description = lines.join('\n').slice(0, 2400);

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: book.cover_image_url || '',
    favicon: 'https://readwise.io/favicon.ico',
    siteName: source ? `Readwise · ${source}` : 'Readwise',
    articleText: description,
    oembedType: 'readwise',
    oembedHtml: '',
    authorName: author,
    authorHandle: '',
  };

  const tags = ['readwise', 'highlight', 'link', 'uploaded'];
  if (category) tags.push(String(category).toLowerCase());
  if (source) tags.push(String(source).toLowerCase());

  const createdAt = book.last_highlight_at
    ? new Date(book.last_highlight_at).toISOString()
    : undefined;

  // Body for embedding: skip the bookmark-style "by Author / category"
  // header and let the multi-highlight blockquote be the embed text.
  // The description already contains the full quoted text + the
  // user's notes per highlight, so we pass it through as-is.
  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'readwise',
    createdAt,
    body: description,
    embedMetadata: { source: 'readwise', title, url, author, category, readwise_source: source },
  });
}

// ---------------------------------------------------------------------------
// Compact non-cryptographic fingerprint for stable provider_user_id when
// the API has no /me endpoint. SHA-256 truncated to 12 chars is plenty
// for uniqueness within one user's account list.
// ---------------------------------------------------------------------------
async function fingerprint(input) {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
}
