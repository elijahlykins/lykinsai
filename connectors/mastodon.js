// ============================================================================
// connectors/mastodon.js — Mastodon (per-instance OAuth) adapter
// ============================================================================
// Pulls every post the user has favourited and bookmarked into the vault.
//
// Mastodon's federation model means OAuth is per-instance — there's no
// global "Mastodon" account. The user types in their server URL (e.g.
// "mastodon.social", "hachyderm.io"), and we register a fresh OAuth app
// on THAT server before the popup opens. The dynamically-registered
// client_id and client_secret are stashed in oauth_states.metadata so
// the callback can complete the token exchange against the same instance.
//
// API specifics (mastodon.social and the rest of the standard ecosystem):
//   • Register : POST /api/v1/apps     → { client_id, client_secret, ... }
//   • Auth URL : GET  /oauth/authorize?response_type=code&...
//   • Token URL: POST /oauth/token     → { access_token, ... }
//   • API base : /api/v1/
//   • Tokens   : long-lived bearer tokens (no refresh in standard Mastodon)
//   • Scopes   : `read` covers favourites / bookmarks; we narrow to
//                `read:favourites read:bookmarks read:accounts` to be polite.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { assertUrlSafe, safeFetch } from '../lib/exterior/ssrfGuard.js';
import { saveConnectorNote } from './_save.js';

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 40; // Mastodon's max for these endpoints
const MAX_PAGES_PER_SYNC = 4;

export const SCOPES = ['read:favourites', 'read:bookmarks', 'read:accounts'];

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

// Normalize a user-supplied instance string to "https://hostname". Strips
// scheme, trailing slashes, paths. "mastodon.social", "https://mastodon.social/",
// "@user@hachyderm.io" → all become a clean origin URL.
function normalizeInstanceUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Mastodon instance URL is required.');
  // Allow paste of "@user@hachyderm.io" — pull just the host.
  if (s.startsWith('@')) {
    const parts = s.split('@').filter(Boolean);
    s = parts[parts.length - 1] || '';
  }
  s = s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) {
    throw new Error(`That doesn't look like a Mastodon instance hostname: ${input}`);
  }
  return `https://${s.toLowerCase()}`;
}

export const mastodonAdapter = {
  id: 'mastodon',
  authMode: 'per-instance',

  // Tells the framework to render a pre-field for the user's instance
  // before the popup opens. Surfaced in the OAuth dialog's catalog entry.
  oauthPrefields: [
    {
      name: 'instance',
      label: 'Your Mastodon instance',
      placeholder: 'mastodon.social',
      required: true,
      helpText:
        'The server your account lives on. Just the hostname (no https://). Examples: mastodon.social, hachyderm.io, fosstodon.org.',
    },
  ],

  /**
   * Register an OAuth app on the user's chosen instance and return the
   * dynamically-issued credentials. The framework persists these in the
   * oauth_states row's `metadata` so they're available at exchange time.
   */
  async prepareAuth({ prefields, redirectUri }) {
    const instanceUrl = normalizeInstanceUrl(prefields?.instance);
    const appsUrl = `${instanceUrl}/api/v1/apps`;
    const safe = await assertUrlSafe(appsUrl);
    if (!safe.ok) {
      throw new Error('Mastodon instance is not allowed (private or internal addresses are blocked).');
    }
    const res = await withTimeout(
      safeFetch(safe.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'LYKN',
          redirect_uris: redirectUri,
          scopes: SCOPES.join(' '),
          website: 'https://lykn.app',
        }),
      }),
      FETCH_TIMEOUT_MS,
      'mastodon-register',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(
        `Could not register an OAuth app on ${instanceUrl}: HTTP ${res.status} ${t.slice(0, 200)}`,
      );
    }
    const j = await res.json();
    if (!j.client_id || !j.client_secret) {
      throw new Error(`${instanceUrl} did not return OAuth client credentials.`);
    }
    return {
      clientId: j.client_id,
      clientSecret: j.client_secret,
      stateMetadata: {
        instance: instanceUrl,
        clientId: j.client_id,
        clientSecret: j.client_secret,
      },
    };
  },

  buildAuthUrl({ clientId, redirectUri, state, stateMetadata, scopes = SCOPES }) {
    const instanceUrl = stateMetadata?.instance;
    if (!instanceUrl) throw new Error('Mastodon buildAuthUrl missing instance from state metadata');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      state,
      force_login: 'false',
    });
    return `${instanceUrl}/oauth/authorize?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri, stateMetadata }) {
    const instanceUrl = stateMetadata?.instance;
    if (!instanceUrl) throw new Error('Mastodon exchangeCode missing instance from state metadata');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
    });
    const tokenUrl = `${instanceUrl}/oauth/token`;
    const tokenSafe = await assertUrlSafe(tokenUrl);
    if (!tokenSafe.ok) throw new Error('Mastodon instance is not allowed.');
    const res = await withTimeout(
      safeFetch(tokenSafe.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'mastodon-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Mastodon token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    const accessToken = j.access_token;
    if (!accessToken) throw new Error('Mastodon did not return access_token');

    // Fetch the verified credentials so we can identify the user.
    const meUrl = `${instanceUrl}/api/v1/accounts/verify_credentials`;
    const meSafe = await assertUrlSafe(meUrl);
    if (!meSafe.ok) throw new Error('Mastodon instance is not allowed.');
    const meRes = await withTimeout(
      safeFetch(meSafe.url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      FETCH_TIMEOUT_MS,
      'mastodon-me',
    );
    if (!meRes.ok) throw new Error(`Mastodon verify_credentials: HTTP ${meRes.status}`);
    const me = await meRes.json();

    // Stable provider_user_id needs to include the instance host so two
    // accounts named "alice" on different servers don't collide.
    const host = new URL(instanceUrl).host;
    const providerUserId = `${me.id}@${host}`;

    return {
      providerUserId,
      accessToken,
      refreshToken: null, // Standard Mastodon tokens don't expire / no refresh
      tokenExpiresAt: null,
      scopes: SCOPES,
      account: {
        handle: me.acct ? `${me.acct}@${host}` : `${me.username}@${host}`,
        displayName: me.display_name || me.username || `@${me.acct}`,
        email: null,
        avatarUrl: me.avatar || me.avatar_static || null,
      },
      metadata: {
        instance: instanceUrl,
        // Per-instance OAuth client creds: stored encrypted with the
        // connection so we can revoke the token at the instance later.
        instance_client_id: clientId,
        favourites_max_id: null,
        bookmarks_max_id: null,
      },
    };
  },

  /**
   * Pulls favourites and bookmarks. Mastodon paginates these with
   * Link headers (next: max_id=...). We track max_id per stream as
   * the cursor so subsequent syncs only walk newly-added items.
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const meta = connection.metadata || {};
    const instanceUrl = meta.instance;
    if (!instanceUrl) throw new Error('Mastodon connection missing instance.');

    let saved = 0;
    let skipped = 0;

    const updatedMeta = { ...meta };

    for (const stream of ['favourites', 'bookmarks']) {
      const cursorKey = `${stream}_max_id`;
      const sinceId = meta[cursorKey] || null;

      const result = await syncStream({
        instanceUrl,
        accessToken,
        stream,
        sinceId,
        userId: connection.user_id,
        supabaseAdmin,
      });
      saved += result.saved;
      skipped += result.skipped;
      if (result.newestId) {
        updatedMeta[cursorKey] = result.newestId;
      }
    }

    await supabaseAdmin
      .from('social_connections')
      .update({ metadata: updatedMeta })
      .eq('id', connection.id);

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Pull one paginated stream (favourites or bookmarks) and persist as notes
// ---------------------------------------------------------------------------
async function syncStream({
  instanceUrl,
  accessToken,
  stream, // "favourites" or "bookmarks"
  sinceId,
  userId,
  supabaseAdmin,
}) {
  let saved = 0;
  let skipped = 0;
  let newestId = sinceId;

  // Mastodon returns most-recent-first; walk pages until either we run
  // out of new items, hit the cursor, or hit MAX_PAGES_PER_SYNC.
  let nextUrl = new URL(`${instanceUrl}/api/v1/${stream}`);
  nextUrl.searchParams.set('limit', String(PAGE_SIZE));
  if (sinceId) nextUrl.searchParams.set('since_id', sinceId);

  pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
    const pageSafe = await assertUrlSafe(String(nextUrl));
    if (!pageSafe.ok) throw new Error('Mastodon pagination URL is not allowed.');
    const res = await withTimeout(
      safeFetch(pageSafe.url, { headers: { Authorization: `Bearer ${accessToken}` } }),
      FETCH_TIMEOUT_MS,
      `mastodon-${stream}-p${page}`,
    );
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorAuthError(`Mastodon ${res.status} on /${stream}`);
    }
    if (!res.ok) throw new Error(`Mastodon /${stream}: HTTP ${res.status}`);

    const items = await res.json();
    if (!Array.isArray(items) || !items.length) break;

    for (const status of items) {
      const result = await saveStatusAsNote({
        supabaseAdmin,
        userId,
        status,
        instanceHost: new URL(instanceUrl).host,
        stream,
      });
      if (result === 'saved' || result === 'updated') saved++;
      else skipped++;

      // Track the largest id we've seen — Mastodon ids are sortable
      // strings (snowflake-ish), so string compare works.
      if (!newestId || String(status.id) > String(newestId)) {
        newestId = String(status.id);
      }
    }

    // Mastodon's pagination is via the Link header: <...>; rel="next"
    const link = res.headers.get('link') || '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/i);
    if (!nextMatch) break;
    try {
      nextUrl = new URL(nextMatch[1]);
    } catch {
      break pages;
    }
  }

  return { saved, skipped, newestId };
}

// ---------------------------------------------------------------------------
// Save a single Mastodon status (post) as a vault note
// ---------------------------------------------------------------------------
async function saveStatusAsNote({ supabaseAdmin, userId, status, instanceHost, stream }) {
  if (!status?.url || !status?.id) return 'skipped';
  const url = status.url;

  // Mastodon `content` is HTML; strip tags for the description.
  const text = htmlToText(status.content || '').slice(0, 1200);
  const author = status.account || {};
  const handle = author.acct ? `${author.acct}@${instanceHost}` : author.username || '';
  const title = `@${handle}: ${text.slice(0, 100)}`.slice(0, 280);

  // Try to surface a media preview if the post has an image attachment.
  const firstMedia = Array.isArray(status.media_attachments)
    ? status.media_attachments.find((m) => m.type === 'image' || m.preview_url)
    : null;
  const image = firstMedia?.preview_url || firstMedia?.url || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: text,
    image,
    favicon: 'https://joinmastodon.org/favicon.ico',
    siteName: `Mastodon · ${instanceHost}`,
    articleText: text,
    oembedType: 'mastodon',
    oembedHtml: '',
    authorName: author.display_name || handle,
    authorHandle: `@${handle}`,
  };

  const tags = ['mastodon', stream === 'bookmarks' ? 'bookmark' : 'favourite', 'link', 'uploaded'];
  const createdAt = status.created_at ? new Date(status.created_at).toISOString() : undefined;
  const source = stream === 'bookmarks' ? 'mastodon_bookmark' : 'mastodon_favourite';

  const body = [
    `${author.display_name || handle} (@${handle})`,
    `Instance: ${instanceHost}`,
    '',
    text,
  ].filter(Boolean).join('\n');

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    // Mastodon statuses dedupe on the status id (instance-local) which
    // is shorter and more stable than the full federated URL.
    dedupeNeedle: String(status.id),
    url,
    title,
    attachment,
    tags,
    source,
    createdAt,
    body,
    embedMetadata: {
      source,
      title,
      url,
      author_handle: handle,
      instance: instanceHost,
      status_id: String(status.id),
    },
  });
}

// Cheap HTML stripper for Mastodon status content. Doesn't try to be a
// full parser — converts <br> / <p> to newlines, strips other tags,
// and decodes the handful of entities Mastodon actually emits.
function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
