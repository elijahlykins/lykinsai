// ============================================================================
// connectors/google/_shared.js — Google OAuth 2.0 shared helpers
// ============================================================================
// Every Google service (YouTube, Drive, Calendar, Gmail) hits the same auth
// endpoints with different scopes. This module factors out the boilerplate so
// each service file just declares { id, scopes, sync } and gets a complete
// Adapter back via createGoogleAdapter().
//
// Google specifics:
//   • Auth URL  : https://accounts.google.com/o/oauth2/v2/auth
//   • Token URL : https://oauth2.googleapis.com/token
//   • Userinfo  : https://www.googleapis.com/oauth2/v3/userinfo
//   • Auth      : application/x-www-form-urlencoded; client_secret in body
//   • Tokens    : 3600s expiry, refresh_token issued ONLY when access_type=
//                 offline + prompt=consent on the auth URL
//   • PII scope : `openid email profile` always included (free, identifies
//                 the user across services so we can dedupe by Google id)
//
// IMPORTANT: Drive / Gmail / Calendar / YouTube are SENSITIVE or RESTRICTED
// scopes in Google's policy. Production access requires verification (4–6
// weeks) including CASA penetration testing for restricted scopes (Gmail
// readonly). Until verified, only allowlisted test users can authorize.
// See https://developers.google.com/cloud/api-control/google-api-services-user-data-policy
// ============================================================================

import { ConnectorAuthError } from '../../connectors-service.js';
import { embedAndStoreChunks } from '../../synthesis-service.js';

const G_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const G_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const G_USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

// `openid email profile` is always included so we can identify the Google
// user across services (id is stable; email is human-readable).
const BASE_SCOPES = ['openid', 'email', 'profile'];

const FETCH_TIMEOUT_MS = 12_000;

export function withTimeout(promise, ms = FETCH_TIMEOUT_MS, label = 'fetch') {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * Factory: returns a full Adapter object given the per-service config.
 *
 *   id            connector id matching catalog.js (e.g. "youtube")
 *   scopes        array of Google OAuth scopes specific to this service
 *   sync          async ({ connection, supabaseAdmin, accessToken }) → { saved, skipped }
 *   initialMeta   optional initial metadata for the connection row
 */
export function createGoogleAdapter({ id, scopes, sync, initialMeta = {} }) {
  const fullScopes = Array.from(new Set([...BASE_SCOPES, ...scopes]));

  return {
    id,

    buildAuthUrl({ clientId, redirectUri, state }) {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        state,
        scope: fullScopes.join(' '),
        // Force consent so the user gets a refresh_token even if they
        // previously authorized us — Google only issues refresh_tokens
        // on the *first* authorization unless we explicitly re-prompt.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
      });
      return `${G_AUTH_URL}?${params.toString()}`;
    },

    async exchangeCode({ code, clientId, clientSecret, redirectUri }) {
      const body = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const res = await withTimeout(
        fetch(G_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }),
        FETCH_TIMEOUT_MS,
        `${id}-token`,
      );
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Google ${id} token exchange: HTTP ${res.status} ${t.slice(0, 200)}`);
      }
      const j = await res.json();
      const accessToken = j.access_token;
      if (!accessToken) throw new Error('Google did not return access_token');

      const refreshToken = j.refresh_token || null;
      const tokenExpiresAt = j.expires_in
        ? new Date(Date.now() + (Number(j.expires_in) - 30) * 1000)
        : null;

      const me = await fetchUserinfo(accessToken);
      return {
        providerUserId: String(me.sub),
        accessToken,
        refreshToken,
        tokenExpiresAt,
        scopes: (j.scope || '').split(' ').filter(Boolean),
        account: {
          handle: me.email?.split('@')[0] || me.name,
          displayName: me.name,
          email: me.email || null,
          avatarUrl: me.picture || null,
        },
        metadata: { ...initialMeta },
      };
    },

    async refreshAccessToken({ refreshToken, clientId, clientSecret }) {
      const body = new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      });
      const res = await withTimeout(
        fetch(G_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }),
        FETCH_TIMEOUT_MS,
        `${id}-refresh`,
      );
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new ConnectorAuthError(`Google ${id} refresh: HTTP ${res.status} ${t.slice(0, 120)}`);
      }
      const j = await res.json();
      return {
        accessToken: j.access_token,
        // Google does NOT reissue refresh_token on refresh; reuse the existing one.
        refreshToken: undefined,
        tokenExpiresAt: j.expires_in
          ? new Date(Date.now() + (Number(j.expires_in) - 30) * 1000)
          : null,
      };
    },

    sync,
  };
}

async function fetchUserinfo(accessToken) {
  const res = await withTimeout(
    fetch(G_USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } }),
    FETCH_TIMEOUT_MS,
    'google-userinfo',
  );
  if (!res.ok) throw new Error(`Google /userinfo: HTTP ${res.status}`);
  return await res.json();
}

// ---------------------------------------------------------------------------
// Common note-saving helper for Google content
// ---------------------------------------------------------------------------
/**
 * Upsert a Google item as a vault note (deduped by URL) and — when a
 * `body` is supplied — push it through the synthesis embed pipeline so
 * vector retrieval can find it the same way it finds Notion pages.
 *
 * Returns 'saved' (new row), 'updated' (existing row's title/content
 * refreshed because the upstream item changed) or 'skipped' (no URL,
 * insert error, or row already up to date).
 *
 * Why upsert + embed (not the original "skip if URL present"):
 *   1. Drive docs get renamed, Calendar events get rescheduled, etc.
 *      The old skip-on-URL path silently dropped those edits.
 *   2. Without `embedAndStoreChunks`, AI semantic retrieval misses
 *      every connector-imported note. Gmail / Calendar / Drive items
 *      lived in the vault but were invisible to chat retrieval —
 *      Notion was the only adapter wired through. Centralising the
 *      embed call here closes that loop for every Google service.
 */
export async function saveGoogleNote({
  supabaseAdmin,
  userId,
  url,
  title,
  attachment,
  tags,
  source,
  createdAt,
  // Optional plain-text body to embed for synthesis retrieval. When
  // present we also append it to `content` (after the attachments
  // marker, same layout as Notion) so MCP `lykn_searchVault`'s
  // substring search picks it up too. When absent we only embed the
  // bookmark shell (title + description) which is still better than
  // nothing for retrieval.
  body = '',
  // Extra fields stamped onto the synthesis chunk's metadata column.
  // Defaults to `{ source, title, url }` if not provided.
  embedMetadata = null,
}) {
  if (!url) return 'skipped';

  // `noteContent` layout matches Notion's: title, attachments JSON,
  // optional body. The vault UI parses the JSON marker for the
  // bookmark card; the substring/embed paths read the entire string.
  const attachmentsLine = `[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;
  const noteContent = body
    ? [title, '', attachmentsLine, '\n' + body].join('\n').trim()
    : `${title}\n\n${attachmentsLine}`;

  // Find an existing row for this URL. We key on a substring scan
  // because the bookmark JSON always embeds the canonical URL and
  // those URLs are stable across edits (Gmail message id, Calendar
  // event id, Drive file id, etc.).
  const { data: existingRows } = await supabaseAdmin
    .from('notes')
    .select('id, content')
    .eq('user_id', userId)
    .ilike('content', `%${url}%`)
    .limit(1);
  const existing = existingRows && existingRows[0];

  let noteId = existing?.id || null;
  let mode = existing ? 'updated' : 'saved';

  if (existing) {
    // No-op if upstream content is unchanged — saves a write per sync
    // for the >99% of items that haven't changed since last poll.
    if (String(existing.content || '') === noteContent) {
      // Still re-embed if body is present and chunks might be stale;
      // embedAndStoreChunks itself short-circuits on hash match so this
      // is cheap.
      mode = 'skipped';
    } else {
      const { error: updErr } = await supabaseAdmin
        .from('notes')
        .update({
          title,
          content: noteContent,
          // Backfill source + tags on every update. Rows created before
          // the `source` column existed (or that hit the fallback insert
          // path below in an earlier sync) carry NULL source/tags, which
          // prevents the vault folder-collapse logic from rolling them
          // up under their connector tile (e.g. all Calendar events end
          // up as loose bookmark cards instead of one "Google Calendar"
          // folder). Re-stamping on each upstream change retroactively
          // classifies them the first time the row changes upstream,
          // without needing a separate backfill migration.
          source,
          tags,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .eq('user_id', userId);
      if (updErr) {
        console.error(`[${source}] note update failed for ${url}:`, updErr.message);
        return 'skipped';
      }
    }
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('notes')
      .insert({
        user_id: userId,
        title,
        content: noteContent,
        source,
        tags,
        created_at: createdAt,
      })
      .select('id')
      .single();
    if (insErr) {
      // Fallback: caps trigger / column error → degrade to a minimal
      // insert with no source/tags so the user at least sees the row.
      const { data: insFallback, error: err2 } = await supabaseAdmin
        .from('notes')
        .insert({ user_id: userId, title, content: noteContent })
        .select('id')
        .single();
      if (err2) {
        console.error(`[${source}] note insert failed for ${url}:`, err2.message);
        return 'skipped';
      }
      noteId = insFallback?.id || null;
    } else {
      noteId = inserted?.id || null;
    }
  }

  // Fire-and-forget synthesis embed. We always try to embed (even on
  // 'skipped' / no body) because the chunk store is keyed on
  // (user_id, source_type, source_id, chunk_index) and the helper is
  // hash-skip idempotent — running it on every sync is essentially
  // free for unchanged items but guarantees freshly-renamed Drive
  // docs / re-described Calendar events / etc. land in the vector
  // store the same tick we update the vault.
  if (noteId) {
    const embedText = body
      ? `${title}\n\n${body}`.trim()
      : `${title}\n\n${attachment?.description || ''}`.trim();
    if (embedText && embedText.length >= 8) {
      try {
        const result = await embedAndStoreChunks({
          supabaseAdmin,
          userId,
          sourceType: 'vault_note',
          sourceId: noteId,
          text: embedText,
          metadata: embedMetadata || { source, title, url },
        });
        if (!result.ok && result.reason && result.reason !== 'openai_key_missing') {
          console.warn(`[${source}] embed failed for ${url}: ${result.reason}`);
        }
      } catch (err) {
        // Embedding is best-effort; never let an OpenAI 429 break sync.
        console.warn(`[${source}] embed threw for ${url}: ${err.message}`);
      }
    }
  }

  return mode;
}

// ---------------------------------------------------------------------------
// Google API request helper with auth-error promotion
// ---------------------------------------------------------------------------
export async function gFetch(url, accessToken, init = {}, label = 'google') {
  const res = await withTimeout(
    fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers || {}),
      },
    }),
    FETCH_TIMEOUT_MS,
    label,
  );
  if (res.status === 401 || res.status === 403) {
    const t = await res.text().catch(() => '');
    throw new ConnectorAuthError(`${label} ${res.status}: ${t.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return res.json();
}
