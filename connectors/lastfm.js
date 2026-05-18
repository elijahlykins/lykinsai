// ============================================================================
// connectors/lastfm.js — Last.fm adapter (username-only, shared API key)
// ============================================================================
// Pulls a user's loved tracks from Last.fm into the vault as bookmark notes.
// Each loved track becomes one note pointing at the track's last.fm URL.
//
// Auth model: Last.fm exposes user.getLovedTracks publicly with just a
// server-side API key and the target username — no per-user OAuth flow
// needed for read-only access to a user's public loves. We use a shared
// LASTFM_API_KEY env var (registered once at https://www.last.fm/api/account/create);
// the user just pastes their public username.
//
// If the user later wants private/scrobble-write access we can extend this
// to the full Last.fm Mobile/Desktop auth flow — but for the vault use
// case (catalog what I've loved) the public path is sufficient and frictionless.
//
// Rate limit: Last.fm allows ~5 req/sec per IP. We page with 200 results
// per call and cap at 5 pages per sync (1000 tracks/cycle), well under
// any sane ceiling.
// ============================================================================

import { ConnectorAuthError } from '../connectors-service.js';
import { saveConnectorNote } from './_save.js';

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';
const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 200;
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

function lastfmApiKey() {
  return process.env.LASTFM_API_KEY || '';
}

async function lfm(params, label) {
  const url = new URL(LASTFM_API);
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', lastfmApiKey());
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await withTimeout(
    fetch(url, { headers: { 'User-Agent': 'LYKN-Connector/1.0' } }),
    FETCH_TIMEOUT_MS,
    `lastfm-${label}`,
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError(`Last.fm ${res.status}: API key rejected`);
  }
  if (!res.ok) {
    throw new Error(`Last.fm ${label}: HTTP ${res.status}`);
  }
  const data = await res.json();
  // Last.fm error envelope: { error: 6, message: "User not found" }
  if (data?.error) {
    if (data.error === 6) throw new Error(`Last.fm: ${data.message || 'User not found'}`);
    if (data.error === 10 || data.error === 26) {
      throw new ConnectorAuthError(`Last.fm: ${data.message || 'API key invalid'}`);
    }
    throw new Error(`Last.fm error ${data.error}: ${data.message || 'unknown'}`);
  }
  return data;
}

export const lastfmAdapter = {
  id: 'lastfm',
  authMode: 'token',

  // Last.fm needs our server-side API key — the user only supplies their
  // public username. Without LASTFM_API_KEY set, the tile is "Not configured".
  isReady({ env }) {
    return Boolean(env?.LASTFM_API_KEY);
  },
  envHint: 'LASTFM_API_KEY',

  async connectWithToken({ fields }) {
    const username = String(fields?.username || '').trim();
    if (!username) throw new Error('Last.fm username is required.');
    if (!/^[A-Za-z0-9._-]{2,30}$/.test(username)) {
      throw new Error('That doesn\'t look like a valid Last.fm username.');
    }

    // user.getInfo doubles as our existence check.
    const info = await lfm({ method: 'user.getInfo', user: username }, 'user-info');
    const user = info?.user;
    if (!user || !user.name) {
      throw new Error(`No such Last.fm user: ${username}`);
    }

    return {
      providerUserId: String(user.name),
      accessToken: String(user.name),
      refreshToken: null,
      tokenExpiresAt: null,
      scopes: ['public_user'],
      account: {
        handle: user.name,
        displayName: user.realname || user.name,
        email: null,
        avatarUrl: pickImage(user.image),
      },
      metadata: {
        country: user.country || '',
        // Unix timestamp (seconds) of the most recent loved track we've
        // already saved. Subsequent syncs walk pages until we cross it.
        last_loved_uts: null,
      },
    };
  },

  /**
   * Pulls newly-loved tracks since `last_loved_uts` and saves each as a
   * vault note. Returns { saved, skipped }.
   */
  async sync({ connection, supabaseAdmin, accessToken }) {
    const username = accessToken;
    const meta = connection.metadata || {};
    const cursorUts = meta.last_loved_uts ? Number(meta.last_loved_uts) : null;

    let saved = 0;
    let skipped = 0;
    let newestUts = cursorUts;

    pages: for (let page = 1; page <= MAX_PAGES_PER_SYNC; page++) {
      const data = await lfm(
        {
          method: 'user.getLovedTracks',
          user: username,
          limit: PAGE_SIZE,
          page,
        },
        `loved-p${page}`,
      );

      const tracks = data?.lovedtracks?.track;
      const arr = Array.isArray(tracks) ? tracks : tracks ? [tracks] : [];
      if (arr.length === 0) break;

      for (const t of arr) {
        const uts = Number(t?.date?.uts || 0);
        // Once we hit a track older than our cursor, we're caught up.
        if (cursorUts && uts && uts <= cursorUts) break pages;

        const result = await saveLovedTrackAsNote({
          supabaseAdmin,
          userId: connection.user_id,
          track: t,
        });
        if (result === 'saved' || result === 'updated') saved++;
        else skipped++;

        if (uts && (!newestUts || uts > newestUts)) newestUts = uts;
      }

      if (arr.length < PAGE_SIZE) break;
    }

    if (newestUts && newestUts !== cursorUts) {
      await supabaseAdmin
        .from('social_connections')
        .update({
          metadata: { ...(connection.metadata || {}), last_loved_uts: newestUts },
        })
        .eq('id', connection.id);
    }

    return { saved, skipped };
  },
};

// ---------------------------------------------------------------------------
// Save one loved track as a vault note
// ---------------------------------------------------------------------------
async function saveLovedTrackAsNote({ supabaseAdmin, userId, track }) {
  const artist = track?.artist?.name || '';
  const trackName = track?.name || '';
  const url = track?.url || '';
  if (!url || !trackName) return 'skipped';

  const title = artist ? `${artist} — ${trackName}` : trackName;
  const image = pickImage(track?.image);
  const description = artist
    ? `Loved track by ${artist} on Last.fm`
    : 'Loved track on Last.fm';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image: image || '',
    favicon: 'https://www.last.fm/static/images/favicon.702b239b.ico',
    siteName: 'Last.fm',
    articleText: description,
    oembedType: 'lastfm',
    oembedHtml: '',
    authorName: artist,
    authorHandle: '',
  };

  const tags = ['lastfm', 'loved', 'music', 'link', 'uploaded'];

  const createdAt = track?.date?.uts
    ? new Date(Number(track.date.uts) * 1000).toISOString()
    : undefined;

  return saveConnectorNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags,
    source: 'lastfm_loved',
    createdAt,
    body: `Loved on Last.fm${artist ? ` · by ${artist}` : ''}`,
    embedMetadata: {
      source: 'lastfm_loved',
      title,
      url,
      artist,
      track: trackName,
    },
  });
}

// ---------------------------------------------------------------------------
// Last.fm images arrive as an array of { '#text': url, size: 'small'|'medium'|'large'|'extralarge' }
// Pick the largest available, fall back to '' for the all-zero placeholder.
// ---------------------------------------------------------------------------
function pickImage(images) {
  if (!Array.isArray(images)) return '';
  const order = ['extralarge', 'large', 'medium', 'small'];
  for (const size of order) {
    const m = images.find((i) => i && i.size === size && i['#text']);
    if (m) return m['#text'];
  }
  return '';
}
