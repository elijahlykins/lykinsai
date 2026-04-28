// ============================================================================
// connectors/vimeo.js — Vimeo OAuth adapter
// ============================================================================
// Pulls every video the user has liked into the vault.
//
// Vimeo API specifics:
//   • Auth URL : https://api.vimeo.com/oauth/authorize
//   • Token URL: https://api.vimeo.com/oauth/access_token
//   • Auth     : HTTP Basic with client_id:client_secret
//   • Tokens   : bearer, no expiry by default
//   • Header   : Accept: application/vnd.vimeo.*+json;version=3.4
//   • Scopes   : `public private` for read-only access to the user's data
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';

const VIM_AUTH_URL = 'https://api.vimeo.com/oauth/authorize';
const VIM_TOKEN_URL = 'https://api.vimeo.com/oauth/access_token';
const VIM_API = 'https://api.vimeo.com';
const VIM_ACCEPT = 'application/vnd.vimeo.*+json;version=3.4';

export const SCOPES = ['public', 'private'];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 50;
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

function basicAuth(clientId, clientSecret) {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function vimeoHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: VIM_ACCEPT,
  };
}

export const vimeoAdapter = {
  id: 'vimeo',

  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      scope: scopes.join(' '),
    });
    return `${VIM_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const res = await withTimeout(
      fetch(VIM_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: VIM_ACCEPT,
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'vimeo-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Vimeo token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    if (!accessToken) throw new Error('Vimeo did not return access_token');

    // /me uses the same token; the response includes the user object.
    const me = j.user || {};
    return {
      providerUserId: String(me.uri ? me.uri.split('/').pop() : ''),
      accessToken,
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: (j.scope || '').split(' ').filter(Boolean),
      account: {
        handle: (me.link || '').split('/').pop() || me.name,
        displayName: me.name,
        email: null,
        avatarUrl: me.pictures?.sizes?.[me.pictures.sizes.length - 1]?.link || null,
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
      const url = `${VIM_API}/me/likes?per_page=${PAGE_SIZE}&page=${page}&sort=date&direction=desc&fields=uri,name,description,link,duration,created_time,user.name,user.uri,pictures.sizes`;
      const res = await withTimeout(
        fetch(url, { headers: vimeoHeaders(accessToken) }),
        FETCH_TIMEOUT_MS,
        `vimeo-likes-p${page}`,
      );
      if (res.status === 401 || res.status === 403) {
        const t = await res.text().catch(() => '');
        throw new ConnectorAuthError(`Vimeo ${res.status}: ${t.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`Vimeo /me/likes page ${page}: HTTP ${res.status}`);

      const j = await res.json();
      const items = j.data || [];
      if (!items.length) break;

      for (const video of items) {
        // /me/likes doesn't expose a per-like timestamp via the standard
        // shape, so we approximate "newer than last sync" by published
        // created_time of the video. Good enough — same dedupe behavior
        // as RSS, plus URL dedupe.
        const created = new Date(video.created_time || 0).getTime();
        if (cursorTime && created <= cursorTime) break pages;

        const result = await saveVideoAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          video,
        });
        if (result === 'saved') saved++;
        else skipped++;

        if (created > newest) newest = created;
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

async function saveVideoAsNote({ supabaseAdmin, userId, video }) {
  const url = video.link;
  if (!url) return 'skipped';

  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .ilike('content', `%${url}%`)
    .limit(1);
  if (existing && existing.length > 0) return 'skipped';

  const title = (video.name || 'Vimeo video').slice(0, 280);
  const description = (video.description || '').replace(/\s+/g, ' ').slice(0, 1200);
  const author = video.user?.name || '';
  const sizes = video.pictures?.sizes || [];
  const image = sizes[sizes.length - 1]?.link || sizes[0]?.link || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image,
    favicon: 'https://i.vimeocdn.com/favicon/main-touch_180',
    siteName: 'Vimeo',
    articleText: description,
    oembedType: 'vimeo',
    oembedHtml: '',
    authorName: author,
    authorHandle: '',
  };
  const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

  const tags = ['vimeo', 'video', 'liked', 'link', 'uploaded'];
  const createdAt = video.created_time ? new Date(video.created_time).toISOString() : undefined;

  const { error } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: userId,
      title,
      content: noteContent,
      source: 'vimeo_liked',
      tags,
      created_at: createdAt,
    });
  if (error) {
    const { error: err2 } = await supabaseAdmin
      .from('notes')
      .insert({ user_id: userId, title, content: noteContent });
    if (err2) {
      console.error(`[vimeo] note insert failed for ${url}:`, err2.message);
      return 'skipped';
    }
  }
  return 'saved';
}
