/**
 * Redact secret-shaped tool arguments before approval UI or events.
 * Malicious schemas cannot mark secrets as harmless by renaming them to "note".
 */

import { looksLikeSecretKey, redactDeep } from './credentialRef.js';

const SENSITIVE_KEY_RE =
  /\b(password|passwd|secret|token|authorization|api[_-]?key|credential|ssn|credit|card|otp|session)\b/i;
const SENSITIVE_VALUE_RE =
  /(?:bearer\s+)?[a-z0-9_-]{24,}\.[a-z0-9_-]{10,}|sk-[a-z0-9]{16,}|ghp_[a-z0-9]{20,}|xox[a-z]-[a-z0-9-]{20,}/i;

export function isSensitiveArgKey(key) {
  return looksLikeSecretKey(key) || SENSITIVE_KEY_RE.test(String(key || ''));
}

export function redactToolArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (isSensitiveArgKey(key)) {
      out[key] = value == null || value === '' ? value : '[redacted]';
      continue;
    }
    if (typeof value === 'string' && SENSITIVE_VALUE_RE.test(value)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = typeof value === 'object' ? redactDeep(value) : value;
  }
  return out;
}

export function assertNotConfusedDeputyArgs(args) {
  if (!args || typeof args !== 'object') return;
  if (args.Authorization || args.access_token || args.refresh_token || args.credentialRef || args.bearer) {
    const err = new Error('confused_deputy_rejected');
    err.code = 'confused_deputy_rejected';
    throw err;
  }
  if ((args.serverUrl || args.mcpServer || args.endpoint) && (args.token || args.headers || args.secret)) {
    const err = new Error('confused_deputy_rejected');
    err.code = 'confused_deputy_rejected';
    throw err;
  }
}
