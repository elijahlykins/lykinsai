// ============================================================================
// lib/customConnections/customConnections.js — bring-your-own-API-key engine
// ============================================================================
// The universal action lane: a user attaches ANY app by giving LYKN a base URL
// + an API key (and how to send it). The LYKN agent then calls that app via the
// lykn_call_app tool. The secret is encrypted at rest and INJECTED server-side
// here — the model only references a connection by slug and supplies
// method/path/body. It never sees the credential.
//
// Security invariants enforced in callApp():
//   • Host-pinned: the resolved request URL must share base_url's host, so the
//     model can't redirect the credential to another origin via an absolute or
//     traversing path.
//   • SSRF guard: no localhost / private ranges / cloud metadata / bare IPs.
//   • Write gate: GET/HEAD always allowed; mutating methods require allow_writes.
//   • Response size + timeout capped; per-user/host rate limited.
//   • Model-supplied headers can never set the auth header, Authorization, or
//     Cookie — those are owned by the connection config.
//
// CRUD mirrors the lykn_custom_agents service: validation throws
// CustomConnectionError, secrets go through encryptToken/decryptToken
// (CONNECTOR_TOKEN_KEY). Display reads never return the secret.

import { assertUrlSafe } from '../exterior/ssrfGuard.js';

const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REQUESTS_PER_MINUTE = 30;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Same posture as lib/exterior/capabilities/httpRequest.js — block loopback,
// RFC1918, link-local, and cloud metadata endpoints.
const BLOCKED_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\]|::1|metadata\.google|metadata$)/i;

const SELECT_COLS =
  'id, user_id, name, slug, kind, base_url, description, auth_type, auth_header_name, auth_query_param, default_headers, body_format, allow_writes, status, last_used_at, use_count, last_error, created_at, updated_at';

export class CustomConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CustomConnectionError';
    this.isValidation = true;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function slugify(raw) {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function sanitizeName(raw) {
  const s = String(raw || '').trim();
  if (s.length < 1 || s.length > 80) {
    throw new CustomConnectionError('name must be 1–80 characters');
  }
  return s;
}

function sanitizeBaseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 2048) throw new CustomConnectionError('base_url must be 1–2048 chars');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new CustomConnectionError('base_url must be a valid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new CustomConnectionError('base_url must be http(s)');
  }
  const isLocal = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || /\.local$/.test(u.hostname);
  if (u.protocol !== 'https:' && !isLocal) {
    throw new CustomConnectionError('base_url must be https (http only allowed for localhost dev)');
  }
  if (hostIsBlocked(u.hostname)) {
    throw new CustomConnectionError('base_url host is not allowed (private/loopback/metadata address)');
  }
  return u.toString().replace(/\/+$/, '');
}

function sanitizeAuthType(raw) {
  const s = String(raw || 'bearer').trim().toLowerCase();
  if (!['none', 'bearer', 'header', 'query', 'basic'].includes(s)) {
    throw new CustomConnectionError("auth_type must be one of: none, bearer, header, query, basic");
  }
  return s;
}

function sanitizeBodyFormat(raw) {
  const s = String(raw || 'json').trim().toLowerCase();
  if (!['json', 'form'].includes(s)) {
    throw new CustomConnectionError("body_format must be 'json' or 'form'");
  }
  return s;
}

function sanitizeHttpToken(raw, field) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s.length > 64) throw new CustomConnectionError(`${field} must be ≤ 64 chars`);
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(s)) {
    throw new CustomConnectionError(`${field} contains invalid characters`);
  }
  return s;
}

function sanitizeDefaultHeaders(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CustomConnectionError('default_headers must be an object');
  }
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k || '').trim();
    if (!key) continue;
    if (/^(authorization|cookie)$/i.test(key)) continue; // owned by auth config
    if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(key)) continue;
    out[key] = String(v ?? '').slice(0, 1024);
    if (++n >= 20) break;
  }
  return out;
}

function hostIsBlocked(hostname) {
  const h = String(hostname || '');
  if (!h) return true;
  if (BLOCKED_HOST_RE.test(h)) return true;
  // Bare IPv4 literal — block (we only allow named hosts for public APIs).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function decorate(row) {
  if (!row) return row;
  const { auth_header_name, auth_query_param, ...rest } = row;
  return {
    ...rest,
    auth_header_name,
    auth_query_param,
    // Never expose the secret; just whether one is set.
    has_secret: row.auth_type !== 'none',
  };
}

export async function listCustomConnections(client, userId) {
  if (!client || !userId) return [];
  const { data, error } = await client
    .from('lykn_custom_connections')
    .select(SELECT_COLS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`db: ${error.message}`);
  return (data || []).map(decorate);
}

async function resolveSlug(client, userId, name, requested) {
  let base = requested ? slugify(requested) : slugify(name);
  if (!base) base = 'app';
  let slug = base;
  for (let i = 2; i < 50; i++) {
    const { data } = await client
      .from('lykn_custom_connections')
      .select('id')
      .eq('user_id', userId)
      .eq('slug', slug)
      .maybeSingle();
    if (!data) return slug;
    slug = `${base}-${i}`.slice(0, 48);
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 48);
}

export async function createCustomConnection(client, userId, payload = {}) {
  if (!client || !userId) throw new Error('unauthorized');
  const { encryptToken } = await import('../../connectors-service.js');

  const name = sanitizeName(payload.name);
  const authType = sanitizeAuthType(payload.auth_type);
  const row = {
    user_id: userId,
    name,
    slug: await resolveSlug(client, userId, name, payload.slug),
    kind: 'rest',
    base_url: sanitizeBaseUrl(payload.base_url),
    description: typeof payload.description === 'string' ? payload.description.slice(0, 4000) : null,
    auth_type: authType,
    auth_header_name: authType === 'header' ? sanitizeHttpToken(payload.auth_header_name, 'auth_header_name') : null,
    auth_query_param: authType === 'query' ? sanitizeHttpToken(payload.auth_query_param, 'auth_query_param') : null,
    default_headers: sanitizeDefaultHeaders(payload.default_headers),
    body_format: sanitizeBodyFormat(payload.body_format),
    allow_writes: Boolean(payload.allow_writes),
    status: 'active',
  };

  if (authType === 'header' && !row.auth_header_name) {
    throw new CustomConnectionError("auth_header_name is required when auth_type is 'header'");
  }
  if (authType === 'query' && !row.auth_query_param) {
    throw new CustomConnectionError("auth_query_param is required when auth_type is 'query'");
  }

  const secret = String(payload.secret || '').trim();
  if (authType !== 'none') {
    if (!secret) throw new CustomConnectionError('An API key / secret is required for this auth type.');
    if (secret.length > 8192) throw new CustomConnectionError('secret is too long');
    row.secret_encrypted = encryptToken(secret);
  }

  const { data, error } = await client
    .from('lykn_custom_connections')
    .insert(row)
    .select(SELECT_COLS)
    .single();
  if (error) throw new Error(`db: ${error.message}`);
  return decorate(data);
}

export async function updateCustomConnection(client, userId, id, payload = {}) {
  if (!client || !userId || !id) throw new Error('unauthorized');
  const { encryptToken } = await import('../../connectors-service.js');

  const patch = {};
  if (payload.name !== undefined) patch.name = sanitizeName(payload.name);
  if (payload.base_url !== undefined) patch.base_url = sanitizeBaseUrl(payload.base_url);
  if (payload.description !== undefined) {
    patch.description = typeof payload.description === 'string' ? payload.description.slice(0, 4000) : null;
  }
  if (payload.default_headers !== undefined) patch.default_headers = sanitizeDefaultHeaders(payload.default_headers);
  if (payload.body_format !== undefined) patch.body_format = sanitizeBodyFormat(payload.body_format);
  if (payload.allow_writes !== undefined) patch.allow_writes = Boolean(payload.allow_writes);
  if (payload.status !== undefined) {
    const st = String(payload.status).trim();
    if (!['active', 'paused'].includes(st)) throw new CustomConnectionError('status must be active or paused');
    patch.status = st;
  }
  if (payload.auth_type !== undefined) {
    const at = sanitizeAuthType(payload.auth_type);
    patch.auth_type = at;
    patch.auth_header_name = at === 'header' ? sanitizeHttpToken(payload.auth_header_name, 'auth_header_name') : null;
    patch.auth_query_param = at === 'query' ? sanitizeHttpToken(payload.auth_query_param, 'auth_query_param') : null;
    if (at === 'none') patch.secret_encrypted = null;
  }
  // Only re-encrypt when a fresh secret is provided (empty string = leave as-is).
  if (typeof payload.secret === 'string' && payload.secret.trim()) {
    const secret = payload.secret.trim();
    if (secret.length > 8192) throw new CustomConnectionError('secret is too long');
    patch.secret_encrypted = encryptToken(secret);
  }

  if (Object.keys(patch).length === 0) {
    const { data } = await client.from('lykn_custom_connections').select(SELECT_COLS).eq('user_id', userId).eq('id', id).maybeSingle();
    return data ? decorate(data) : null;
  }

  const { data, error } = await client
    .from('lykn_custom_connections')
    .update(patch)
    .eq('user_id', userId)
    .eq('id', id)
    .select(SELECT_COLS)
    .maybeSingle();
  if (error) throw new Error(`db: ${error.message}`);
  return data ? decorate(data) : null;
}

export async function deleteCustomConnection(client, userId, id) {
  if (!client || !userId || !id) throw new Error('unauthorized');
  const { error } = await client
    .from('lykn_custom_connections')
    .delete()
    .eq('user_id', userId)
    .eq('id', id);
  if (error) throw new Error(`db: ${error.message}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rate limiting (per user + host, in-process — mirrors httpRequest.js)
// ---------------------------------------------------------------------------

const rateBuckets = new Map();
function checkRateLimit(key) {
  const now = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((t) => now - t < 60_000);
  if (bucket.length >= MAX_REQUESTS_PER_MINUTE) return false;
  bucket.push(now);
  rateBuckets.set(key, bucket);
  return true;
}

// ---------------------------------------------------------------------------
// callApp — the dispatch the lykn_call_app tool uses
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OAuth-backed action apps
// ---------------------------------------------------------------------------
// Apps the user connects via the Connections OAuth flow (one click — no
// pasted key, no self-made app) that the agent can ALSO call through
// lykn_call_app. We reuse the token minted by that flow (stored encrypted in
// social_connections.access_token, same encryptToken format as custom
// connections) and present it to callApp as a synthetic connection. The model
// references it by the same slug it sees in lykn_list_apps; the credential is
// still injected server-side and never exposed.
//
// Keyed by the slug the model uses. `provider` matches social_connections /
// CONNECTOR_REGISTRY ids.
export const OAUTH_ACTION_APPS = {
  slack: {
    provider: 'slack',
    slug: 'slack',
    name: 'Slack',
    base_url: 'https://slack.com/api',
    auth_type: 'bearer',
    body_format: 'form',
    allow_writes: true,
    default_headers: {},
    description:
      'Slack Web API, acting as you (your user token). Methods are paths under the base URL. '
      + 'List channels: GET /conversations.list (types=public_channel,private_channel,im,mpim). '
      + 'Read messages: GET /conversations.history?channel=C...&limit=20. '
      + 'Find a user/DM: GET /users.list, GET /conversations.open?users=U.... '
      + 'Post a message: POST /chat.postMessage with channel + text. '
      + 'Search: GET /search.messages?query=.... '
      + 'Responses are JSON with { ok: true|false, ... }; on ok:false read the "error" field '
      + '(e.g. missing_scope, not_in_channel) and report it.',
  },
};

// Load an OAuth-backed app as a synthetic connection callApp can use. Returns
// null when the user hasn't connected that provider (so the caller can fall
// through to "not found").
async function loadOAuthBackedConnection(client, userId, ref) {
  const spec = OAUTH_ACTION_APPS[String(ref || '').trim().toLowerCase()];
  if (!spec) return null;
  const { data } = await client
    .from('social_connections')
    .select('id, access_token, status')
    .eq('user_id', userId)
    .eq('provider', spec.provider)
    .order('created_at', { ascending: false })
    .limit(1);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || !row.access_token) return null;
  return {
    id: row.id,
    slug: spec.slug,
    name: spec.name,
    base_url: spec.base_url,
    description: spec.description,
    auth_type: spec.auth_type,
    auth_header_name: null,
    auth_query_param: null,
    default_headers: spec.default_headers || {},
    body_format: spec.body_format || 'json',
    allow_writes: spec.allow_writes !== false,
    // social_connections may be 'active' | 'paused' | 'reauth'. Map reauth to
    // a paused-style block with a reconnect hint handled in callApp.
    status: row.status === 'active' ? 'active' : (row.status || 'active'),
    secret_encrypted: row.access_token, // already encryptToken() format
    _oauthBacked: true,
  };
}

// List the OAuth-backed action apps this user has actually connected (active),
// for discovery in lykn_list_apps / the system-prompt actionable block.
export async function listOAuthBackedApps(client, userId) {
  if (!client || !userId) return [];
  const providers = [...new Set(Object.values(OAUTH_ACTION_APPS).map((a) => a.provider))];
  if (providers.length === 0) return [];
  const { data } = await client
    .from('social_connections')
    .select('provider, status')
    .eq('user_id', userId)
    .in('provider', providers);
  const activeProviders = new Set((data || []).filter((r) => r.status === 'active').map((r) => r.provider));
  return Object.values(OAUTH_ACTION_APPS)
    .filter((a) => activeProviders.has(a.provider))
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      base_url: a.base_url,
      description: a.description,
      allow_writes: a.allow_writes !== false,
      auth: 'oauth',
    }));
}

async function loadConnectionForCall(client, userId, ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  // Resolve by slug first (what the model uses), then by id, then by exact name.
  const cols = `${SELECT_COLS}, secret_encrypted`;
  const bySlug = await client
    .from('lykn_custom_connections')
    .select(cols)
    .eq('user_id', userId)
    .eq('slug', r)
    .maybeSingle();
  if (bySlug.data) return bySlug.data;

  if (/^[0-9a-f-]{36}$/i.test(r)) {
    const byId = await client.from('lykn_custom_connections').select(cols).eq('user_id', userId).eq('id', r).maybeSingle();
    if (byId.data) return byId.data;
  }
  const byName = await client
    .from('lykn_custom_connections')
    .select(cols)
    .eq('user_id', userId)
    .ilike('name', r)
    .limit(1)
    .maybeSingle();
  return byName.data || null;
}

/**
 * Execute one HTTP call against a user's custom connection, injecting the
 * stored credential server-side.
 *
 * @returns {Promise<object>} { ok, status?, body?, error?, ... } — never the secret.
 */
export async function callApp({ client, userId, connection: ref, method = 'GET', path = '', query = null, body = null, headers = null } = {}) {
  if (!client || !userId) return { ok: false, error: 'unauthorized' };
  if (!ref) return { ok: false, error: 'missing_connection', message: 'Specify which connection to call (its slug).' };

  const m = String(method || 'GET').trim().toUpperCase();
  if (!ALLOWED_METHODS.has(m)) return { ok: false, error: 'invalid_method', allowed: [...ALLOWED_METHODS] };

  let conn;
  try {
    conn = await loadConnectionForCall(client, userId, ref);
    // Fall through to OAuth-backed apps (Slack, …) when there's no
    // bring-your-own-key custom connection by that slug.
    if (!conn) conn = await loadOAuthBackedConnection(client, userId, ref);
  } catch (e) {
    return { ok: false, error: `lookup_failed: ${e?.message || e}` };
  }
  if (!conn) {
    return { ok: false, error: 'connection_not_found', message: `No connection "${ref}". Call lykn_list_apps to see what's connected.` };
  }
  if (conn.status !== 'active') {
    const reauth = conn._oauthBacked && conn.status === 'reauth';
    return {
      ok: false,
      error: reauth ? 'reauth_required' : 'connection_paused',
      message: reauth
        ? `The "${conn.slug}" connection needs to be reconnected (its access expired or was revoked). Reconnect it in Connections.`
        : `The "${conn.slug}" connection is paused.`,
    };
  }
  if (WRITE_METHODS.has(m) && !conn.allow_writes) {
    return {
      ok: false,
      error: 'writes_not_enabled',
      message: `The "${conn.slug}" connection is read-only. ${m} calls are blocked until the user enables writes for it in Connections.`,
    };
  }

  // Build + host-pin the target URL.
  const baseUrl = new URL(conn.base_url);
  let target;
  try {
    const rawPath = String(path || '').trim();
    if (!rawPath) {
      target = new URL(conn.base_url);
    } else if (/^https?:\/\//i.test(rawPath)) {
      target = new URL(rawPath);
    } else {
      // Join onto base, preserving base path. Ensure base ends with '/'.
      const baseForJoin = conn.base_url.endsWith('/') ? conn.base_url : conn.base_url + '/';
      target = new URL(rawPath.replace(/^\/+/, ''), baseForJoin);
    }
  } catch {
    return { ok: false, error: 'invalid_path' };
  }

  if (target.hostname !== baseUrl.hostname || hostIsBlocked(target.hostname)) {
    return {
      ok: false,
      error: 'host_not_allowed',
      message: `Calls for "${conn.slug}" are restricted to ${baseUrl.hostname}.`,
    };
  }
  if (!['http:', 'https:'].includes(target.protocol)) return { ok: false, error: 'bad_protocol' };

  // DNS-resolved SSRF check: the string BLOCKED_HOST_RE above only catches
  // literal private hosts. assertUrlSafe resolves the hostname and rejects if it
  // maps to a loopback/private/link-local/metadata address, defeating a public
  // name that points at an internal IP (DNS rebinding at request time).
  const safeTarget = await assertUrlSafe(target.toString());
  if (!safeTarget.ok) {
    return {
      ok: false,
      error: 'host_not_allowed',
      message: `Calls for "${conn.slug}" are restricted to ${baseUrl.hostname}.`,
    };
  }

  // Query params from the model.
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      target.searchParams.set(String(k), String(v));
    }
  }

  // Headers: connection defaults + model-supplied (auth/cookie stripped).
  const reqHeaders = { Accept: 'application/json', ...(conn.default_headers || {}) };
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    for (const [k, v] of Object.entries(headers)) {
      const key = String(k || '').trim();
      if (!key || /^(authorization|cookie)$/i.test(key)) continue;
      if (conn.auth_type === 'header' && conn.auth_header_name && key.toLowerCase() === conn.auth_header_name.toLowerCase()) continue;
      reqHeaders[key] = String(v ?? '');
    }
  }

  // Inject the stored credential.
  if (conn.auth_type !== 'none' && conn.secret_encrypted) {
    let secret = '';
    try {
      const { decryptToken } = await import('../../connectors-service.js');
      secret = String(decryptToken(conn.secret_encrypted) || '');
    } catch (e) {
      return { ok: false, error: 'credential_unavailable', message: 'Stored credential could not be read (key rotation?). Reconnect the app.' };
    }
    if (conn.auth_type === 'bearer') {
      reqHeaders.Authorization = /^bearer\s/i.test(secret) ? secret : `Bearer ${secret}`;
    } else if (conn.auth_type === 'header' && conn.auth_header_name) {
      reqHeaders[conn.auth_header_name] = secret;
    } else if (conn.auth_type === 'query' && conn.auth_query_param) {
      target.searchParams.set(conn.auth_query_param, secret);
    } else if (conn.auth_type === 'basic') {
      // Stored secret is the literal "username:password" pair (e.g. Twilio's
      // AccountSID:AuthToken). If it already looks base64-encoded with no
      // colon we still wrap it; otherwise base64 the pair.
      const encoded = /:/.test(secret) ? Buffer.from(secret).toString('base64') : secret;
      reqHeaders.Authorization = /^basic\s/i.test(secret) ? secret : `Basic ${encoded}`;
    }
  }

  if (!checkRateLimit(`${userId}:${target.hostname}`)) {
    return { ok: false, error: 'rate_limit_exceeded', retry_after_sec: 60 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const init = { method: m, headers: reqHeaders, signal: controller.signal, redirect: 'manual' };
    if (body != null && !['GET', 'HEAD'].includes(m)) {
      const hasCT = reqHeaders['Content-Type'] || reqHeaders['content-type'];
      if (conn.body_format === 'form') {
        // x-www-form-urlencoded (Stripe-style bracket notation for nested
        // objects). APIs like Stripe / Twilio reject JSON bodies on writes.
        init.body = typeof body === 'string' ? body : encodeFormBody(body);
        if (!hasCT) reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      } else {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        if (!hasCT) reqHeaders['Content-Type'] = 'application/json';
      }
      init.headers = reqHeaders;
    }

    // Follow redirects manually. The stored credential is in reqHeaders, so we
    // must NOT let native `redirect: 'follow'` forward it to an arbitrary host:
    // each hop is re-pinned to the connection's host and re-checked for SSRF
    // before we send the (credential-bearing) request again.
    let currentUrl = target.toString();
    let res;
    for (let hop = 0; hop < 5; hop += 1) {
      res = await fetch(currentUrl, init);
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      let next;
      try {
        next = new URL(loc, currentUrl);
      } catch {
        break;
      }
      if (next.hostname !== baseUrl.hostname || hostIsBlocked(next.hostname)) {
        clearTimeout(timer);
        return {
          ok: false,
          error: 'redirect_off_host',
          message: `"${conn.slug}" tried to redirect off ${baseUrl.hostname}; blocked to protect the stored credential.`,
        };
      }
      const safeHop = await assertUrlSafe(next.toString());
      if (!safeHop.ok) {
        clearTimeout(timer);
        return { ok: false, error: 'host_not_allowed', message: `Calls for "${conn.slug}" are restricted to ${baseUrl.hostname}.` };
      }
      currentUrl = next.toString();
    }
    clearTimeout(timer);

    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > MAX_RESPONSE_BYTES;
    const bodyText = (truncated ? buf.subarray(0, MAX_RESPONSE_BYTES) : buf).toString('utf8');
    const ct = res.headers.get('content-type') || '';
    let parsed = bodyText;
    if (ct.includes('json')) {
      try { parsed = JSON.parse(bodyText); } catch { /* leave as text */ }
    }

    // Telemetry — fire and forget. Only custom connections own a row in
    // lykn_custom_connections; OAuth-backed apps live in social_connections
    // and track their own lifecycle, so skip the write for them.
    if (!conn._oauthBacked) {
      client
        .from('lykn_custom_connections')
        .update({ last_used_at: new Date().toISOString(), use_count: (conn.use_count || 0) + 1, last_error: res.ok ? null : `HTTP ${res.status}` })
        .eq('id', conn.id)
        .then(() => {}, () => {});
    }

    return {
      ok: res.ok,
      status: res.status,
      connection: conn.slug,
      method: m,
      url: redactSecretFromUrl(target, conn),
      content_type: ct,
      body: parsed,
      truncated,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') return { ok: false, error: 'request_timeout', timeout_ms: TIMEOUT_MS };
    return { ok: false, error: err?.message || 'request_failed' };
  }
}

// Serialize a body object as application/x-www-form-urlencoded using Stripe's
// bracket notation for nested objects/arrays (metadata[key]=v, items[0][id]=v).
// Flat objects encode normally. Used when a connection's body_format = 'form'.
function encodeFormBody(obj) {
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    return String(obj ?? '');
  }
  const parts = [];
  const enc = encodeURIComponent;
  const walk = (key, val) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      val.forEach((item, i) => walk(`${key}[${i}]`, item));
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val)) walk(`${key}[${k}]`, v);
    } else {
      parts.push(`${enc(key)}=${enc(String(val))}`);
    }
  };
  for (const [k, v] of Object.entries(obj)) walk(k, v);
  return parts.join('&');
}

// Strip an injected query-param secret from the URL we echo back to the model.
function redactSecretFromUrl(urlObj, conn) {
  try {
    const u = new URL(urlObj.toString());
    if (conn.auth_type === 'query' && conn.auth_query_param && u.searchParams.has(conn.auth_query_param)) {
      u.searchParams.set(conn.auth_query_param, '***');
    }
    return u.toString();
  } catch {
    return `${conn.base_url}`;
  }
}
