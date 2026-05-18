// ============================================================================
// connectors/x.js — X (Twitter) v2 OAuth adapter
// ============================================================================
// Pulls every Bookmarked tweet into the vault.
//
// X API v2 specifics:
//   • Auth URL : https://twitter.com/i/oauth2/authorize  (PKCE required)
//   • Token URL: https://api.twitter.com/2/oauth2/token
//   • Auth     : HTTP Basic with client_id:client_secret (confidential client)
//   • Tokens   : 2h expiry, refresh_token via `offline.access` scope
//   • API base : https://api.twitter.com/2
//
// IMPORTANT — Paid API tier required for production:
//   The /2/users/:id/bookmarks endpoint is gated behind X's "Basic" tier
//   ($200/mo as of writing). Until your developer account is on Basic+, this
//   adapter will get HTTP 403 and we'll mark the connection as 'reauth' with
//   a clear error. The OAuth flow itself works on Free tier — you just can't
//   actually fetch bookmarks.
//
//   Endpoint reference:
//   https://docs.x.com/x-api/bookmarks/bookmarks-by-user-id
// ============================================================================

import crypto from 'crypto';
import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const X_AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const X_API = 'https://api.twitter.com/2';

export const SCOPES = [
  'tweet.read',
  'users.read',
  'bookmark.read',
  'offline.access', // required to get refresh_token
];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 4; // 400 bookmarks per sync

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

export const xAdapter = {
  id: 'x',
  needsPkce: true, // tells the framework to allocate a codeVerifier

  buildAuthUrl({ clientId, redirectUri, state, codeVerifier, scopes = SCOPES }) {
    if (!codeVerifier) throw new Error('X requires PKCE codeVerifier from framework');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return `${X_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      // X requires client_id in the body even when using HTTP Basic.
      client_id: clientId,
    });
    const res = await withTimeout(
      fetch(X_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'x-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`X token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    if (!accessToken) throw new Error('X did not return access_token');

    const refreshToken = j.refresh_token || null;
    const tokenExpiresAt = j.expires_in
      ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
      : null;

    const meRes = await withTimeout(
      fetch(`${X_API}/users/me`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      FETCH_TIMEOUT_MS,
      'x-me',
    );
    if (!meRes.ok) throw new Error(`X /users/me: HTTP ${meRes.status}`);
    const me = (await meRes.json()).data || {};

    return {
      providerUserId: String(me.id),
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: (j.scope || '').split(' ').filter(Boolean),
      account: {
        handle: me.username,
        displayName: me.name,
        email: null,
        avatarUrl: null,
      },
      metadata: {
        x_user_id: me.id,
        bookmarks_cursor: null,
      },
    };
  },

  async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    });
    const res = await withTimeout(
      fetch(X_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'x-refresh',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ConnectorAuthError(`X refresh: HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const j = await res.json();
    return {
      accessToken: j.access_token,
      // X rotates refresh tokens on every refresh; always store the new one.
      refreshToken: j.refresh_token || undefined,
      tokenExpiresAt: j.expires_in
        ? new Date(Date.now() + (Number(j.expires_in) - 60) * 1000)
        : null,
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const xUserId = connection.metadata?.x_user_id;
    if (!xUserId) throw new Error('X connection missing x_user_id');

    const cursorIso = connection.metadata?.bookmarks_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let paginationToken = null;
    let newest = cursorTime;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const params = new URLSearchParams({
        max_results: String(PAGE_SIZE),
        'tweet.fields': 'id,text,created_at,author_id,attachments,entities',
        expansions: 'author_id,attachments.media_keys',
        'user.fields': 'username,name,profile_image_url',
        'media.fields': 'preview_image_url,url,type',
        ...(paginationToken ? { pagination_token: paginationToken } : {}),
      });
      const url = `${X_API}/users/${xUserId}/bookmarks?${params}`;
      const res = await withTimeout(
        fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
        FETCH_TIMEOUT_MS,
        `x-bookmarks-p${page}`,
      );

      if (res.status === 401) {
        throw new ConnectorAuthError('X 401 invalid token');
      }
      if (res.status === 403) {
        const t = await res.text().catch(() => '');
        // Most likely: account is on Free tier, bookmarks requires Basic+.
        throw new ConnectorAuthError(
          `X 403 — bookmarks endpoint requires X API Basic tier. ${t.slice(0, 200)}`,
        );
      }
      if (res.status === 429) {
        console.warn('[x] rate-limited, will retry next cycle');
        break;
      }
      if (!res.ok) throw new Error(`X /bookmarks p${page}: HTTP ${res.status}`);

      const j = await res.json();
      const tweets = j.data || [];
      const includedUsers = j.includes?.users || [];
      const includedMedia = j.includes?.media || [];

      if (!tweets.length) break;

      // Build a quick author lookup since /bookmarks returns only ids.
      const userById = Object.fromEntries(includedUsers.map((u) => [u.id, u]));
      const mediaByKey = Object.fromEntries(includedMedia.map((m) => [m.media_key, m]));

      for (const tweet of tweets) {
        const created = new Date(tweet.created_at || 0).getTime();
        if (cursorTime && created <= cursorTime) break pages;

        const author = userById[tweet.author_id] || {};
        const result = await saveTweet({
          supabaseAdmin,
          userId: connection.user_id,
          tweet,
          author,
          mediaByKey,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        if (created > newest) newest = created;
      }

      paginationToken = j.meta?.next_token;
      if (!paginationToken) break;
    }

    if (newest && newest !== cursorTime) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            bookmarks_cursor: new Date(newest).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

async function saveTweet({ supabaseAdmin, userId, tweet, author, mediaByKey }) {
  const handle = author.username || '';
  const url = handle
    ? `https://x.com/${handle}/status/${tweet.id}`
    : `https://x.com/i/status/${tweet.id}`;

  const text = (tweet.text || '').replace(/\s+/g, ' ').slice(0, 1200);
  const title = `@${handle || 'x'}: ${text.slice(0, 100)}`.slice(0, 280);

  const mediaKeys = tweet.attachments?.media_keys || [];
  const firstMedia = mediaKeys.map((k) => mediaByKey[k]).find(Boolean);
  const image = firstMedia?.url || firstMedia?.preview_image_url || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: text,
    image,
    favicon: 'https://abs.twimg.com/favicons/twitter.3.ico',
    siteName: 'X',
    articleText: text,
    oembedType: 'twitter',
    oembedHtml: '',
    authorName: author.name || handle,
    authorHandle: handle ? `@${handle}` : '',
  };

  const tags = ['x', 'twitter', 'bookmark', 'link', 'uploaded'];
  const createdAt = tweet.created_at ? new Date(tweet.created_at).toISOString() : undefined;

  const body = [
    `${author.name || handle}${handle ? ` (@${handle})` : ''}`,
    '',
    text,
  ].filter(Boolean).join('\n');

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    // X tweets dedupe on the tweet id rather than the full URL because
    // legacy notes used the @handle form whose URL can vary if the
    // user later renames their account.
    dedupeNeedle: String(tweet.id),
    url,
    title,
    attachment,
    tags,
    source: 'x_bookmark',
    createdAt,
    body,
    embedMetadata: { source: 'x_bookmark', title, url, author_handle: handle, tweet_id: String(tweet.id) },
  });
}
