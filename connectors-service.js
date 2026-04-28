// ============================================================================
// connectors-service.js — Generic OAuth connector framework
// ============================================================================
// Imported only by server.js. Owns:
//
//   • CONNECTOR_REGISTRY — adapter map, keyed by provider id (matches
//     catalog.js connector ids one-to-one).
//   • Token encryption (AES-256-GCM) so access/refresh tokens are never at
//     rest in plaintext, even with DB read access.
//   • OAuth dance helpers — start (mint state row + auth URL) + callback
//     (validate state + exchange code + persist connection).
//   • Sync orchestration — single `runSync(connection)` entry point that
//     dispatches to the adapter, handles auth errors, updates lifecycle
//     fields. Plus a fan-out `pollDueConnections` for the background loop.
//
// Each provider lives in connectors/<id>.js and implements the Adapter
// interface (see ADAPTER SPEC below). Adding a new connector = drop in a
// new file + register it here.
// ============================================================================

import crypto from 'crypto';
import { githubAdapter } from './connectors/github.js';
import { redditAdapter } from './connectors/reddit.js';
import { notionAdapter } from './connectors/notion.js';
import { spotifyAdapter } from './connectors/spotify.js';
import { pinterestAdapter } from './connectors/pinterest.js';
import { linearAdapter } from './connectors/linear.js';
import { todoistAdapter } from './connectors/todoist.js';
import { vimeoAdapter } from './connectors/vimeo.js';
import { raindropAdapter } from './connectors/raindrop.js';
import { dribbbleAdapter } from './connectors/dribbble.js';
import { youtubeAdapter } from './connectors/google/youtube.js';
import { driveAdapter } from './connectors/google/drive.js';
import { calendarAdapter } from './connectors/google/calendar.js';
import { gmailAdapter } from './connectors/google/gmail.js';
import { microsoftAdapter } from './connectors/microsoft.js';
import { slackAdapter } from './connectors/slack.js';
import { xAdapter } from './connectors/x.js';

// ---------------------------------------------------------------------------
// Adapter spec (informal — JS, no types)
// ---------------------------------------------------------------------------
//   id: string
//   buildAuthUrl({ clientId, redirectUri, state, scopes }) → string
//   exchangeCode({ code, clientId, clientSecret, redirectUri, codeVerifier? })
//       → { providerUserId, accessToken, refreshToken?, tokenExpiresAt?,
//           scopes, account: { handle, displayName, email, avatarUrl },
//           metadata }
//   sync({ connection, supabaseAdmin, accessToken })
//       → { saved: int, skipped: int }
//   refreshAccessToken?({ refreshToken, clientId, clientSecret })   // optional
//       → { accessToken, refreshToken?, tokenExpiresAt? }
//   needsPkce?: boolean                                              // optional
// ---------------------------------------------------------------------------

export const CONNECTOR_REGISTRY = {
  github: githubAdapter,
  reddit: redditAdapter,
  notion: notionAdapter,
  spotify: spotifyAdapter,
  pinterest: pinterestAdapter,
  linear: linearAdapter,
  todoist: todoistAdapter,
  vimeo: vimeoAdapter,
  raindrop: raindropAdapter,
  dribbble: dribbbleAdapter,
  // ── Google bundle (single client_id covers all four services) ─────
  youtube: youtubeAdapter,
  'google-drive': driveAdapter,
  'google-calendar': calendarAdapter,
  gmail: gmailAdapter,
  // ── Microsoft / Slack ─────────────────────────────────────────────
  'outlook-365': microsoftAdapter,
  slack: slackAdapter,
  // ── X / Twitter (paid-tier required for /bookmarks) ───────────────
  x: xAdapter,
};

// Where each provider's credentials live in process.env. Keeping this as a
// flat object means we never hardcode env-var names inside adapters and we
// can validate availability at boot.
export const PROVIDER_CREDENTIALS = {
  github: {
    clientId: () => process.env.GITHUB_CLIENT_ID,
    clientSecret: () => process.env.GITHUB_CLIENT_SECRET,
  },
  reddit: {
    clientId: () => process.env.REDDIT_CLIENT_ID,
    clientSecret: () => process.env.REDDIT_CLIENT_SECRET,
  },
  notion: {
    clientId: () => process.env.NOTION_CLIENT_ID,
    clientSecret: () => process.env.NOTION_CLIENT_SECRET,
  },
  spotify: {
    clientId: () => process.env.SPOTIFY_CLIENT_ID,
    clientSecret: () => process.env.SPOTIFY_CLIENT_SECRET,
  },
  pinterest: {
    clientId: () => process.env.PINTEREST_CLIENT_ID,
    clientSecret: () => process.env.PINTEREST_CLIENT_SECRET,
  },
  linear: {
    clientId: () => process.env.LINEAR_CLIENT_ID,
    clientSecret: () => process.env.LINEAR_CLIENT_SECRET,
  },
  todoist: {
    clientId: () => process.env.TODOIST_CLIENT_ID,
    clientSecret: () => process.env.TODOIST_CLIENT_SECRET,
  },
  vimeo: {
    clientId: () => process.env.VIMEO_CLIENT_ID,
    clientSecret: () => process.env.VIMEO_CLIENT_SECRET,
  },
  raindrop: {
    clientId: () => process.env.RAINDROP_CLIENT_ID,
    clientSecret: () => process.env.RAINDROP_CLIENT_SECRET,
  },
  dribbble: {
    clientId: () => process.env.DRIBBBLE_CLIENT_ID,
    clientSecret: () => process.env.DRIBBBLE_CLIENT_SECRET,
  },
  // All Google services share one OAuth client. Configure GOOGLE_CLIENT_ID
  // and GOOGLE_CLIENT_SECRET in Google Cloud Console; the four entries
  // below just dispatch to the same env vars. `envPrefix` is used by the
  // boot diagnostics so the missing-config message says "GOOGLE_..." (not
  // "YOUTUBE_...").
  youtube: {
    envPrefix: 'GOOGLE',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  'google-drive': {
    envPrefix: 'GOOGLE',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  'google-calendar': {
    envPrefix: 'GOOGLE',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  gmail: {
    envPrefix: 'GOOGLE',
    clientId: () => process.env.GOOGLE_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_CLIENT_SECRET,
  },
  'outlook-365': {
    envPrefix: 'MICROSOFT',
    clientId: () => process.env.MICROSOFT_CLIENT_ID,
    clientSecret: () => process.env.MICROSOFT_CLIENT_SECRET,
  },
  slack: {
    clientId: () => process.env.SLACK_CLIENT_ID,
    clientSecret: () => process.env.SLACK_CLIENT_SECRET,
  },
  x: {
    clientId: () => process.env.X_CLIENT_ID,
    clientSecret: () => process.env.X_CLIENT_SECRET,
  },
};

// Returns the env-var prefix used by `<PREFIX>_CLIENT_ID` /
// `<PREFIX>_CLIENT_SECRET` for the given provider. Used by the server's
// boot diagnostics to print the right hint when credentials are missing.
export function envPrefixFor(provider) {
  const creds = PROVIDER_CREDENTIALS[provider];
  if (!creds) return provider.toUpperCase();
  return creds.envPrefix || provider.toUpperCase().replace(/-/g, '_');
}

export function isProviderConfigured(provider) {
  const creds = PROVIDER_CREDENTIALS[provider];
  if (!creds) return false;
  return Boolean(creds.clientId() && creds.clientSecret());
}

// ---------------------------------------------------------------------------
// Sentinel: token revoked / refresh failed → flip status to 'reauth'
// ---------------------------------------------------------------------------
export class ConnectorAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectorAuthError';
    this.isAuthError = true;
  }
}

// ---------------------------------------------------------------------------
// Token encryption (AES-256-GCM)
// ---------------------------------------------------------------------------
// Format: <iv_b64>:<auth_tag_b64>:<ciphertext_b64>
// Key:    CONNECTOR_TOKEN_KEY env var, hex-encoded 32 bytes (64 hex chars).
//         Run `openssl rand -hex 32` to generate.
//
// Encrypted text is opaque at the SQL layer; only this module decrypts.
// If CONNECTOR_TOKEN_KEY is missing we refuse to encrypt rather than
// silently storing plaintext.

const ALGO = 'aes-256-gcm';

function getKey() {
  const hex = process.env.CONNECTOR_TOKEN_KEY;
  if (!hex) {
    throw new Error(
      'CONNECTOR_TOKEN_KEY is not set. Generate one with: openssl rand -hex 32',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'CONNECTOR_TOKEN_KEY must be 64 hex chars (32 bytes). Run: openssl rand -hex 32',
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encryptToken(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV is GCM standard
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptToken(blob) {
  if (!blob) return null;
  const parts = String(blob).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted token blob');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

// ---------------------------------------------------------------------------
// OAuth state helpers
// ---------------------------------------------------------------------------
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function newOpaqueId(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Generates a state string and persists a row in oauth_states. Returns
 * the state plus optional codeVerifier (for PKCE flows in adapters that
 * declare needsPkce).
 */
export async function createOAuthState({
  supabaseAdmin,
  userId,
  provider,
  redirectAfter,
  pkce = false,
}) {
  const state = newOpaqueId(24);
  let codeVerifier = null;
  if (pkce) {
    // PKCE: codeVerifier is a random URL-safe string (43–128 chars).
    codeVerifier = newOpaqueId(64);
  }
  const { error } = await supabaseAdmin.from('oauth_states').insert({
    state,
    user_id: userId,
    provider,
    code_verifier: codeVerifier,
    redirect_after: redirectAfter || null,
  });
  if (error) {
    throw new Error(`Could not create OAuth state: ${error.message}`);
  }
  return { state, codeVerifier };
}

/**
 * Looks up a state row by its opaque id, validates freshness, and
 * deletes it (one-shot). Returns the row, or throws.
 */
export async function consumeOAuthState({ supabaseAdmin, state, provider }) {
  if (!state) throw new Error('Missing state');
  const { data, error } = await supabaseAdmin
    .from('oauth_states')
    .select('*')
    .eq('state', state)
    .eq('provider', provider)
    .maybeSingle();

  if (error) throw new Error(`State lookup failed: ${error.message}`);
  if (!data) throw new Error('Invalid or expired state');

  const ageMs = Date.now() - new Date(data.created_at).getTime();
  if (ageMs > STATE_TTL_MS) {
    await supabaseAdmin.from('oauth_states').delete().eq('state', state);
    throw new Error('OAuth state expired');
  }

  // One-shot: delete immediately so a captured state can't be replayed.
  await supabaseAdmin.from('oauth_states').delete().eq('state', state);
  return data;
}

/**
 * Periodically called from the background loop to garbage-collect any
 * states that were never consumed (user closed the popup, etc.).
 */
export async function pruneExpiredOAuthStates(supabaseAdmin) {
  const cutoff = new Date(Date.now() - STATE_TTL_MS).toISOString();
  await supabaseAdmin.from('oauth_states').delete().lt('created_at', cutoff);
}

// ---------------------------------------------------------------------------
// Connection persistence
// ---------------------------------------------------------------------------
/**
 * Upserts a fresh connection row using the result of an adapter's
 * exchangeCode. Returns the inserted/updated row (without token columns).
 */
export async function saveConnection({
  supabaseAdmin,
  userId,
  provider,
  exchanged,
}) {
  const row = {
    user_id: userId,
    provider,
    provider_user_id: exchanged.providerUserId,
    account_handle: exchanged.account?.handle || null,
    account_display_name: exchanged.account?.displayName || null,
    account_email: exchanged.account?.email || null,
    account_avatar_url: exchanged.account?.avatarUrl || null,
    scopes: exchanged.scopes || [],
    access_token: encryptToken(exchanged.accessToken),
    refresh_token: exchanged.refreshToken ? encryptToken(exchanged.refreshToken) : null,
    token_expires_at: exchanged.tokenExpiresAt
      ? new Date(exchanged.tokenExpiresAt).toISOString()
      : null,
    metadata: exchanged.metadata || {},
    status: 'active',
    consecutive_errors: 0,
    last_error: null,
  };

  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .upsert(row, { onConflict: 'user_id,provider,provider_user_id' })
    .select(
      'id, provider, provider_user_id, account_handle, account_display_name, ' +
      'account_email, account_avatar_url, scopes, status, last_synced_at, ' +
      'last_sync_count, total_synced_count, sync_interval_minutes, created_at',
    )
    .single();

  if (error) throw new Error(`saveConnection: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// Sync orchestration
// ---------------------------------------------------------------------------
/**
 * Runs a single sync against one connection. Decrypts the token, calls
 * the adapter's sync(), writes lifecycle updates back to the row.
 */
export async function runSync({ supabaseAdmin, connection }) {
  const adapter = CONNECTOR_REGISTRY[connection.provider];
  if (!adapter) {
    throw new Error(`No adapter registered for provider "${connection.provider}"`);
  }

  let accessToken;
  try {
    accessToken = decryptToken(connection.access_token);
  } catch (err) {
    await markConnectionError(supabaseAdmin, connection, `decrypt: ${err.message}`, true);
    return { saved: 0, skipped: 0, status: 'reauth' };
  }

  // If the token is known-expired and the adapter supports refresh, do
  // that first. (Not used by GitHub OAuth Apps but Reddit/Notion/Spotify
  // will need this path.)
  if (
    connection.token_expires_at &&
    new Date(connection.token_expires_at).getTime() < Date.now() + 60_000 &&
    typeof adapter.refreshAccessToken === 'function' &&
    connection.refresh_token
  ) {
    try {
      const creds = PROVIDER_CREDENTIALS[connection.provider];
      const refresh = await adapter.refreshAccessToken({
        refreshToken: decryptToken(connection.refresh_token),
        clientId: creds.clientId(),
        clientSecret: creds.clientSecret(),
      });
      accessToken = refresh.accessToken;
      await supabaseAdmin
        .from('social_connections')
        .update({
          access_token: encryptToken(refresh.accessToken),
          refresh_token: refresh.refreshToken
            ? encryptToken(refresh.refreshToken)
            : connection.refresh_token,
          token_expires_at: refresh.tokenExpiresAt
            ? new Date(refresh.tokenExpiresAt).toISOString()
            : null,
        })
        .eq('id', connection.id);
    } catch (err) {
      await markConnectionError(supabaseAdmin, connection, `refresh: ${err.message}`, true);
      return { saved: 0, skipped: 0, status: 'reauth' };
    }
  }

  // Run the adapter sync.
  let result;
  try {
    result = await adapter.sync({ connection, supabaseAdmin, accessToken });
  } catch (err) {
    const isAuth = err instanceof ConnectorAuthError || err?.isAuthError;
    await markConnectionError(supabaseAdmin, connection, err.message, isAuth);
    return { saved: 0, skipped: 0, status: isAuth ? 'reauth' : 'error' };
  }

  // Success — bump counters.
  await supabaseAdmin
    .from('social_connections')
    .update({
      last_synced_at: new Date().toISOString(),
      last_sync_count: result.saved || 0,
      total_synced_count: (connection.total_synced_count || 0) + (result.saved || 0),
      consecutive_errors: 0,
      status: 'active',
      last_error: null,
    })
    .eq('id', connection.id);

  return { ...result, status: 'ok' };
}

async function markConnectionError(supabaseAdmin, connection, message, isAuth) {
  const consecutive = (connection.consecutive_errors || 0) + 1;
  await supabaseAdmin
    .from('social_connections')
    .update({
      last_synced_at: new Date().toISOString(),
      consecutive_errors: consecutive,
      status: isAuth ? 'reauth' : (consecutive >= 3 ? 'error' : connection.status || 'active'),
      last_error: String(message || 'unknown').slice(0, 500),
    })
    .eq('id', connection.id);
}

// ---------------------------------------------------------------------------
// Fan-out (background poller)
// ---------------------------------------------------------------------------
/**
 * Returns connections whose last_synced_at is older than their interval.
 * Skips paused / reauth-needed connections.
 */
async function selectDueConnections(supabaseAdmin, limit = 25) {
  const { data, error } = await supabaseAdmin
    .from('social_connections')
    .select('*')
    .in('status', ['active', 'error'])
    .order('last_synced_at', { ascending: true, nullsFirst: true })
    .limit(limit * 2);

  if (error || !data) return [];
  const now = Date.now();
  return data.filter((c) => {
    if (!c.last_synced_at) return true;
    let intervalMin = c.sync_interval_minutes || 60;
    if (c.status === 'error') intervalMin = Math.max(intervalMin, 30 * (c.consecutive_errors || 1));
    return new Date(c.last_synced_at).getTime() + intervalMin * 60_000 <= now;
  }).slice(0, limit);
}

export async function pollDueConnections({ supabaseAdmin, limit = 10 }) {
  const due = await selectDueConnections(supabaseAdmin, limit);
  if (!due.length) return { polled: 0, totalSaved: 0 };

  let totalSaved = 0;
  for (const connection of due) {
    try {
      const result = await runSync({ supabaseAdmin, connection });
      totalSaved += result.saved || 0;
      if ((result.saved || 0) > 0) {
        console.log(
          `[connectors] sync ${connection.provider}/${connection.account_handle} → +${result.saved}`,
        );
      }
    } catch (err) {
      console.error(
        `[connectors] sync failed ${connection.provider}/${connection.id}:`,
        err.message,
      );
    }
  }
  return { polled: due.length, totalSaved };
}

export function makeConnectorPoller({ supabaseAdmin, intervalMs = 60_000 }) {
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await pruneExpiredOAuthStates(supabaseAdmin);
      await pollDueConnections({ supabaseAdmin, limit: 10 });
    } catch (err) {
      console.error('[connectors] poller tick error:', err.message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  return {
    start() {
      if (timer) return;
      timer = setTimeout(tick, 7_000);
      console.log(
        `→ Connector poller: ✅ enabled (every ${Math.round(intervalMs / 1000)}s)`,
      );
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
