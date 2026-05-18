// ============================================================================
// connectors/canva.js — Canva Connect API adapter
// ============================================================================
// Pulls every design in the user's Canva account into the vault as a
// bookmark with the design thumbnail.
//
// Canva Connect API specifics:
//   • Auth URL : https://www.canva.com/api/oauth/authorize
//   • Token URL: https://api.canva.com/rest/v1/oauth/token
//   • Auth     : HTTP Basic with client_id:client_secret on token swap
//                AND PKCE (code_challenge_method=S256) is required
//   • Tokens   : access_token ~4 hours, refresh_token rotates on every refresh
//   • Scopes   : `design:meta:read profile:read` for read-only access
//   • API base : https://api.canva.com/rest/v1
//
// IMPORTANT: Until your Canva app is approved for production via the
// Canva Developer Portal, only the app's owner can authenticate. Submit
// for review at canva.com/developers.
// ============================================================================

import crypto from 'crypto';
import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const CV_AUTH_URL = 'https://www.canva.com/api/oauth/authorize';
const CV_TOKEN_URL = 'https://api.canva.com/rest/v1/oauth/token';
const CV_API = 'https://api.canva.com/rest/v1';

export const SCOPES = ['design:meta:read', 'profile:read'];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100; // Canva's max
const MAX_PAGES_PER_SYNC = 5;

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
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

// SHA-256 → base64url, no padding. RFC 7636 §4.2.
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

export const canvaAdapter = {
  id: 'canva',
  needsPkce: true, // Canva Connect requires PKCE on every flow

  buildAuthUrl({ clientId, redirectUri, state, codeVerifier, scopes = SCOPES }) {
    if (!codeVerifier) throw new Error('Canva requires PKCE codeVerifier from framework');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return `${CV_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const res = await withTimeout(
      fetch(CV_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'canva-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Canva token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    if (!accessToken) throw new Error('Canva did not return access_token');

    const refreshToken = j.refresh_token || null;
    const tokenExpiresAt = j.expires_in
      ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
      : null;

    // Get the user's profile so we can render their handle. The "users/me"
    // endpoint returns a User object with `team_user.user_id` and the
    // separate "users/me/profile" endpoint returns display_name.
    const meRes = await withTimeout(
      fetch(`${CV_API}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      FETCH_TIMEOUT_MS,
      'canva-me',
    );
    if (!meRes.ok) throw new Error(`Canva /users/me: HTTP ${meRes.status}`);
    const me = await meRes.json();
    const userId = me.team_user?.user_id || me.user_id || 'unknown';

    let displayName = '';
    try {
      const profRes = await fetch(`${CV_API}/users/me/profile`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (profRes.ok) {
        const prof = await profRes.json();
        displayName = prof.profile?.display_name || '';
      }
    } catch { /* optional */ }

    return {
      providerUserId: String(userId),
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: (j.scope || SCOPES.join(' ')).split(' ').filter(Boolean),
      account: {
        handle: displayName || String(userId),
        displayName: displayName || 'Canva user',
        email: null,
        avatarUrl: null,
      },
      metadata: {
        designs_cursor: null, // Tracks the latest design.updated_at we've seen
      },
    };
  },

  async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const res = await withTimeout(
      fetch(CV_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'canva-refresh',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ConnectorAuthError(`Canva refresh: HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const j = await res.json();
    return {
      accessToken: j.access_token,
      // Canva rotates refresh tokens on every refresh; always store the new one.
      refreshToken: j.refresh_token || undefined,
      tokenExpiresAt: j.expires_in
        ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
        : null,
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const cursorIso = connection.metadata?.designs_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let continuation = null;
    let newest = cursorTime;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        sort_by: 'modified_descending',
        ...(continuation ? { continuation } : {}),
      });
      const url = `${CV_API}/designs?${params}`;
      const res = await withTimeout(
        fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
        FETCH_TIMEOUT_MS,
        `canva-designs-p${page}`,
      );
      if (res.status === 401 || res.status === 403) {
        throw new ConnectorAuthError(`Canva ${res.status} on /designs`);
      }
      if (!res.ok) throw new Error(`Canva /designs p${page}: HTTP ${res.status}`);
      const data = await res.json();

      const designs = Array.isArray(data?.items) ? data.items : [];
      if (!designs.length) break;

      for (const d of designs) {
        // Canva's updated_at is a unix-seconds timestamp.
        const updatedSec = Number(d.updated_at || d.created_at || 0);
        const updatedMs = updatedSec ? updatedSec * 1000 : 0;
        if (cursorTime && updatedMs && updatedMs <= cursorTime) break pages;

        const result = await saveCanvaDesignAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          design: d,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        if (updatedMs > newest) newest = updatedMs;
      }

      continuation = data?.continuation || null;
      if (!continuation) break;
    }

    if (newest && newest !== cursorTime) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            designs_cursor: new Date(newest).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save a Canva design as a vault note
// ---------------------------------------------------------------------------
async function saveCanvaDesignAsNote({ supabaseAdmin, userId, design }) {
  if (!design?.id) return 'skipped';

  // Canva returns urls.edit_url ("...canva.com/design/<id>/<token>/edit")
  // and urls.view_url. Prefer view_url for vault items since edit_url
  // requires Canva login + edit access.
  const url =
    design.urls?.view_url ||
    design.urls?.edit_url ||
    `https://www.canva.com/design/${design.id}/view`;

  const title = design.title || 'Untitled Canva design';
  const thumbnail = design.thumbnail?.url || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: 'Canva design',
    image: thumbnail,
    favicon: 'https://www.canva.com/favicon.ico',
    siteName: 'Canva',
    articleText: '',
    oembedType: 'canva',
    oembedHtml: '',
    authorName: '',
    authorHandle: '',
  };

  const tags = ['canva', 'design', 'link', 'uploaded'];
  const createdAt = design.created_at
    ? new Date(Number(design.created_at) * 1000).toISOString()
    : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    // Canva designs dedupe on the design id rather than the URL
    // because view/edit URLs include a per-session token suffix that
    // varies between syncs.
    dedupeNeedle: design.id,
    url,
    title,
    attachment,
    tags,
    source: 'canva_design',
    createdAt,
    embedMetadata: { source: 'canva_design', title, url, design_id: design.id },
  });
}
