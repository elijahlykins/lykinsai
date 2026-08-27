/**
 * credentialRef: the only credential handle that may appear on connections.
 *
 * Secrets live in encrypted storage and are resolved only by trusted runtime.
 * They must never appear in Task, BotDefinition, Routine, tool schema,
 * model prompt, tool result, Task events, notifications, or logs.
 */

const SECRET_KEY_RE = /^(secret|token|access_token|refresh_token|authorization|api[_-]?key|password|credential|bearer)$/i;
const SECRET_VALUE_RE = /(?:bearer\s+)?[a-z0-9_-]{24,}\.[a-z0-9_-]{10,}|sk-[a-z0-9]{16,}|ghp_[a-z0-9]{20,}|xox[a-z]-[a-z0-9-]{20,}/i;

export const CREDENTIAL_REF_TYPES = Object.freeze({
  NONE: 'none',
  MCP_SECRET: 'mcp_secret',
  MCP_OAUTH: 'mcp_oauth',
  OAUTH_SOCIAL_CONNECTION: 'oauth_social_connection',
});

export function createCredentialRef(input = {}) {
  const type = String(input.type || CREDENTIAL_REF_TYPES.NONE);
  if (type === CREDENTIAL_REF_TYPES.NONE) {
    return Object.freeze({ type: CREDENTIAL_REF_TYPES.NONE });
  }
  if (type === CREDENTIAL_REF_TYPES.MCP_SECRET || type === CREDENTIAL_REF_TYPES.MCP_OAUTH) {
    const connectionId = String(input.connectionId || '').trim();
    if (!connectionId) throw new TypeError(`${type} credentialRef requires connectionId`);
    return Object.freeze({ type, connectionId });
  }
  if (type === CREDENTIAL_REF_TYPES.OAUTH_SOCIAL_CONNECTION) {
    const socialConnectionId = String(input.socialConnectionId || '').trim();
    if (!socialConnectionId) {
      throw new TypeError('oauth_social_connection credentialRef requires socialConnectionId');
    }
    return Object.freeze({
      type: CREDENTIAL_REF_TYPES.OAUTH_SOCIAL_CONNECTION,
      socialConnectionId,
    });
  }
  throw new TypeError(`unsupported credentialRef type: ${type}`);
}

export function publicCredentialRef(ref) {
  if (!ref || ref.type === CREDENTIAL_REF_TYPES.NONE) {
    return { type: CREDENTIAL_REF_TYPES.NONE };
  }
  if (ref.type === CREDENTIAL_REF_TYPES.MCP_SECRET || ref.type === CREDENTIAL_REF_TYPES.MCP_OAUTH) {
    return { type: ref.type, connectionId: String(ref.connectionId) };
  }
  if (ref.type === CREDENTIAL_REF_TYPES.OAUTH_SOCIAL_CONNECTION) {
    return {
      type: CREDENTIAL_REF_TYPES.OAUTH_SOCIAL_CONNECTION,
      socialConnectionId: String(ref.socialConnectionId),
    };
  }
  return { type: CREDENTIAL_REF_TYPES.NONE };
}

export function looksLikeSecretKey(key) {
  return SECRET_KEY_RE.test(String(key || ''));
}

export function redactValue(value) {
  const text = String(value ?? '');
  if (!text) return text;
  if (SECRET_VALUE_RE.test(text) || text.length > 24 && /secret|token|bearer/i.test(text)) {
    return '[redacted]';
  }
  return text;
}

export function redactDeep(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') return redactValue(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (looksLikeSecretKey(key)) {
      out[key] = item == null || item === '' ? item : '[redacted]';
      continue;
    }
    out[key] = redactDeep(item, depth + 1);
  }
  return out;
}

export function assertNoSecretMaterial(value, label = 'payload') {
  const json = JSON.stringify(value);
  if (!json) return;
  if (/"secret_encrypted"|access_token|refresh_token|"Authorization"/i.test(json) && SECRET_VALUE_RE.test(json)) {
    const err = new Error(`secret_material_leaked:${label}`);
    err.code = 'SECRET_MATERIAL_LEAKED';
    throw err;
  }
}
