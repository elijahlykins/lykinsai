// ============================================================================
// connectors/pinterest.js — Pinterest OAuth adapter
// ============================================================================
// Pulls every pin the user has saved into the vault.
//
// Pinterest API v5 specifics:
//   • Auth URL : https://www.pinterest.com/oauth/
//   • Token URL: https://api.pinterest.com/v5/oauth/token
//   • Auth     : HTTP Basic with client_id:client_secret
//   • Tokens   : access ~30d, refresh ~60d
//   • Scopes   : boards:read, pins:read, user_accounts:read (read-only)
//
// IMPORTANT: until your Pinterest app is approved for production access,
// only your own developer account can authenticate. Submit for review at
// https://developers.pinterest.com/apps/<your_app>/ → "Trial advanced
// access" → upgrade.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const PIN_AUTH_URL = 'https://www.pinterest.com/oauth/';
const PIN_TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token';
const PIN_API = 'https://api.pinterest.com/v5';

export const SCOPES = ['boards:read', 'pins:read', 'user_accounts:read'];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 5;

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

export const pinterestAdapter = {
  id: 'pinterest',

  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      scope: scopes.join(','),
    });
    return `${PIN_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const res = await withTimeout(
      fetch(PIN_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'pinterest-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Pinterest token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();

    const accessToken = j.access_token;
    const refreshToken = j.refresh_token || null;
    const tokenExpiresAt = j.expires_in
      ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
      : null;

    const meRes = await withTimeout(
      fetch(`${PIN_API}/user_account`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      FETCH_TIMEOUT_MS,
      'pinterest-me',
    );
    if (!meRes.ok) throw new Error(`Pinterest /user_account: HTTP ${meRes.status}`);
    const me = await meRes.json();

    return {
      providerUserId: String(me.id || me.username),
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: SCOPES,
      account: {
        handle: me.username,
        displayName: `${me.first_name || ''} ${me.last_name || ''}`.trim() || me.username,
        email: null,
        avatarUrl: me.profile_image || null,
      },
      metadata: { pin_cursor: null },
    };
  },

  async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const res = await withTimeout(
      fetch(PIN_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'pinterest-refresh',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ConnectorAuthError(`Pinterest refresh failed: HTTP ${res.status} ${t.slice(0, 120)}`);
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
    const cursorIso = connection.metadata?.pin_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let bookmark = undefined;
    let newest = cursorTime;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const params = new URLSearchParams({
        page_size: String(PAGE_SIZE),
        ...(bookmark ? { bookmark } : {}),
      });
      const res = await withTimeout(
        fetch(`${PIN_API}/pins?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        FETCH_TIMEOUT_MS,
        `pinterest-pins-p${page}`,
      );
      if (res.status === 401 || res.status === 403) {
        const t = await res.text().catch(() => '');
        throw new ConnectorAuthError(`Pinterest ${res.status}: ${t.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`Pinterest /pins page ${page}: HTTP ${res.status}`);

      const j = await res.json();
      const items = j.items || [];
      if (!items.length) break;

      for (const item of items) {
        const created = new Date(item.created_at || 0).getTime();
        if (cursorTime && created <= cursorTime) break pages;

        const result = await savePinAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          pin: item,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        if (created > newest) newest = created;
      }

      bookmark = j.bookmark;
      if (!bookmark) break;
    }

    if (newest && newest !== cursorTime) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            pin_cursor: new Date(newest).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

async function savePinAsNote({ supabaseAdmin, userId, pin }) {
  const url = pin.link || (pin.id ? `https://www.pinterest.com/pin/${pin.id}/` : '');
  if (!url) return 'skipped';

  const title = (pin.title || pin.alt_text || pin.description || 'Pinterest Pin').slice(0, 280);
  const description = (pin.description || '').slice(0, 1200);
  const image = pin.media?.images?.['600x']?.url ||
    pin.media?.images?.['1200x']?.url ||
    pin.media?.images?.original?.url ||
    '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image,
    favicon: 'https://s.pinimg.com/webapp/favicon-54a5b2af.png',
    siteName: 'Pinterest',
    articleText: description,
    oembedType: 'pinterest',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  const tags = ['pinterest', 'pin', 'link', 'uploaded'];
  const createdAt = pin.created_at ? new Date(pin.created_at).toISOString() : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'pinterest_pin',
    createdAt,
    body: description,
    embedMetadata: { source: 'pinterest_pin', title, url },
  });
}
