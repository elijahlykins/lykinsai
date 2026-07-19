import crypto from 'node:crypto';
import { GENERATED_IMAGE_BUCKET } from './constants.js';

// ============================================
// FILE DOWNLOAD PROXY
// ============================================
// Capability artifacts live in Supabase storage, but we don't want to hand
// users raw `https://<project>.supabase.co/storage/...` signed URLs — they
// leak the storage backend and the project ref. Instead we mint a short,
// HMAC-signed token and serve the file through this API server at
// `<base>/f/<token>`. The token itself is the authorization (it encodes the
// bucket + object path + expiry, signed with a server secret), so the proxy
// route can stream the object back without a user session.

const ROUTE_PREFIX = '/f/';

/** Secret used to sign download tokens. Prefer a dedicated FILE_PROXY_SECRET.
 * If only the service-role key is available we do NOT use it directly as the
 * HMAC key — we derive a dedicated subkey via HKDF so a token-signing/verify
 * oracle can never reveal or reuse the database master key. Tokens are
 * short-lived, so the effective-secret change on first deploy just regenerates
 * in-flight download links. */
let _cachedProxyKey = null;
function proxySecret() {
  if (_cachedProxyKey) return _cachedProxyKey;
  const explicit = process.env.FILE_PROXY_SECRET;
  if (explicit) {
    _cachedProxyKey = explicit;
    return _cachedProxyKey;
  }
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base) throw new Error('file_proxy_secret_missing');
  _cachedProxyKey = Buffer.from(
    crypto.hkdfSync('sha256', base, 'lykn-file-proxy-salt-v1', 'file-proxy-token', 32),
  );
  return _cachedProxyKey;
}

/** Public origin of THIS API server (where the proxy route is mounted). */
export function fileProxyBaseUrl() {
  // Mirrors how server.js resolves its public origin (OAuth metadata, etc.):
  // explicit override → Render's auto-injected external URL → local dev port.
  // Intentionally does NOT use PUBLIC_SERVER_URL so local downloads stay on
  // localhost instead of pointing at the deployed host.
  const raw =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${process.env.PORT || 3001}`;
  return String(raw).replace(/\/+$/, '');
}

function b64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payloadB64) {
  return b64urlEncode(crypto.createHmac('sha256', proxySecret()).update(payloadB64).digest());
}

/**
 * Mint a signed download token for an object in storage.
 * @param {object} opts
 * @param {string} opts.path     Object path within the bucket (e.g. `<uid>/capabilities/...`).
 * @param {string} [opts.bucket] Storage bucket (defaults to the generated-files bucket).
 * @param {string} [opts.filename] Suggested download filename.
 * @param {number} [opts.ttlSec] Seconds until the token expires (default 7 days).
 */
export function signFileToken({ path, bucket, filename, ttlSec } = {}) {
  const p = String(path || '').trim();
  if (!p) throw new Error('file_proxy_path_required');
  const ttl = Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : 60 * 60 * 24 * 7;
  const payload = {
    b: bucket || GENERATED_IMAGE_BUCKET,
    p,
    e: Math.floor(Date.now() / 1000) + ttl,
  };
  if (filename) payload.f = String(filename);
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Verify + decode a download token. Returns null when invalid/expired/tampered. */
export function verifyFileToken(token) {
  const raw = String(token || '');
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  let expected;
  try {
    expected = sign(payloadB64);
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload?.p || typeof payload.e !== 'number') return null;
  if (payload.e < Math.floor(Date.now() / 1000)) return null;
  return {
    bucket: payload.b || GENERATED_IMAGE_BUCKET,
    path: String(payload.p),
    filename: payload.f ? String(payload.f) : '',
  };
}

/** Build the full, branded download URL for an object in storage. */
export function buildFileProxyUrl(opts = {}) {
  return `${fileProxyBaseUrl()}${ROUTE_PREFIX}${signFileToken(opts)}`;
}

export const FILE_PROXY_ROUTE = `${ROUTE_PREFIX}:token`;
