// ============================================================================
// connectors/hardcover.js — Hardcover adapter (token-paste, GraphQL)
// ============================================================================
// Pulls a user's books from Hardcover (the modern Goodreads replacement)
// into the vault as bookmark notes. Each book the user has on any shelf —
// Want to Read / Currently Reading / Read / DNF — becomes one vault note
// pointing at the book's hardcover.app URL.
//
// Auth model: Hardcover exposes a Hasura-style GraphQL endpoint at
// https://api.hardcover.app/v1/graphql, with per-user bearer tokens
// generated at https://hardcover.app/account/api. The user pastes the
// token; every GraphQL call sends `Authorization: Bearer <token>`.
//
// API docs: https://docs.hardcover.app/api/getting-started/
//
// We use one query to identify the user (`me { id username }`) and a
// second to page through `user_books` ordered by `updated_at desc`. The
// `updated_at` of the most recent book becomes the cursor for the next
// sync — Hardcover bumps it whenever a user changes shelf, rating, or
// review, so this picks up edits too.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const HC_GQL = 'https://api.hardcover.app/v1/graphql';
const FETCH_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 10;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function hcGql(token, query, variables, label) {
  const res = await withTimeout(
    fetch(HC_GQL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'LYKN-Connector/1.0',
      },
      body: JSON.stringify({ query, variables }),
    }),
    FETCH_TIMEOUT_MS,
    `hardcover-${label}`,
  );

  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Hardcover ${res.status}: token rejected`);
  }
  if (res.status === 429) {
    throw new Error('Hardcover rate-limited; retry next cycle');
  }
  if (!res.ok) {
    throw new Error(`Hardcover ${label}: HTTP ${res.status}`);
  }

  const json = await res.json();
  if (json?.errors?.length) {
    const msg = json.errors[0]?.message || 'GraphQL error';
    // Hasura returns "invalid-jwt" / "JWTExpired" for bad tokens.
    if (/jwt|unauthor/i.test(msg)) {
      throw new ConnectorAuthError(`Hardcover: ${msg}`);
    }
    throw new Error(`Hardcover GraphQL: ${msg}`);
  }
  return json?.data || {};
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------
const Q_ME = `
  query Me {
    me {
      id
      username
    }
  }
`;

// One page of user_books with the joined book + author info we need to
// render a vault note. Hardcover's schema names: user_books table joins
// to `book` (with `cached_image`, `description`, `slug`, `contributions`).
const Q_USER_BOOKS = `
  query UserBooks($userId: Int!, $updatedAfter: timestamptz, $limit: Int!, $offset: Int!) {
    user_books(
      where: {
        user_id: { _eq: $userId },
        _and: [
          { updated_at: { _gt: $updatedAfter } }
        ]
      },
      order_by: { updated_at: asc },
      limit: $limit,
      offset: $offset
    ) {
      id
      status_id
      rating
      review_raw
      updated_at
      book {
        id
        slug
        title
        subtitle
        description
        release_date
        pages
        cached_image
        contributions {
          author { name }
        }
      }
    }
  }
`;

// Hardcover status_id → human label. (Schema constants — these may evolve
// but have been stable since beta.)
const STATUS_LABELS = {
  1: 'Want to Read',
  2: 'Currently Reading',
  3: 'Read',
  4: 'Did Not Finish',
  5: 'Removed',
};

export const hardcoverAdapter = {
  id: 'hardcover',
  authMode: 'token',

  async connectWithToken({ fields }) {
    const token = String(fields?.token || '').trim();
    if (!token) throw new Error('Hardcover API token is required.');

    const data = await hcGql(token, Q_ME, {}, 'me').catch((e) => {
      if (e instanceof ConnectorAuthError) throw e;
      throw new Error('Hardcover rejected this token. Get a fresh one at hardcover.app/account/api.');
    });
    const me = data?.me?.[0] || data?.me; // Hasura returns array for tables, object for custom me
    if (!me || !me.id) throw new Error('Hardcover did not return a user profile for this token.');

    return {
      providerUserId: String(me.id),
      accessToken: token,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['user:read'],
      account: {
        handle: me.username || `hardcover-${me.id}`,
        displayName: me.username || 'Hardcover',
        email: null,
        avatarUrl: null,
      },
      metadata: {
        user_id: Number(me.id),
        // ISO timestamp; subsequent syncs ask for user_books updated after this.
        updated_after: null,
      },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const userId = Number(meta.user_id);
    if (!userId) {
      // Migration path for older connections that pre-date the user_id
      // metadata key — refetch /me, persist, then carry on.
      const data = await hcGql(accessToken, Q_ME, {}, 'me-refresh');
      const me = data?.me?.[0] || data?.me;
      if (!me?.id) throw new Error('Hardcover: could not resolve user id');
      meta.user_id = Number(me.id);
      await supabaseAdmin
        .from('social_connections')
        .update({ metadata: { ...meta } })
        .eq('id', connection.id);
    }

    const updatedAfter = meta.updated_after || '1970-01-01T00:00:00Z';

    let saved = 0;
    let skipped = 0;
    let newestUpdatedAt = meta.updated_after || null;

    for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const data = await hcGql(
        accessToken,
        Q_USER_BOOKS,
        {
          userId: Number(meta.user_id),
          updatedAfter,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        },
        `user-books-p${page}`,
      );

      const rows = Array.isArray(data?.user_books) ? data.user_books : [];
      if (rows.length === 0) break;

      for (const row of rows) {
        const result = await saveBookAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          row,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        const ts = row?.updated_at;
        if (ts && (!newestUpdatedAt || new Date(ts) > new Date(newestUpdatedAt))) {
          newestUpdatedAt = ts;
        }
      }

      if (rows.length < PAGE_SIZE) break;
    }

    if (newestUpdatedAt && newestUpdatedAt !== meta.updated_after) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: { ...meta, updated_after: newestUpdatedAt },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save one user_book as a vault note
// ---------------------------------------------------------------------------
async function saveBookAsNote({ supabaseAdmin, userId, row }) {
  const book = row?.book;
  if (!book) return 'skipped';

  const slug = book.slug || String(book.id);
  const url = `https://hardcover.app/books/${slug}`;
  const title = [book.title, book.subtitle].filter(Boolean).join(': ');
  if (!title) return 'skipped';

  const authors = Array.isArray(book.contributions)
    ? book.contributions
        .map((c) => c?.author?.name)
        .filter(Boolean)
    : [];
  const authorLine = authors.length ? `by ${authors.join(', ')}` : '';

  const statusLabel = STATUS_LABELS[row.status_id] || 'On shelf';
  const rating = typeof row.rating === 'number' ? row.rating : null;

  const description = [
    authorLine,
    statusLabel,
    rating !== null ? `★ ${rating}/5` : '',
    book.release_date ? `Published ${book.release_date}` : '',
    book.pages ? `${book.pages} pages` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const bookDesc = (book.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 1500);

  const coverImage =
    (book.cached_image && (book.cached_image.url || book.cached_image)) || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: bookDesc || description,
    image: typeof coverImage === 'string' ? coverImage : '',
    favicon: 'https://hardcover.app/favicon.ico',
    siteName: 'Hardcover',
    articleText: bookDesc || description,
    oembedType: 'hardcover',
    oembedHtml: '',
    authorName: authors[0] || '',
    authorHandle: '',
  };

  const tags = ['hardcover', 'book', 'link', 'uploaded'];
  if (statusLabel) tags.push(statusLabel.toLowerCase().replace(/\s+/g, '-'));

  const review = (row.review_raw || '').trim();
  const body = [
    description,
    bookDesc ? `\n${bookDesc}` : '',
    review ? `\nMy review:\n${review}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const createdAt = row.updated_at ? new Date(row.updated_at).toISOString() : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'hardcover',
    createdAt,
    body,
    embedMetadata: {
      source: 'hardcover',
      title,
      url,
      authors,
      status: statusLabel,
      rating,
    },
  });
}
