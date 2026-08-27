"use strict";

const DROP_KEY = /(?:pass(?:word|code|phrase)?|pwd|pin|otp|totp|2fa|mfa|passkey|webauthn|authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|oauth(?:[-_]?code)?|private[-_]?key|ssh[-_]?key|credential|payment|billing|card[-_]?number|cvv|cvc|security[-_]?code|bank[-_]?account)/i;
const TAKEOVER_KEY = /(?:pass(?:word|code|phrase)?|pwd|pin|otp|totp|2fa|mfa|passkey|webauthn|payment|billing|card[-_]?number|cvv|cvc|security[-_]?code)/i;
const SECRET_VALUE = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP|PRIVATE) KEY-----/,
  /\bssh-(?:rsa|ed25519)\s+[A-Za-z0-9+/]{20,}={0,3}/,
];
const TAKEOVER_TEXT = /\b(?:enter|type|provide|confirm|scan|use)\b.{0,40}\b(?:password|passcode|pin|otp|one[- ]time code|verification code|2fa|mfa|passkey|security key|cvv|cvc)\b/i;
const SECRET_ASSIGNMENT = /\b(?:password|passcode|pin|otp|totp|authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|oauth[-_]?code|private[-_]?key|cookie)\s*[:=]\s*\S+/i;
const DROP = Symbol("drop");

function containsPaymentCard(value) {
  const digits = String(value || "").replace(/[\s-]/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function scrubSensitive(input, { maxDepth = 12, maxEntries = 2000 } = {}) {
  const droppedPaths = [];
  let humanTakeover = false;
  let entries = 0;
  const seen = new WeakSet();

  function visit(value, path, depth, key = "") {
    if (++entries > maxEntries || depth > maxDepth) {
      droppedPaths.push(path);
      return DROP;
    }
    if (DROP_KEY.test(key)) {
      droppedPaths.push(path);
      if (TAKEOVER_KEY.test(key)) humanTakeover = true;
      return DROP;
    }
    if (typeof value === "string") {
      if (TAKEOVER_TEXT.test(value)) humanTakeover = true;
      if (/^https?:\/\//i.test(value)) {
        try {
          const parsed = new URL(value);
          let changed = false;
          for (const name of [...parsed.searchParams.keys()]) {
            if (DROP_KEY.test(name) || /^(?:code|key|signature|sig)$/i.test(name)) {
              parsed.searchParams.delete(name);
              changed = true;
            }
          }
          if (parsed.hash && /(?:token|secret|code|key|credential|password)/i.test(parsed.hash)) {
            parsed.hash = "";
            changed = true;
          }
          if (changed) {
            droppedPaths.push(path);
            return parsed.toString();
          }
        } catch {
          /* malformed URL remains subject to the assignment checks below */
        }
      }
      if (
        SECRET_VALUE.some((pattern) => pattern.test(value)) ||
        SECRET_ASSIGNMENT.test(value) ||
        containsPaymentCard(value)
      ) {
        droppedPaths.push(path);
        return DROP;
      }
      return value;
    }
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) {
      droppedPaths.push(path);
      return DROP;
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const clean = visit(value[index], `${path}[${index}]`, depth + 1);
        if (
          clean !== DROP &&
          !(clean && typeof clean === "object" && !Array.isArray(clean) && Object.keys(clean).length === 0)
        ) result.push(clean);
      }
      return result;
    }
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const clean = visit(childValue, path ? `${path}.${childKey}` : childKey, depth + 1, childKey);
      if (clean !== DROP) result[childKey] = clean;
    }
    return result;
  }

  const value = visit(input, "$", 0);
  return {
    value: value === DROP ? null : value,
    humanTakeover,
    droppedPaths,
  };
}

module.exports = { scrubSensitive, DROP_KEY, TAKEOVER_TEXT, containsPaymentCard };
