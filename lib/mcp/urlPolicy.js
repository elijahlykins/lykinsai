/**
 * SSRF policy for remote MCP URLs.
 *
 * Remote (default): HTTPS to a public address. No localhost / private /
 * link-local / cloud-metadata targets.
 *
 * local_trusted: explicit opt-in for fixture/dev loopback. Still blocks
 * cloud metadata (169.254.169.254) and non-http(s) schemes.
 */

import net from 'node:net';
import { assertUrlSafe, isPrivateIp } from '../exterior/ssrfGuard.js';
import { MCP_TRUST_LEVELS } from './protocol.js';
import { MCP_BOUNDS } from './bounds.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal']);

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
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'url_must_be_http_or_https' };
  }
  return { ok: true, url: parsed };
}

export function isLocalTrustedHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return LOCAL_HOSTS.has(host) || LOCAL_HOSTS.has(hostname);
}

export async function assertMcpUrlSafe(rawUrl, { trustLevel = MCP_TRUST_LEVELS.REMOTE } = {}) {
  const parsed = parseMcpUrl(rawUrl);
  if (!parsed.ok) return parsed;
  const { url } = parsed;
  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (METADATA_HOSTS.has(host) || host.startsWith('169.254.')) {
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
  return { ok: true, url: safe.url || url.toString(), trustLevel: MCP_TRUST_LEVELS.REMOTE };
}
