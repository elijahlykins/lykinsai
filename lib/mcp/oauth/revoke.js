/**
 * RFC 7009 token revocation. If the authorization server has no
 * revocation_endpoint, local credential deletion is the honest fallback.
 */

import { createGuardedFetch } from '../urlPolicy.js';

export async function revokeOAuthTokens({
  tokens,
  discovery,
  clientInformation,
  trustLevel,
} = {}) {
  const endpoint = discovery?.authorizationServerMetadata?.revocation_endpoint;
  if (!endpoint) {
    return { ok: true, remote: false, reason: 'revocation_endpoint_unsupported' };
  }
  const fetchFn = createGuardedFetch({ trustLevel });
  const body = new URLSearchParams();
  if (tokens?.access_token) body.set('token', tokens.access_token);
  else if (tokens?.refresh_token) body.set('token', tokens.refresh_token);
  else return { ok: true, remote: false, reason: 'no_token' };
  body.set('token_type_hint', tokens?.access_token ? 'access_token' : 'refresh_token');
  if (clientInformation?.client_id) body.set('client_id', clientInformation.client_id);

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!response.ok && response.status !== 200) {
      return { ok: true, remote: false, reason: `revocation_http_${response.status}` };
    }
    return { ok: true, remote: true };
  } catch (error) {
    return { ok: true, remote: false, reason: String(error?.code || error?.message || 'revocation_failed') };
  }
}
