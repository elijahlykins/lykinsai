// ============================================================================
// connectors/spotify.js — Spotify OAuth adapter
// ============================================================================
// Pulls the user's "Liked Songs" library into the vault. Each track becomes
// a bookmark note pointing at https://open.spotify.com/track/<id> with
// title "<artist> — <track>" and the album art as the preview image.
//
// Why just liked songs (and not playlists, albums, podcasts) for v1:
//   • Volume-bounded: most users have hundreds, not millions.
//   • Stable, simple endpoint with a `added_at` cursor for incremental sync.
//   • Most actionable in the vault — the things people save deliberately.
//
// Adding albums/podcasts is a follow-up: same adapter, more sync passes.
//
// API:
//   • Auth URL : https://accounts.spotify.com/authorize
//   • Token URL: https://accounts.spotify.com/api/token
//   • Auth     : HTTP Basic with client_id:client_secret (token + refresh)
//   • Tokens   : 3600s expiry, refresh_token rotates rarely (reuse)
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';

const SP_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SP_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SP_API = 'https://api.spotify.com/v1';

export const SCOPES = ['user-library-read', 'user-read-email'];

const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 50;
const MAX_PAGES_PER_SYNC = 10; // 500 tracks per sync

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

export const spotifyAdapter = {
  id: 'spotify',

  buildAuthUrl({ clientId, redirectUri, state, scopes = SCOPES }) {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
      scope: scopes.join(' '),
      // `show_dialog=false` reuses the user's existing authorization if
      // they've already granted us access. They still see the redirect.
      show_dialog: 'false',
    });
    return `${SP_AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const res = await withTimeout(
      fetch(SP_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'spotify-token',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Spotify token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const j = await res.json();
    if (j.error) throw new Error(`Spotify: ${j.error_description || j.error}`);

    const accessToken = j.access_token;
    const refreshToken = j.refresh_token || null;
    const tokenExpiresAt = j.expires_in
      ? new Date(Date.now() + (Number(j.expires_in) - 30) * 1000)
      : null;

    // Fetch profile.
    const meRes = await withTimeout(
      fetch(`${SP_API}/me`, { headers: { Authorization: `Bearer ${accessToken}` } }),
      FETCH_TIMEOUT_MS,
      'spotify-me',
    );
    if (!meRes.ok) throw new Error(`Spotify /me: HTTP ${meRes.status}`);
    const me = await meRes.json();

    return {
      providerUserId: String(me.id),
      accessToken,
      refreshToken,
      tokenExpiresAt,
      scopes: (j.scope || '').split(' ').filter(Boolean),
      account: {
        handle: me.id,
        displayName: me.display_name || me.id,
        email: me.email || null,
        avatarUrl: me.images?.[0]?.url || null,
      },
      metadata: {
        country: me.country,
        product: me.product,
        // Cursor: ISO timestamp of the most recently liked track.
        liked_cursor: null,
      },
    };
  },

  async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const res = await withTimeout(
      fetch(SP_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: basicAuth(clientId, clientSecret),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      }),
      FETCH_TIMEOUT_MS,
      'spotify-refresh',
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new ConnectorAuthError(`Spotify refresh failed: HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const j = await res.json();
    return {
      accessToken: j.access_token,
      // Spotify occasionally rotates refresh tokens; keep new if returned.
      refreshToken: j.refresh_token || undefined,
      tokenExpiresAt: j.expires_in
        ? new Date(Date.now() + (Number(j.expires_in) - 30) * 1000)
        : null,
    };
  },

  async sync({ connection, supabaseAdmin, accessToken }) {
    const cursorIso = connection.metadata?.liked_cursor || null;
    const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

    let saved = 0;
    let skipped = 0;
    let offset = 0;
    let newestAddedAt = cursorTime;

    pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
      // /me/tracks returns liked songs in reverse chronological order
      // (newest first by default).
      const url = `${SP_API}/me/tracks?limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await withTimeout(
        fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } }),
        FETCH_TIMEOUT_MS,
        `spotify-tracks-p${page}`,
      );

      if (res.status === 401 || res.status === 403) {
        const t = await res.text().catch(() => '');
        throw new ConnectorAuthError(`Spotify ${res.status}: ${t.slice(0, 200)}`);
      }
      if (res.status === 429) {
        // Rate limited — bail out, will retry next cycle.
        const retryAfter = Number(res.headers.get('retry-after')) || 30;
        console.warn(`[spotify] rate-limited, retry-after ${retryAfter}s`);
        break;
      }
      if (!res.ok) throw new Error(`Spotify /me/tracks page ${page}: HTTP ${res.status}`);

      const j = await res.json();
      const items = j.items || [];
      if (!items.length) break;

      for (const item of items) {
        const addedTime = new Date(item.added_at || 0).getTime();
        if (cursorTime && addedTime <= cursorTime) break pages;

        const result = await saveTrackAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          item,
        });
        if (result === 'saved') saved++;
        else skipped++;

        if (addedTime > newestAddedAt) newestAddedAt = addedTime;
      }

      if (items.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (newestAddedAt && newestAddedAt !== cursorTime) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: {
            ...(connection.metadata || {}),
            liked_cursor: new Date(newestAddedAt).toISOString(),
          },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save one liked track as a vault note
// ---------------------------------------------------------------------------
async function saveTrackAsNote({ supabaseAdmin, userId, item }) {
  const track = item.track || {};
  const url = track.external_urls?.spotify || (track.id ? `https://open.spotify.com/track/${track.id}` : '');
  if (!url) return 'skipped';

  const { data: existing } = await supabaseAdmin
    .from('notes')
    .select('id')
    .eq('user_id', userId)
    .ilike('content', `%${url}%`)
    .limit(1);
  if (existing && existing.length > 0) return 'skipped';

  const trackName = track.name || 'Track';
  const artists = (track.artists || []).map((a) => a.name).filter(Boolean);
  const artistStr = artists.join(', ') || 'Unknown artist';
  const albumName = track.album?.name || '';
  const albumImage = track.album?.images?.[0]?.url || '';
  const durationMs = Number(track.duration_ms) || 0;

  const title = `${artistStr} — ${trackName}`.slice(0, 280);
  const description = albumName
    ? `${albumName}${durationMs ? ` · ${formatDuration(durationMs)}` : ''}`
    : '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: albumImage,
    favicon: 'https://open.spotifycdn.com/cdn/images/favicon.5cb2bd30.ico',
    siteName: 'Spotify',
    articleText: description,
    oembedType: 'spotify',
    oembedHtml: '',
    authorName: artistStr,
    authorHandle: '',
  };
  const noteContent = `${title}\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;

  const tags = ['spotify', 'liked', 'music', 'link', 'uploaded'];
  const addedAt = item.added_at ? new Date(item.added_at).toISOString() : undefined;

  const { error } = await supabaseAdmin
    .from('notes')
    .insert({
      user_id: userId,
      title,
      content: noteContent,
      source: 'spotify_liked',
      tags,
      created_at: addedAt,
    });
  if (error) {
    const { error: err2 } = await supabaseAdmin
      .from('notes')
      .insert({ user_id: userId, title, content: noteContent });
    if (err2) {
      console.error(`[spotify] note insert failed for ${url}:`, err2.message);
      return 'skipped';
    }
  }
  return 'saved';
}

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
