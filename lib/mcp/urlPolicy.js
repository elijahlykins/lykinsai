/**
 * SSRF policy for remote MCP and OAuth URLs.
 *
 * Remote (custom/official/verified/community/enterprise): HTTPS to a public
 * address. No localhost / private / link-local / cloud-metadata targets.
 *
 * local_trusted: explicit opt-in for fixture/dev loopback. Still blocks
 * cloud metadata (169.254.169.254) and non-http(s) schemes.
 *
 * OAuth metadata, authorization, token, registration, and revocation
 * endpoints are NOT trusted merely because an MCP server returned them.
 * Each URL is checked independently. Redirect hops are re-validated.
 */

import net from 'node:net';
import { assertUrlSafe, isPrivateIp } from '../exterior/ssrfGuard.js';
import { MCP_TRUST_LEVELS, isRemoteNetworkTrust } from './protocol.js';
import { MCP_BOUNDS } from './bounds.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata.google.com']);
const UNSAFE_SCHEMES = new Set(['file:', 'ftp:', 'data:', 'javascript:', 'gopher:', 'unix:']);

export function parseMcpUrl(raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok: false, error: 'missing_url' };
  if (text.length > MCP_BOUNDS.SERVER_URL_CHARS) return { ok: false, error: 'url_too_long' };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (UNSAFE_SCHEMES.has(parsed.protocol)) {
    return { ok: false, error: 'unsafe_scheme' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'url_must_be_http_or_https' };
  }
  return { ok: true, url: parsed };
}

export function isLocalTrustedHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return LOCAL_HOSTS.has(host) || LOCAL_HOSTS.has(hostname);
}

export function isMetadataHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return METADATA_HOSTS.has(host) || host.startsWith('169.254.') || host.endsWith('.metadata.google.internal');
}

export async function assertMcpUrlSafe(rawUrl, { trustLevel = MCP_TRUST_LEVELS.CUSTOM } = {}) {
  const parsed = parseMcpUrl(rawUrl);
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isMetadataHost(host)) {
    return { ok: false, error: 'url_resolves_to_private_ip' };
  }

  if (trustLevel === MCP_TRUST_LEVELS.LOCAL_TRUSTED) {
    if (net.isIP(host) && isPrivateIp(host) && !isLocalTrustedHost(host)) {
      return { ok: false, error: 'private_ip_not_local_trusted' };
    }
    if (!isLocalTrustedHost(host)) {
      const remote = await assertUrlSafe(url.toString());
      if (!remote.ok) return remote;
    }
    return { ok: true, url: url.toString(), trustLevel };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, error: 'https_required_for_remote_mcp' };
  }
  if (isLocalTrustedHost(host)) {
    return { ok: false, error: 'localhost_requires_local_trusted' };
  }
  const safe = await assertUrlSafe(url.toString());
  if (!safe.ok) return safe;
  return { ok: true, url: safe.url || url.toString(), trustLevel };
}

/**
 * OAuth discovery / token / registration / revocation endpoint check.
 * Same network policy as the MCP connection trust level, applied independently
 * to every URL the authorization server advertises.
 */
export async function assertOAuthUrlSafe(rawUrl, { trustLevel = MCP_TRUST_LEVELS.CUSTOM } = {}) {
  return assertMcpUrlSafe(rawUrl, { trustLevel });
}

function blockedRedirectError(reason) {
  const err = new Error(`ssrf_blocked:${reason}`);
  err.code = 'SSRF_BLOCKED';
  err.reason = reason;
  return err;
}

/**
 * Fetch that always uses manual redirects and re-validates every hop.
 * local_trusted still cannot hop into metadata, file:, or non-http schemes.
 */
export async function guardedMcpFetch(url, init = {}, { trustLevel = MCP_TRUST_LEVELS.CUSTOM, signal, maxRedirects = 5 } = {}) {
  let current = String(url || '');
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = parseMcpUrl(current);
    if (!parsed.ok) throw blockedRedirectError(parsed.error);
    if (UNSAFE_SCHEMES.has(parsed.url.protocol)) throw blockedRedirectError('unsafe_scheme');
    const safe = await assertMcpUrlSafe(current, { trustLevel });
    if (!safe.ok) throw blockedRedirectError(safe.error);
    const merged = {
      ...init,
      redirect: 'manual',
      signal: signal && init.signal ? AbortSignal.any([signal, init.signal]) : signal || init.signal,
    };
    const res = await fetch(safe.url, merged);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location'), safe.url);
      if (UNSAFE_SCHEMES.has(next.protocol)) throw blockedRedirectError('unsafe_scheme');
      if (isRemoteNetworkTrust(trustLevel) && isLocalTrustedHost(next.hostname)) {
        throw blockedRedirectError('redirect_to_localhost');
      }
      if (isMetadataHost(next.hostname)) throw blockedRedirectError('url_resolves_to_private_ip');
      current = next.toString();
      continue;
    }
    return res;
  }
  throw blockedRedirectError('too_many_redirects');
}

export function createGuardedFetch({ trustLevel, signal } = {}) {
  return (url, init = {}) => guardedMcpFetch(url, init, { trustLevel, signal });
}
