// ============================================================================
// connectors/pinboard.js — Pinboard adapter (token-paste, no OAuth)
// ============================================================================
// Pulls a user's bookmarks from Pinboard into the vault as bookmark notes.
// Each bookmark becomes one note pointing at the original URL, carrying
// Pinboard's title, extended description, and tags forward.
//
// Auth model: Pinboard never built OAuth. Their per-user "API token" is in
// the form `username:HEXTOKEN`, shown on pinboard.in/settings/password.
// Every API call appends `?auth_token=username:HEXTOKEN`. The user pastes
// that string into our token dialog — there is no server-side shared
// credential to register, so this connector is "ready" the moment it's
// registered.
//
// Rate limit: Pinboard explicitly asks for `posts/update` polling and
// only calling the heavyweight `posts/all` when `update_time` advances.
// We honor that: read /posts/update first, compare against our cursor,
// and skip the /posts/all hit entirely when nothing has changed.
//
//   https://pinboard.in/api/  (Don't make `posts/all` requests more than
//   once a minute. Don't make `posts/recent` requests more than once a
//   five minutes.)
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const PB_API = 'https://api.pinboard.in/v1';
const FETCH_TIMEOUT_MS = 20_000; // posts/all can be slow on big libraries
const MAX_POSTS_PER_SYNC = 2000; // hard ceiling; first sync handles huge collections in one pass

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function pbGet(path, token, label, params = {}) {
  const url = new URL(`${PB_API}/${path}`);
  url.searchParams.set('auth_token', token);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await withTimeout(
    fetch(url, { headers: { 'User-Agent': 'LYKN-Connector/1.0' } }),
    FETCH_TIMEOUT_MS,
    `pinboard-${label}`,
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Pinboard ${res.status}: token rejected`);
  }
  if (res.status === 429) {
    throw new Error('Pinboard rate-limited; retry next cycle');
  }
  if (!res.ok) {
    throw new Error(`Pinboard ${label}: HTTP ${res.status}`);
  }
  return res.json();
}

function tokenLooksValid(t) {
  // Format: username:HEX. We're strict on shape so users notice typos.
  return /^[^:\s]{1,40}:[A-Fa-f0-9]{16,}$/.test(t);
}

function usernameFrom(token) {
  return String(token || '').split(':')[0] || '';
}

export const pinboardAdapter = {
  id: 'pinboard',
  authMode: 'token',

  async connectWithToken({ fields }) {
    const token = String(fields?.token || '').trim();
    if (!token) throw new Error('Pinboard API token is required.');
    if (!tokenLooksValid(token)) {
      throw new Error('Pinboard tokens look like "username:HEXTOKEN". Copy yours from pinboard.in/settings/password.');
    }

    // posts/update is the cheapest validation call (single key, no payload).
    const update = await pbGet('posts/update', token, 'validate').catch((e) => {
      if (e instanceof ConnectorAuthError) throw e;
      throw new Error(`Pinboard rejected this token. Get a fresh one at pinboard.in/settings/password.`);
    });

    const handle = usernameFrom(token);

    return {
      providerUserId: handle,
      accessToken: token,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['posts:read'],
      account: {
        handle,
        displayName: handle,
        email: null,
        avatarUrl: null,
      },
      metadata: {
        // ISO timestamp of the last /posts/update we saw. Skip the
        // expensive /posts/all call when this hasn't changed.
        last_update_time: null,
        // ISO timestamp of the most recent bookmark we saved. Acts as
        // the per-item cursor inside a sync pass.
        last_bookmark_time: null,
        first_update_time: update?.update_time || null,
      },
    };
  },

  /**
   * Polls /posts/update first. If unchanged since our cursor, returns
   * { saved: 0, skipped: 0 } without ever calling /posts/all. Otherwise
   * pulls every post (Pinboard's API only offers all-or-recent — we use
   * all and let saveConnectorNote dedupe).
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const cursorUpdate = meta.last_update_time || null;
    const cursorBookmark = meta.last_bookmark_time
      ? new Date(meta.last_bookmark_time)
      : null;

    const update = await pbGet('posts/update', accessToken, 'update-check');
    const remoteUpdate = update?.update_time || null;

    if (cursorUpdate && remoteUpdate && remoteUpdate === cursorUpdate) {
      // Nothing changed upstream — Pinboard's whole point of /posts/update.
      return { saved: 0, skipped: 0 };
    }

    // Pull everything. `fromdt` filters server-side when we have a cursor,
    // which is much friendlier than asking for 10k bookmarks on every sync.
    const params = { results: MAX_POSTS_PER_SYNC };
    if (cursorBookmark) params.fromdt = cursorBookmark.toISOString();

    const all = await pbGet('posts/all', accessToken, 'posts-all', params);
    const posts = Array.isArray(all) ? all : [];
    if (posts.length === 0) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            last_update_time: remoteUpdate,
          },
        })
        .eq('id', connection.id);
      return { saved: 0, skipped: 0 };
    }

    let saved = 0;
    let skipped = 0;
    let newestBookmark = cursorBookmark;

    for (const post of posts) {
      const result = await savePinboardPostAsNote({
        supabaseAdmin,
        userId: connection.user_id,
        post,
      });
      if (result === 'saved' || result === 'updated') saved++;
      else skipped++;

      const t = post?.time ? new Date(post.time) : null;
      if (t && (!newestBookmark || t > newestBookmark)) newestBookmark = t;
    }

    await supabaseAdmin
      .from('social_connections')
      .update({
        metadata: {
          ...(connection.metadata || {}),
          last_update_time: remoteUpdate,
          last_bookmark_time: newestBookmark ? newestBookmark.toISOString() : meta.last_bookmark_time,
        },
      })
      .eq('id', connection.id);

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save one Pinboard post as a vault note
// ---------------------------------------------------------------------------
async function savePinboardPostAsNote({ supabaseAdmin, userId, post }) {
  const url = post?.href || '';
  if (!url) return 'skipped';

  const title = (post?.description || url).trim();
  const description = (post?.extended || '').trim().slice(0, 1200);

  const tagsRaw = String(post?.tags || '').trim();
  const upstreamTags = tagsRaw
    ? tagsRaw.split(/\s+/).map((t) => t.toLowerCase()).slice(0, 12)
    : [];

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: '',
    favicon: 'https://pinboard.in/favicon.ico',
    siteName: 'Pinboard',
    articleText: description,
    oembedType: 'pinboard',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  const tags = Array.from(
    new Set(['pinboard', 'bookmark', 'link', 'uploaded', ...upstreamTags]),
  );

  const createdAt = post?.time ? new Date(post.time).toISOString() : undefined;

  const body = description
    ? `${description}\n\n${tagsRaw ? `Tags: ${tagsRaw}` : ''}`.trim()
    : tagsRaw
      ? `Tags: ${tagsRaw}`
      : '';

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'pinboard',
    createdAt,
    body,
    embedMetadata: {
      source: 'pinboard',
      title,
      url,
      pinboard_tags: upstreamTags,
    },
  });
}
