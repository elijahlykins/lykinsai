// ============================================================================
// connectors/dribbble.js — Dribbble OAuth adapter
// ============================================================================
// Pulls every shot the user has liked into the vault as a bookmark with
// the shot's preview image.
//
// Dribbble API specifics:
//   • Auth URL : https://dribbble.com/oauth/authorize
//   • Token URL: https://dribbble.com/oauth/token   (JSON body, no Basic)
//   • Tokens   : long-lived bearer (no expiry, no refresh)
//   • Scope    : `public` for read-only access to the user's data
//   • API base : https://api.dribbble.com/v2
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';

const DR_AUTH_URL = 'https://dribbble.com/oauth/authorize';
const DR_TOKEN_URL = 'https://dribbble.com/oauth/token';
const DR_API = 'https://api.dribbble.com/v2';

export const SCOPES = ['public'];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 4;

function withTimeout(promise, ms, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export const dribbbleAdapter = {
  id: 'dribbble',

  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: scopes.join(' '),
    });
    return `${DR_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const res = await withTimeout(
      fetch(DR_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      }),
      FETCH_TIMEOUT_MS,
      'dribbble-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Dribbble token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    if (!accessToken) throw new Error('Dribbble did not return access_token');

    const meRes = await withTimeout(
      fetch(`${DR_API}/user`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      FETCH_TIMEOUT_MS,
      'dribbble-me',
    );
    if (!meRes.ok) throw new Error(`Dribbble /user: HTTP ${meRes.status}`);
    const me = await meRes.json();

    return {
      providerUserId: String(me.id),
      accessToken,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: (j.scope || '').split(' ').filter(Boolean),
      account: {
        handle: me.login || me.username,
        displayName: me.name,
        email: null,
        avatarUrl: me.avatar_url,
      },
      metadata: { likes_cursor: null },
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const cursorIso = connection.metadata?.likes_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let newest = cursorTime;

    pages: for (let page = 1; page <= MAX_PAGES_PER_SYNC; page++) {
      const url = `${DR_API}/user/likes?per_page=${PAGE_SIZE}&page=${page}`;
      const res = await withTimeout(
        fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
        FETCH_TIMEOUT_MS,
        `dribbble-likes-p${page}`,
      );
      if (res.status === 401 || res.status === 403) {
        throw new ConnectorAuthError(`Dribbble ${res.status}`);
      }
      if (!res.ok) throw new Error(`Dribbble /user/likes p${page}: HTTP ${res.status}`);

      const items = await res.json();
      if (!Array.isArray(items) || !items.length) break;

      for (const like of items) {
        // Likes endpoint wraps the shot inside a `shot` object with the
        // like's own created_at — that's what we want for the cursor.
        const shot = like.shot || like;
        const likedAt = new Date(like.created_at || shot.published_at || 0).getTime();
        if (cursorTime && likedAt <= cursorTime) break pages;

        const result = await saveShotAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          shot,
          likedAt: like.created_at,
        });
        if (result === 'saved') saved++;
        else skipped++;

        if (likedAt > newest) newest = likedAt;
      }

      if (items.length < PAGE_SIZE) break;
    }

    if (newest && newest !== cursorTime) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            likes_cursor: new Date(newest).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

async function saveShotAsNote({ supabaseAdmin, userId, shot, likedAt }) {
  const url = shot.html_url || shot.url;
  if (!url) return 'skipped';

  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .ilike('content', `%${url}%`)
    .limit(1);
  if (existing && existing.length > 0) return 'skipped';

  const title = (shot.title || 'Dribbble shot').slice(0, 280);
  const description = (shot.description || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 1200);
  const image =
    shot.images?.hidpi ||
    shot.images?.normal ||
    shot.images?.teaser ||
    '';
  const author = shot.user?.name || '';
  const handle = shot.user?.login || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image,
    favicon: 'https://cdn.dribbble.com/assets/favicon-b38525134603b9513174ec887944bde1a869eb6cd414f4d640ee48ab2a15a26b.ico',
    siteName: 'Dribbble',
    articleText: description,
    oembedType: 'dribbble',
    oembedHtml: '',
    authorName: author,
    authorHandle: handle ? `@${handle}` : '',
  };
  const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

  const tags = ['dribbble', 'design', 'liked', 'link', 'uploaded'];
  const createdAt = likedAt ? new Date(likedAt).toISOString() : undefined;

  const { error } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: userId,
      title,
      content: noteContent,
      source: 'dribbble_liked',
      tags,
      created_at: createdAt,
    });
  if (error) {
    const { error: err2 } = await supabaseAdmin
      .from('notes')
      .insert({ user_id: userId, title, content: noteContent });
    if (err2) {
      console.error(`[dribbble] note insert failed for ${url}:`, err2.message);
      return 'skipped';
    }
  }
  return 'saved';
}
