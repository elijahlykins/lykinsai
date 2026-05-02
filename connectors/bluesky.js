// ============================================================================
// connectors/bluesky.js — Bluesky (AT Protocol) adapter
// ============================================================================
// Pulls every post the user has liked into the vault.
//
// Auth model: Bluesky's official OAuth (DPoP-based) is still in beta and
// painful to integrate. The stable, recommended-by-Bluesky path for
// third-party apps is **App Passwords** — the user creates a scoped
// password at bsky.app → Settings → App passwords and pastes it here.
//   • App passwords have full account scope, but they're per-app, named,
//     and revocable from the Bluesky settings UI without affecting the
//     user's main login. That's the same security posture as Slack's
//     legacy tokens or X premium tokens.
//   • We never see or store the user's real password.
//
// XRPC endpoints used:
//   • com.atproto.server.createSession    → identifier + password → JWTs
//   • com.atproto.server.refreshSession   → refreshJwt → fresh JWTs
//   • app.bsky.feed.getActorLikes         → likes for the authed actor
//
// Tokens: accessJwt expires ~2 hours, refreshJwt is long-lived. The
// framework's `refreshAccessToken` hook keeps the access token fresh.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';

const BSKY_PDS = 'https://bsky.social';
const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 4; // 400 likes per sync

function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

async function bskyXrpc(path, { method = 'GET', authToken, body, query } = {}) {
  const url = new URL(`${BSKY_PDS}/xrpc/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const init = {
    method,
    headers: {
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  const res = await withTimeout(fetch(url, init), FETCH_TIMEOUT_MS, `bsky-${path}`);
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Bluesky ${res.status} on ${path}`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Bluesky ${path}: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

export const blueskyAdapter = {
  id: 'bluesky',
  authMode: 'token',

  /**
   * Validates a (handle, app password) pair via createSession and produces
   * a connection-ready object. fields = { identifier, password }.
   *   identifier: handle ("user.bsky.social") OR DID OR email
   *   password:   app password (xxxx-xxxx-xxxx-xxxx)
   */
  async connectWithToken({ fields }) {
    const identifier = String(fields?.identifier || '').trim().replace(/^@/, '');
    const password = String(fields?.password || '').trim();
    if (!identifier) throw new Error('Bluesky handle is required.');
    if (!password) throw new Error('Bluesky app password is required.');

    let session;
    try {
      session = await bskyXrpc('com.atproto.server.createSession', {
        method: 'POST',
        body: { identifier, password },
      });
    } catch (err) {
      // createSession returns 401 with message "Invalid identifier or
      // password" for bad creds; surface a friendly version.
      if (/401|invalid/i.test(err.message)) {
        throw new Error(
          'Bluesky rejected those credentials. Double-check your handle and that the app password is correct (not your account password).',
        );
      }
      throw err;
    }

    const accessJwt = session.accessJwt;
    const refreshJwt = session.refreshJwt;
    if (!accessJwt || !refreshJwt) {
      throw new Error('Bluesky did not return session tokens.');
    }

    return {
      providerUserId: session.did,
      accessToken: accessJwt,
      refreshToken: refreshJwt,
      // accessJwt expires ~2 hours; refresh ~10 minutes early.
      tokenExpiresAt: new Date(Date.now() + 110 * 60 * 1000),
      scopes: ['app:full-account'],
      account: {
        handle: session.handle || identifier,
        displayName: session.handle || identifier,
        email: session.email || null,
        avatarUrl: null, // fetched later if we wanted; not required for v1
      },
      metadata: {
        did: session.did,
        likes_cursor: null, // tracks the indexedAt of the newest like seen
      },
    };
  },

  /**
   * Refresh the short-lived accessJwt using the longer-lived refreshJwt.
   * Bluesky rotates refreshJwt on every refresh — store the new one.
   */
  async refreshAccessToken({ refreshToken /* clientId/clientSecret unused */ }) {
    const data = await bskyXrpc('com.atproto.server.refreshSession', {
      method: 'POST',
      authToken: refreshToken,
    });
    return {
      accessToken: data.accessJwt,
      refreshToken: data.refreshJwt,
      tokenExpiresAt: new Date(Date.now() + 110 * 60 * 1000),
    };
  },

  /**
   * Pulls the user's likes via app.bsky.feed.getActorLikes. Each like →
   * one vault note pointing at the post URL.
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const did = connection.metadata?.did;
    if (!did) throw new Error('Bluesky connection missing did.');

    const cursorIso = connection.metadata?.likes_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let pageCursor = null;
    let newestIso = cursorIso;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      const data = await bskyXrpc('app.bsky.feed.getActorLikes', {
        authToken: accessToken,
        query: {
          actor: did,
          limit: PAGE_SIZE,
          ...(pageCursor ? { cursor: pageCursor } : {}),
        },
      });

      const feed = Array.isArray(data?.feed) ? data.feed : [];
      if (!feed.length) break;

      for (const item of feed) {
        const post = item.post;
        if (!post?.uri) continue;

        // The like's "indexedAt" comes back on the post itself; bsky doesn't
        // expose the timestamp of when the user liked it (just when the
        // post was indexed). Good enough for cursor purposes.
        const indexedAt = post.indexedAt || post.record?.createdAt || null;
        if (cursorTime && indexedAt && new Date(indexedAt).getTime() <= cursorTime) {
          break pages;
        }

        const result = await saveBskyPostAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          post,
        });
        if (result === 'saved') saved++;
        else skipped++;

        if (indexedAt && (!newestIso || new Date(indexedAt) > new Date(newestIso))) {
          newestIso = indexedAt;
        }
      }

      pageCursor = data.cursor || null;
      if (!pageCursor) break;
    }

    if (newestIso && newestIso !== cursorIso) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            likes_cursor: newestIso,
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save a single Bluesky post as a vault note
// ---------------------------------------------------------------------------
async function saveBskyPostAsNote({ supabaseAdmin, userId, post }) {
  // post.uri looks like at://did:plc:abc/app.bsky.feed.post/3kxyz
  // The web URL is https://bsky.app/profile/<handle>/post/<rkey>.
  const handle = post.author?.handle || '';
  const rkey = String(post.uri || '').split('/').pop();
  if (!handle || !rkey) return 'skipped';
  const url = `https://bsky.app/profile/${handle}/post/${rkey}`;

  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .ilike('content', `%${rkey}%`)
    .limit(1);
  if (existing && existing.length > 0) return 'skipped';

  const text = (post.record?.text || '').replace(/\s+/g, ' ').slice(0, 1200);
  const authorName = post.author?.displayName || handle;
  const title = `@${handle}: ${text.slice(0, 100)}`.slice(0, 280);

  // Try to surface a post image if the embed has one. Bluesky embeds
  // come in several shapes (#view records); check the most common.
  const image = pickPostImage(post);

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description: text,
    image: image || '',
    favicon: 'https://web-cdn.bsky.app/static/favicon-32x32.png',
    siteName: 'Bluesky',
    articleText: text,
    oembedType: 'bluesky',
    oembedHtml: '',
    authorName,
    authorHandle: `@${handle}`,
  };

  const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;
  const tags = ['bluesky', 'like', 'link', 'uploaded'];
  const createdAt = post.record?.createdAt
    ? new Date(post.record.createdAt).toISOString()
    : undefined;

  const { error } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: userId,
      title,
      content: noteContent,
      source: 'bluesky_like',
      tags,
      created_at: createdAt,
    });
  if (error) {
    const { error: err2 } = await supabaseAdmin
      .from('notes')
      .insert({ user_id: userId, title, content: noteContent });
    if (err2) {
      console.error(`[bluesky] note insert failed for ${url}:`, err2.message);
      return 'skipped';
    }
  }
  return 'saved';
}

// Bluesky embeds nest several layers. The two most common shapes are
//   embed.images[].fullsize / .thumb           (image embed)
//   embed.media.images[].fullsize              (record-with-media)
// Anything else (external link cards, video embeds) we ignore for v1.
function pickPostImage(post) {
  const embed = post.embed || {};
  const direct = embed.images?.[0]?.fullsize || embed.images?.[0]?.thumb;
  if (direct) return direct;
  const nested =
    embed.media?.images?.[0]?.fullsize ||
    embed.media?.images?.[0]?.thumb;
  if (nested) return nested;
  const ext = embed.external?.thumb;
  if (ext) return ext;
  return '';
}
