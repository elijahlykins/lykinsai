/**
 * Development visibility for agent runs.
 *
 * Writes a structured JSONL trace per task (goal, plan, loaded skills, chosen
 * actions, expected vs observed outcomes, verification results, retries,
 * plan changes, completion reason) to userData/browser-agent-logs/.
 * Set LYKN_AGENT_DEBUG=1 to also mirror events to the console.
 *
 * Never logs hidden model reasoning or credentials — structured decisions and
 * observable outcomes only.
 */

const fs = require("node:fs");
const path = require("node:path");

const REDACTED = "[redacted]";
const MAX_STRING = 2000;
const MAX_DEPTH = 8;

// Keys whose VALUE is a secret regardless of its shape. Matched loosely so
// `authToken`, `api_key`, `Set-Cookie`, `sessionSecret`, `otpCode`, etc. all
// hit. The value is replaced wholesale — we keep the key so the trace still
// shows that, e.g., an authorization header was present.
const SENSITIVE_KEY_RE =
  /(pass(?:word|wd|code|phrase)|secret|token|bearer|authorization|auth[-_]?token|cookie|session[-_]?id|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|refresh[-_ ]?token|credential|\botp\b|one[-_ ]?time[-_ ]?code|\bcvv\b|\bcvc\b|card[-_ ]?number|\bssn\b)/i;

// Secret SHAPES that must be scrubbed wherever they appear in a string value,
// even under an innocuous key (e.g. a bearer token pasted into a URL/log line).
const VALUE_PATTERNS = [
  // JWT: three base64url segments, header starts with the classic `eyJ`.
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
  // Authorization / bearer prefix followed by a credential.
  /\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // Common provider key prefixes (OpenAI, GitHub, Google, AWS, Slack, Stripe…).
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[baprs]|AIza|AKIA|ASIA|ya29)[-_][A-Za-z0-9._-]{8,}/g,
  // Long card-number / SSN-shaped digit runs.
  /\b(?:\d[ -]?){13,19}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

/** Scrub secret shapes out of a single string, then bound its length. */
function redactString(str) {
  let out = String(str);
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…`;
  return out;
}

/**
 * Recursively redact secrets from a log payload while preserving structure and
 * ordinary metadata. Values under a sensitive key are dropped entirely; string
 * values everywhere are scanned for secret shapes; long strings are truncated.
 */
function redactValue(value, depth, seen) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return redactString(value);
  if (t === "number" || t === "boolean" || t === "bigint") return value;
  if (t === "function" || t === "symbol") return undefined;
  if (depth >= MAX_DEPTH) return "[depth-limited]";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const arr = value.slice(0, 200).map((v) => redactValue(v, depth + 1, seen));
    seen.delete(value);
    return arr;
  }
  if (t === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Numbers/booleans under a sensitive-looking key are metrics ("tokens"
      // usage counts), not credentials — secrets are strings/structures.
      const isCountLike = typeof v === "number" || typeof v === "boolean";
      if (SENSITIVE_KEY_RE.test(k) && !isCountLike) out[k] = REDACTED;
      else out[k] = redactValue(v, depth + 1, seen);
    }
    seen.delete(value);
    return out;
  }
  return undefined;
}

function createDebugLog({ userDataPath, taskId } = {}) {
  const verbose = process.env.LYKN_AGENT_DEBUG === "1";
  let stream = null;
  if (userDataPath) {
    try {
      const dir = path.join(userDataPath, "browser-agent-logs");
      fs.mkdirSync(dir, { recursive: true });
      stream = fs.createWriteStream(path.join(dir, `${taskId || Date.now()}.jsonl`), {
        flags: "a",
      });
    } catch {
      stream = null;
    }
  }

  function log(event, data = {}) {
    const entry = { at: new Date().toISOString(), event, ...sanitize(data) };
    try {
      stream?.write(`${JSON.stringify(entry)}\n`);
    } catch {
      /* logging must never break the agent */
    }
    if (verbose) {
      console.log(`[browser-agent] ${event}`, JSON.stringify(sanitize(data)).slice(0, 600));
    }
  }

  function sanitize(data) {
    return redactValue(data || {}, 0, new WeakSet());
  }

  function close() {
    try {
      stream?.end();
    } catch {
      /* noop */
    }
  }

  return { log, close };
}

module.exports = { createDebugLog, redactValue, redactString };
