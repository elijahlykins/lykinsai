import dns from 'node:dns/promises';
import net from 'node:net';

// ---------------------------------------------------------------------------
// SSRF guard: block requests that would reach loopback, private, link-local,
// or otherwise-internal addresses. The check operates on the RESOLVED IP, not
// the hostname string, so decimal/octal/hex IP encodings and DNS-rebinding
// (a public name that resolves to a private IP) are all caught. Callers must
// re-validate on every redirect hop — see safeFetch below.
// ---------------------------------------------------------------------------

/** Parse an IPv4 string in dotted / decimal / octal / hex form into 4 octets. */
function parseIpv4Flexible(host) {
  // Standard dotted quad first (fast path).
  if (net.isIPv4(host)) {
    return host.split('.').map((n) => parseInt(n, 10));
  }
  // Non-canonical forms: 2130706433, 0x7f000001, 017700000001, 127.1, 127.0.1
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (p === '') return null;
    let n;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // Collapse the trailing number to fill remaining octets (inet_aton semantics).
  const octets = [];
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 255) return null;
    octets.push(nums[i]);
  }
  let last = nums[nums.length - 1];
  const remaining = 4 - octets.length;
  const maxLast = Math.pow(256, remaining);
  if (last >= maxLast) return null;
  for (let i = remaining - 1; i >= 0; i--) {
    octets.splice(octets.length, 0, (last >> (8 * i)) & 0xff);
  }
  return octets.length === 4 ? octets : null;
}

/** True if the given IPv4 octets fall in a private / reserved / internal range. */
function isPrivateIpv4(octets) {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // multicast + reserved (224.0.0.0/3)
  return false;
}

/** True if the given IPv6 address string is loopback / link-local / ULA / mapped-private. */
function isPrivateIpv6(addr) {
  const lower = addr.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::1' || lower === '::') return true; // loopback / unspecified
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped / -compatible in dotted form (::ffff:a.b.c.d or ::a.b.c.d).
  const v4match = lower.match(/(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4match) {
    const octets = parseIpv4Flexible(v4match[1]);
    if (octets && isPrivateIpv4(octets)) return true;
  }
  // IPv4-mapped in hex form — WHATWG `new URL` normalizes ::ffff:127.0.0.1 to
  // ::ffff:7f00:1, so re-decode the trailing two hextets into a v4 address.
  const hexMapped = lower.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    const octets = [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
    if (isPrivateIpv4(octets)) return true;
  }
  return false;
}

/** True if a resolved IP string is unsafe (private/internal). */
export function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  const octets = parseIpv4Flexible(ip);
  if (!octets) return true; // unparseable → treat as unsafe
  return isPrivateIpv4(octets);
}

/**
 * Validate a single URL for SSRF safety. Resolves the hostname via DNS and
 * rejects if the URL is non-http(s), or if any resolved address is internal.
 * Returns { ok: true } or { ok: false, error }.
 */
export async function assertUrlSafe(urlStr) {
  let parsed;
  try {
    parsed = new URL(String(urlStr || ''));
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'url_must_be_http_or_https' };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  // Literal IP (any encoding) — validate directly, no DNS needed.
  if (net.isIP(host) || parseIpv4Flexible(host)) {
    if (isPrivateIp(net.isIP(host) ? host : normalizeLiteral(host))) {
      return { ok: false, error: 'url_resolves_to_private_ip' };
    }
    return { ok: true, url: parsed.toString() };
  }

  // Hostname — resolve and check every returned address (defeats rebinding at
  // check time; safeFetch also re-checks each redirect hop).
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return { ok: false, error: 'dns_resolution_failed' };
  }
  if (!addrs || addrs.length === 0) {
    return { ok: false, error: 'dns_no_records' };
  }
  for (const { address } of addrs) {
    if (isPrivateIp(address)) {
      return { ok: false, error: 'url_resolves_to_private_ip' };
    }
  }
  return { ok: true, url: parsed.toString() };
}

/** Normalize a non-canonical IPv4 literal to dotted-quad for isPrivateIp. */
function normalizeLiteral(host) {
  const octets = parseIpv4Flexible(host);
  return octets ? octets.join('.') : host;
}

/**
 * SSRF-safe fetch: validates the initial URL and manually follows redirects,
 * re-validating each hop, so an allowed public URL cannot 30x-redirect into an
 * internal address. Accepts the same init as fetch (minus `redirect`, which is
 * forced to 'manual'). Throws on an unsafe URL or too many redirects.
 */
export async function safeFetch(url, init = {}, opts = {}) {
  const maxRedirects = opts.maxRedirects ?? 5;
  let current = String(url || '');
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const safe = await assertUrlSafe(current);
    if (!safe.ok) {
      const err = new Error(`ssrf_blocked:${safe.error}`);
      err.code = 'SSRF_BLOCKED';
      err.reason = safe.error;
      throw err;
    }
    const res = await fetch(safe.url, { ...init, redirect: 'manual' });
    // Manual redirect handling.
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const location = res.headers.get('location');
      current = new URL(location, safe.url).toString();
      continue;
    }
    return res;
  }
  const err = new Error('ssrf_blocked:too_many_redirects');
  err.code = 'SSRF_BLOCKED';
  err.reason = 'too_many_redirects';
  throw err;
}
