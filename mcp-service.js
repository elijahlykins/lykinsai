// ============================================================================
// mcp-service.js — token issuance + auth bridge for the MCP / REST surfaces
// ============================================================================
// The "context backplane" layer of LYKN: anything that wants to read or
// write the user's synthesis layer (beliefs, rules, facts, vault) from
// outside the LYKN app — Claude Desktop, Claude Code, Cursor, ChatGPT
// custom GPT Actions, MCP-aware coding agents — authenticates against the
// per-user bearer tokens minted here.
//
// One layered design choice: this file is intentionally Express-free and
// SDK-free. It only touches Supabase + crypto. server.js wires in the
// middleware; mcp-server.js wires in the MCP protocol. Splitting like this
// means the same token lookup powers both transports without one knowing
// about the other.
//
// Token format
// ------------
//   lkn_live_<32-byte-base64url>
//
// Plaintext is shown ONCE in the issue dialog. Only the SHA-256 hex hash
// is persisted in `lykn_mcp_tokens.token_hash`. We also persist the first
// 8 + last 4 chars of the plaintext as `token_prefix` so the Connections
// page can disambiguate multiple tokens without revealing the secret.
//
// Auth flow on a request
// ----------------------
// 1. requireAuthOrMcpToken sees `Authorization: Bearer <something>`.
// 2. If the token starts with `lkn_live_`: hash → table lookup → resolve
//    user. Bumps last_used_at + last_used_client async.
// 3. Otherwise: fall through to the existing Supabase-JWT path. Same
//    `req.user.id` shape either way, so downstream handlers don't care
//    which auth produced the user.
//
// Companion to:
//   • supabase-migrations/044_lykn_mcp_tokens.sql (the table)
//   • mcp-tools/*.js (the per-tool handlers)
//   • mcp-server.js (the MCP protocol mount)

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MCP_TOKEN_PREFIX = 'lkn_live_';

export const MCP_CLIENT_KINDS = new Set([
  'claude-desktop',
  'claude-code',
  'cursor',
  'chatgpt',
  'other',
]);

export const MCP_SCOPES = new Set(['read', 'write']);

// Cap labels so a misbehaving UI can't poison the table.
const LABEL_MAX = 80;
const CLIENT_HEADER_MAX = 120;
const TOOL_NAME_MAX = 64;

// ---------------------------------------------------------------------------
// Hashing + token shape
// ---------------------------------------------------------------------------

export function hashMcpToken(plaintext) {
  return crypto.createHash('sha256').update(String(plaintext || '')).digest('hex');
}

/**
 * Generate a fresh `lkn_live_<random>` token. 32 random bytes encoded as
 * base64url gives ~256 bits of entropy and a body length of 43 chars, plus
 * the 9-char prefix. Total ~52 chars — short enough to paste into a JSON
 * config without line-wrapping headaches.
 */
export function generateMcpToken() {
  const body = crypto.randomBytes(32).toString('base64url');
  const plaintext = `${MCP_TOKEN_PREFIX}${body}`;
  // First 8 + last 4 of the FULL plaintext (including the lkn_live_ prefix
  // is fine — the prefix isn't secret, the random body is).
  const prefix = `${plaintext.slice(0, 12)}…${plaintext.slice(-4)}`;
  return { plaintext, prefix };
}

/**
 * Cheap pre-check before the DB round-trip. Returns true iff the string
 * could plausibly be one of our tokens. Used by requireAuthOrMcpToken to
 * decide which auth path to walk.
 */
export function looksLikeMcpToken(raw) {
  if (typeof raw !== 'string') return false;
  if (!raw.startsWith(MCP_TOKEN_PREFIX)) return false;
  // Body should be base64url, length ~43. Allow some slack.
  const body = raw.slice(MCP_TOKEN_PREFIX.length);
  return /^[A-Za-z0-9_-]{30,}$/.test(body);
}

// ---------------------------------------------------------------------------
// Issuance / list / revoke (called by /api/v1/synthesis/tokens)
// ---------------------------------------------------------------------------

/**
 * Mint a brand-new token for `userId`. Returns the plaintext exactly once
 * — caller (the route handler) is responsible for surfacing it to the UI
 * and never persisting it elsewhere.
 *
 * `scopes` defaults to ['read']. Pass ['read', 'write'] for paid plans.
 * The route handler does the plan check; this function trusts whatever
 * is passed in.
 */
export async function createMcpToken(supabaseAdmin, userId, opts = {}) {
  if (!supabaseAdmin) return { ok: false, reason: 'no_db' };
  if (!userId) return { ok: false, reason: 'no_user' };

  const labelRaw = String(opts.label || '').trim();
  const clientKindRaw = String(opts.clientKind || 'other').trim().toLowerCase();
  const clientKind = MCP_CLIENT_KINDS.has(clientKindRaw) ? clientKindRaw : 'other';
  const label = (labelRaw || labelForClientKind(clientKind)).slice(0, LABEL_MAX);

  const scopesRaw = Array.isArray(opts.scopes) ? opts.scopes : ['read'];
  const scopes = Array.from(
    new Set(
      scopesRaw
        .map((s) => String(s || '').trim().toLowerCase())
        .filter((s) => MCP_SCOPES.has(s)),
    ),
  );
  if (!scopes.length) scopes.push('read');

  const { plaintext, prefix } = generateMcpToken();
  const tokenHash = hashMcpToken(plaintext);

  const insertRow = {
    user_id: userId,
    label,
    client_kind: clientKind,
    token_hash: tokenHash,
    token_prefix: prefix,
    scopes,
    status: 'active',
  };

  const { data, error } = await supabaseAdmin
    .from('lykn_mcp_tokens')
    .insert(insertRow)
    .select('id, label, client_kind, token_prefix, scopes, status, last_used_at, last_used_client, last_used_tool, use_count, created_at')
    .single();
  if (error) {
    console.warn('[mcp] createMcpToken insert:', error.message);
    return { ok: false, reason: error.message };
  }

  return { ok: true, token: { ...data, plaintext } };
}

/**
 * List all of `userId`'s tokens (active + revoked, recent first). Never
 * returns `token_hash` — that's the entire point of hashing it.
 */
export async function listMcpTokens(supabaseAdmin, userId) {
  if (!supabaseAdmin || !userId) return [];
  const { data, error } = await supabaseAdmin
    .from('lykn_mcp_tokens')
    .select('id, label, client_kind, token_prefix, scopes, status, last_used_at, last_used_client, last_used_tool, use_count, revoked_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    console.warn('[mcp] listMcpTokens:', error.message);
    return [];
  }
  return data || [];
}

export async function revokeMcpToken(supabaseAdmin, userId, tokenId) {
  if (!supabaseAdmin || !userId || !tokenId) return { ok: false, reason: 'no_args' };
  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('lykn_mcp_tokens')
    .update({ status: 'revoked', revoked_at: now })
    .eq('id', tokenId)
    .eq('user_id', userId)
    .select('id, status, revoked_at')
    .maybeSingle();
  if (error) return { ok: false, reason: error.message };
  if (!data) return { ok: false, reason: 'not_found' };
  return { ok: true, token: data };
}

// ---------------------------------------------------------------------------
// Validation (called on every MCP/REST request)
// ---------------------------------------------------------------------------

/**
 * Look up a plaintext bearer token. Returns null on miss / revoked /
 * expired so the caller can fall through to the JWT path or 401.
 *
 * Bumps `last_used_at`, `last_used_client`, `last_used_tool`, and
 * `use_count` in the background — failures don't block the request.
 */
export async function resolveMcpToken(supabaseAdmin, plaintext, meta = {}) {
  if (!supabaseAdmin) return null;
  if (!looksLikeMcpToken(plaintext)) return null;
  const tokenHash = hashMcpToken(plaintext);

  const { data, error } = await supabaseAdmin
    .from('lykn_mcp_tokens')
    .select('id, user_id, label, client_kind, scopes, status, use_count')
    .eq('token_hash', tokenHash)
    .eq('status', 'active')
    .maybeSingle();
  if (error || !data) return null;

  // Async telemetry — do not await, do not let it fail the request.
  bumpTokenUsage(supabaseAdmin, data.id, data.use_count, meta).catch(() => {});

  return {
    tokenId: data.id,
    userId: data.user_id,
    label: data.label,
    clientKind: data.client_kind,
    scopes: Array.isArray(data.scopes) ? data.scopes : ['read'],
  };
}

async function bumpTokenUsage(supabaseAdmin, tokenId, prevCount, meta) {
  try {
    const update = {
      last_used_at: new Date().toISOString(),
      use_count: (prevCount || 0) + 1,
    };
    if (meta.client) {
      update.last_used_client = String(meta.client).slice(0, CLIENT_HEADER_MAX);
    }
    if (meta.tool) {
      update.last_used_tool = String(meta.tool).slice(0, TOOL_NAME_MAX);
    }
    await supabaseAdmin
      .from('lykn_mcp_tokens')
      .update(update)
      .eq('id', tokenId);
  } catch { /* swallow — telemetry is non-critical */ }
}

// ---------------------------------------------------------------------------
// Express middleware factory
// ---------------------------------------------------------------------------

/**
 * Build a middleware that accepts EITHER a Supabase JWT OR an MCP bearer
 * token. The shape it produces on `req` is identical to the existing
 * `requireAuth` so downstream handlers can ignore which path was used:
 *
 *   req.user      : { id: <uuid>, ... }   (always set on success)
 *   req.mcpAuth   : { tokenId, scopes, clientKind, label } | undefined
 *
 * `req.mcpAuth` being defined means the request came in on a personal
 * access token, so write handlers can refuse if `'write'` isn't in scopes
 * or apply tighter rate limits.
 *
 * Args:
 *   supabaseAdmin     — service-role Supabase client (required for MCP path)
 *   requireAuth       — the existing JWT middleware, called when the bearer
 *                       isn't an MCP token
 */
export function makeRequireAuthOrMcpToken({ supabaseAdmin, requireAuth }) {
  if (typeof requireAuth !== 'function') {
    throw new Error('makeRequireAuthOrMcpToken: requireAuth is required');
  }
  return async function requireAuthOrMcpToken(req, res, next) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const bearer = authHeader.slice(7).trim();

    // Fast path: if it doesn't look like an MCP token, let the JWT
    // middleware handle it. This keeps the LYKN web app's call pattern
    // unchanged — same one round-trip to Supabase Auth as before.
    if (!looksLikeMcpToken(bearer)) {
      return requireAuth(req, res, next);
    }

    if (!supabaseAdmin) {
      return res.status(503).json({ error: 'MCP token service not configured' });
    }

    const clientHeader = req.headers['user-agent'] || req.headers['mcp-client-info'] || '';
    const resolved = await resolveMcpToken(supabaseAdmin, bearer, {
      client: clientHeader,
      // tool name is set per-request later (in the MCP server / per-route);
      // we only know "some endpoint was hit" at this layer.
    });
    if (!resolved) {
      return res.status(401).json({ error: 'Invalid or revoked MCP token' });
    }

    req.user = { id: resolved.userId };
    req.mcpAuth = {
      tokenId: resolved.tokenId,
      label: resolved.label,
      clientKind: resolved.clientKind,
      scopes: resolved.scopes,
    };
    return next();
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function labelForClientKind(kind) {
  switch (kind) {
    case 'claude-desktop': return 'Claude Desktop';
    case 'claude-code':    return 'Claude Code';
    case 'cursor':         return 'Cursor';
    case 'chatgpt':        return 'ChatGPT';
    default:               return 'AI client';
  }
}

/**
 * Translate a client_kind into the `surface` value persisted on
 * lykn_result_attributions. Mirrors the convention documented in 044.
 */
export function attributionSurfaceForClientKind(kind, transport = 'mcp') {
  const safe = MCP_CLIENT_KINDS.has(kind) ? kind : 'other';
  return `${transport}:${safe}`;
}

/**
 * Used by write-tool handlers / route handlers. Returns `true` iff the
 * request was MCP-authenticated and the token has the given scope. JWT
 * (= LYKN web app) requests always have full access — this only constrains
 * the external token surface.
 */
export function tokenHasScope(req, scope) {
  if (!req.mcpAuth) return true; // JWT path
  return Array.isArray(req.mcpAuth.scopes) && req.mcpAuth.scopes.includes(scope);
}
