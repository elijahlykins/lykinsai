/**
 * Local MCP environment is credential refs only.
 * Resolved values exist only in the child process env at launch.
 */

import { looksLikeSecretKey } from '../credentialRef.js';

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function normalizeEnvCredentialRefs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key || '').trim();
    if (!ENV_NAME_RE.test(name)) continue;
    if (typeof value === 'string') {
      const id = value.trim();
      if (!id || looksLikeSecretKey(id) || id.length > 80) continue;
      if (/token|secret|bearer|password/i.test(id) && !/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      out[name] = { type: 'lykn_credential', id };
      continue;
    }
    if (value && typeof value === 'object') {
      const id = String(value.id || value.credentialId || '').trim();
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      out[name] = { type: String(value.type || 'lykn_credential'), id };
    }
  }
  return out;
}

export function publicEnvCredentialRefs(refs) {
  const normalized = normalizeEnvCredentialRefs(refs);
  const out = {};
  for (const [key, value] of Object.entries(normalized)) {
    out[key] = { type: value.type, id: value.id };
  }
  return out;
}

export function assertNoRawEnvSecrets(raw) {
  if (!raw || typeof raw !== 'object') return { ok: true };
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && (looksLikeSecretKey(key) || /sk-|ghp_|xox|bearer /i.test(value))) {
      return { ok: false, error: 'raw_env_secret_rejected' };
    }
    if (typeof value === 'string' && value.length > 24 && /secret|token|password/i.test(key)) {
      return { ok: false, error: 'raw_env_secret_rejected' };
    }
  }
  return { ok: true };
}

const SAFE_PARENT_ENV = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'NVM_DIR',
  'HOMEBREW_PREFIX',
  'HOMEBREW_CELLAR',
  'ComSpec',
  'SYSTEMROOT',
];

export function sanitizedParentEnv(env = process.env) {
  const out = {};
  for (const key of SAFE_PARENT_ENV) {
    if (env[key]) out[key] = env[key];
  }
  return out;
}

export async function resolveEnvCredentialRefs(refs, { resolveCredential } = {}) {
  const normalized = normalizeEnvCredentialRefs(refs);
  const env = {};
  for (const [key, ref] of Object.entries(normalized)) {
    if (typeof resolveCredential !== 'function') {
      throw Object.assign(new Error('credential_resolver_missing'), { code: 'credential_resolver_missing' });
    }
    const secret = await resolveCredential(ref, { envName: key });
    if (!secret) {
      throw Object.assign(new Error(`unresolved_env_ref:${key}`), { code: 'unresolved_env_ref' });
    }
    env[key] = String(secret);
  }
  return env;
}
