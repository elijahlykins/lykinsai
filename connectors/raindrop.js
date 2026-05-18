// ============================================================================
// connectors/raindrop.js — Raindrop.io OAuth adapter
// ============================================================================
// Pulls every saved bookmark from the user's Raindrop into the vault.
// Raindrop is a purpose-built bookmark service, so this is the cleanest 1:1
// "saved → vault" mapping in the entire connector catalog.
//
// API specifics:
//   • Auth URL : https://raindrop.io/oauth/authorize
//   • Token URL: https://raindrop.io/oauth/access_token  (JSON body)
//   • Tokens   : access ~14d, refresh tokens supported
//   • API base : https://api.raindrop.io/rest/v1
//   • All-collection id is `0` ("All bookmarks")
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const RD_AUTH_URL = 'https://raindrop.io/oauth/authorize';
const RD_TOKEN_URL = 'https://raindrop.io/oauth/access_token';
const RD_API = 'https://api.raindrop.io/rest/v1';

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_SYNC = 10; // 500 bookmarks per sync

function withTimeout(promise, ms, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export const raindropAdapter = {
  id: 'raindrop',

  buildAuthUrl({ clientId, redirectUri, state }) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
    });
    return `${RD_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const res = await withTimeout(
      fetch(RD_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      }),
      FETCH_TIMEOUT_MS,
      'raindrop-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Raindrop token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    if (j.error) throw new Error(`Raindrop: ${j.errorMessage || j.error}`);

    const accessToken = j.access_token;
    const refreshToken = j.refresh_token || null;
    const tokenExpiresAt = j.expires_in
      ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
      : null;

    const meRes = await withTimeout(
      fetch(`${RD_API}/user`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      FETCH_TIMEOUT_MS,
      'raindrop-me',
    );
    if (!meRes.ok) throw new Error(`Raindrop /user: HTTP ${meRes.status}`);
    const me = (await meRes.json()).user || {};

    return {
      providerUserId: String(me._id),
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: [],
      account: {
        handle: me.email?.split('@')[0] || me.fullName || 'raindrop',
        displayName: me.fullName || me.email,
        email: me.email,
        avatarUrl: me.avatar || null,
      },
      metadata: { raindrops_cursor: null },
    };
  },

  async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    const res = await withTimeout(
      fetch(RD_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      }),
      FETCH_TIMEOUT_MS,
      'raindrop-refresh',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ConnectorAuthError(`Raindrop refresh: HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const j = await res.json();
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token || undefined,
      tokenExpiresAt: j.expires_in
        ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
        : null,
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const cursorIso = connection.metadata?.raindrops_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let newest = cursorTime;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      // Collection 0 = "All bookmarks". Sort by created desc.
      const url = `${RD_API}/raindrops/0?perpage=${PAGE_SIZE}&page=${page}&sort=-created`;
      const res = await withTimeout(
        fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
        FETCH_TIMEOUT_MS,
        `raindrop-list-p${page}`,
      );
      if (res.status === 401 || res.status === 403) {
        throw new ConnectorAuthError(`Raindrop ${res.status}`);
      }
      if (!res.ok) throw new Error(`Raindrop list p${page}: HTTP ${res.status}`);

      const j = await res.json();
      const items = j.items || [];
      if (!items.length) break;

      for (const drop of items) {
        const created = new Date(drop.created || 0).getTime();
        if (cursorTime && created <= cursorTime) break pages;

        const result = await saveDropAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          drop,
        });
        if (result === 'saved' || result === 'updated') saved++;
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
            raindrops_cursor: new Date(newest).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

async function saveDropAsNote({ supabaseAdmin, userId, drop }) {
  const url = drop.link;
  if (!url) return 'skipped';

  const title = (drop.title || url).slice(0, 280);
  const description = (drop.excerpt || drop.note || '').slice(0, 1200);
  const image = drop.cover || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image,
    favicon: 'https://raindrop.io/favicon.ico',
    siteName: drop.domain || 'Raindrop.io',
    articleText: description,
    oembedType: 'raindrop',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  const dropTags = (drop.tags || []).map((t) => String(t).toLowerCase());
  const tags = ['raindrop', 'bookmark', ...dropTags, 'link', 'uploaded'];
  const createdAt = drop.created ? new Date(drop.created).toISOString() : undefined;

  // User's own annotation has priority over the article excerpt for
  // embedding — it captures *why* they saved it, not just what it is.
  const body = [
    drop.note ? `Note: ${drop.note}` : '',
    drop.excerpt && drop.excerpt !== drop.note ? '\n' + drop.excerpt : '',
    dropTags.length ? `\nTags: ${dropTags.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'raindrop_bookmark',
    createdAt,
    body,
    embedMetadata: { source: 'raindrop_bookmark', title, url, domain: drop.domain || '' },
  });
}
