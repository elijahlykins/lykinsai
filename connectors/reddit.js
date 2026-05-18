// ============================================================================
// connectors/reddit.js — Reddit OAuth adapter
// ============================================================================
// Pulls the user's Saved feed (posts + comments) into the vault.
//
// Reddit OAuth specifics:
//   • Auth URL    : https://www.reddit.com/api/v1/authorize
//   • Token URL   : https://www.reddit.com/api/v1/access_token
//   • Auth        : HTTP Basic with client_id:client_secret on token swap
//   • Token       : bearer, 3600s expiry, refresh_token issued when
//                   duration=permanent is requested
//   • UA REQUIRED : Reddit blocks generic UAs. We send "LYKN-Connector/1.0".
//
// Scopes:  `identity history save` (read-only, just the saved feed).
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const REDDIT_AUTH_URL = 'https://www.reddit.com/api/v1/authorize';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_API = 'https://oauth.reddit.com';

export const SCOPES = ['identity', 'history', 'save'];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 5; // 500 saved items per sync

const UA = 'LYKN-Connector/1.0';

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

export const redditAdapter = {
  id: 'reddit',

  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      state,
      redirect_uri: redirectUri,
      // `permanent` issues a refresh_token; `temporary` does not. We need
      // refresh tokens because Reddit access tokens expire in 1 hour and
      // we sync hourly.
      duration: 'permanent',
      scope: scopes.join(' '),
    });
    return `${REDDIT_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const res = await withTimeout(
      fetch(REDDIT_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'reddit-token',
    );
    if (!res.ok) throw new Error(`Reddit token exchange: HTTP ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`Reddit: ${j.error}`);

    const accessToken = j.access_token;
    const refreshToken = j.refresh_token || null;
    const tokenExpiresAt = j.expires_in
      ? new Date(Date.now() + (Number(j.expires_in) - 30) * 1000)
      : null;

    // /api/v1/me for the user's identity.
    const meRes = await withTimeout(
      fetch(`${REDDIT_API}/api/v1/me`, {
        headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA },
      }),
      FETCH_TIMEOUT_MS,
      'reddit-me',
    );
    if (!meRes.ok) throw new Error(`Reddit /api/v1/me: HTTP ${meRes.status}`);
    const me = await meRes.json();

    return {
      providerUserId: String(me.id),
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: (j.scope || '').split(' ').filter(Boolean),
      account: {
        handle: me.name,
        displayName: me.subreddit?.title || me.name,
        email: null,
        avatarUrl: me.icon_img || me.snoovatar_img || null,
      },
      metadata: {
        username: me.name,
        saved_cursor: null,        // Reddit "fullname" of the most-recent saved item we've seen
      },
    };
  },

  async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const res = await withTimeout(
      fetch(REDDIT_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'reddit-refresh',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ConnectorAuthError(`Reddit refresh failed: HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const j = await res.json();
    return {
      accessToken: j.access_token,
      // Reddit doesn't reissue refresh_token on refresh — keep the existing one.
      refreshToken: undefined,
      tokenExpiresAt: j.expires_in
        ? new Date(Date.now() + (Number(j.expires_in) - 30) * 1000)
        : null,
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const username = connection.metadata?.username || connection.account_handle;
    if (!username) throw new Error('Reddit connection missing username');

    const cursorFullname = connection.metadata?.saved_cursor || null;

    let saved = 0;
    let skipped = 0;
    let after = null;
    let newestFullname = null;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        raw_json: '1',
        ...(after ? { after } : {}),
      });
      const url = `${REDDIT_API}/user/${encodeURIComponent(username)}/saved?${params}`;
      const res = await withTimeout(
        fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA },
        }),
        FETCH_TIMEOUT_MS,
        `reddit-saved-p${page}`,
      );

      if (res.status === 401 || res.status === 403) {
        const t = await res.text().catch(() => '');
        throw new ConnectorAuthError(`Reddit ${res.status}: ${t.slice(0, 200)}`);
      }
      if (!res.ok) throw new Error(`Reddit /saved page ${page}: HTTP ${res.status}`);

      const j = await res.json();
      const items = j?.data?.children || [];
      if (!items.length) break;

      for (const child of items) {
        const fullname = child?.data?.name; // e.g. "t3_xxx" or "t1_xxx"
        if (!fullname) continue;

        // Reached items we've already saved.
        if (cursorFullname && fullname === cursorFullname) break pages;

        if (!newestFullname) newestFullname = fullname;

        const result = await saveItemAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          child,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;
      }

      after = j?.data?.after || null;
      if (!after) break; // last page
    }

    if (newestFullname) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: { ...(connection.metadata || {}), saved_cursor: newestFullname },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save one /saved item as a vault note
// ---------------------------------------------------------------------------
async function saveItemAsNote({ supabaseAdmin, userId, child }) {
  const kind = child.kind; // "t3" = post, "t1" = comment
  const d = child.data || {};

  const isPost = kind === 't3';
  const url = isPost
    ? (d.url_overridden_by_dest || `https://www.reddit.com${d.permalink}`)
    : `https://www.reddit.com${d.permalink}`;
  if (!url) return 'skipped';

  const subreddit = d.subreddit_name_prefixed || (d.subreddit ? `r/${d.subreddit}` : '');
  const author = d.author ? `u/${d.author}` : '';
  const title = isPost
    ? (d.title || url).slice(0, 280)
    : `Comment in ${subreddit || 'reddit'}`.slice(0, 280);

  const description = isPost
    ? (d.selftext || `Posted in ${subreddit}`).slice(0, 1200)
    : (d.body || '').slice(0, 1200);

  const image = isPost
    ? (d.thumbnail && /^https?:\/\//.test(d.thumbnail) ? d.thumbnail : '')
    : '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image,
    favicon: 'https://www.redditstatic.com/desktop2x/img/favicon/favicon-32x32.png',
    siteName: subreddit || 'Reddit',
    articleText: description,
    oembedType: 'reddit',
    oembedHtml: '',
    authorName: author,
    authorHandle: author,
  };

  const tags = ['reddit', 'saved', isPost ? 'post' : 'comment', 'link', 'uploaded'];
  if (d.subreddit) tags.push(`r/${d.subreddit}`);

  const createdAt = d.created_utc ? new Date(Number(d.created_utc) * 1000).toISOString() : undefined;

  // Embed body: subreddit + author + selftext/comment body. Reddit
  // saves are append-only from the user's POV, but we still upsert
  // so an edited self-post reflects.
  const body = [
    subreddit ? `Subreddit: ${subreddit}` : '',
    author ? `Author: ${author}` : '',
    description ? '\n' + description : '',
  ].filter(Boolean).join('\n');

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: isPost ? 'reddit_saved_post' : 'reddit_saved_comment',
    createdAt,
    body,
    embedMetadata: { source: isPost ? 'reddit_saved_post' : 'reddit_saved_comment', title, url, subreddit, author },
  });
}
