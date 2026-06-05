const MAX_RESPONSE_BYTES = 512 * 1024;
const TIMEOUT_MS = 12_000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const MAX_REQUESTS_PER_MINUTE = 20;

const BLOCKED_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\]|metadata\.google)/i;

const rateBuckets = new Map();

function rateLimitKey(userId, url) {
  try {
    const host = new URL(url).hostname;
    return `${userId || 'anon'}:${host}`;
  } catch {
    return `${userId || 'anon'}:invalid`;
  }
}

function checkRateLimit(key) {
  const now = Date.now();
  const windowMs = 60_000;
  const bucket = rateBuckets.get(key) || [];
  const recent = bucket.filter((t) => now - t < windowMs);
  if (recent.length >= MAX_REQUESTS_PER_MINUTE) {
    return { ok: false, error: 'rate_limit_exceeded', retry_after_sec: 60 };
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  return { ok: true };
}

function isBlockedUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return true;
    if (BLOCKED_HOST_RE.test(u.hostname)) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Restricted HTTP client for API integrations.
 */
export async function httpRequest(args = {}, ctx = {}) {
  const method = String(args.method || 'GET').trim().toUpperCase();
  const url = String(args.url || '').trim();
  if (!ALLOWED_METHODS.has(method)) {
    return { ok: false, error: 'invalid_method', allowed: [...ALLOWED_METHODS] };
  }
  if (!url) return { ok: false, error: 'url is required' };
  if (isBlockedUrl(url)) return { ok: false, error: 'url_not_allowed' };

  const rl = checkRateLimit(rateLimitKey(ctx.userId, url));
  if (!rl.ok) return rl;

  const headers = {};
  if (args.headers && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
    for (const [k, v] of Object.entries(args.headers)) {
      const key = String(k || '').trim();
      if (!key || /^cookie$/i.test(key) || /^authorization$/i.test(key)) continue;
      headers[key] = String(v ?? '');
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const init = { method, headers, signal: controller.signal, redirect: 'follow' };
    if (args.body != null && !['GET', 'HEAD'].includes(method)) {
      init.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        init.headers = { ...headers, 'Content-Type': 'application/json' };
      }
    }

    const res = await fetch(url, init);
    clearTimeout(timer);
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > MAX_RESPONSE_BYTES;
    const bodyText = (truncated ? buf.slice(0, MAX_RESPONSE_BYTES) : buf).toString('utf8');

    let json = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      try {
        json = JSON.parse(bodyText);
      } catch {
        json = null;
      }
    }

    return {
      ok: res.ok,
      status: res.status,
      url,
      method,
      content_type: ct,
      body: json ?? bodyText,
      truncated,
      bytes: buf.length,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === 'AbortError') return { ok: false, error: 'request_timeout', timeout_ms: TIMEOUT_MS };
    return { ok: false, error: err?.message || 'request_failed' };
  }
}
