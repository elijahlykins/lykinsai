"use strict";

/**
 * The RemoteTarget model — a durable, model-safe description of a system LYKN
 * operates INSIDE (an SSH server, dev box, VM, or production host).
 *
 * The single most important property of this model: it carries a credential
 * REFERENCE, never a secret. `authRef` names WHERE the OS resolves the
 * credential (the SSH agent, a keychain-backed key file, `~/.ssh/config`), and
 * that resolution happens entirely inside the system `ssh` client in trusted
 * host code. No password, passphrase, private-key body, or token ever lives on
 * a RemoteTarget, so a RemoteTarget can be serialized into a Task event, a
 * notification, or a model prompt (via `modelView`) without leaking anything.
 *
 * `environment` (development / staging / production / unknown) is authoritative
 * runtime configuration. It is set by the user/host, never by the model. The
 * model may SUGGEST a classification, but `applyModelSuggestion` can only ever
 * raise strictness (toward production), never downgrade a production host to
 * development — risk cannot be talked down.
 */

const crypto = require("node:crypto");
const { ENVIRONMENTS } = require("./remotePolicy.cjs");

const DEFAULT_SSH_PORT = 22;
// How strict each environment is, higher = more caution. A model suggestion may
// only move a target to a stricter (>=) environment, never a looser one.
const ENVIRONMENT_STRICTNESS = Object.freeze({
  development: 0,
  staging: 1,
  unknown: 2,
  production: 3,
});

function newTargetId() {
  return `rtarget_${crypto.randomBytes(10).toString("hex")}`;
}

function cleanEnvironment(value) {
  const v = String(value || "").trim().toLowerCase();
  return ENVIRONMENTS.includes(v) ? v : "unknown";
}

/**
 * A username/hostname is safe for an `ssh` argv slot when it contains no shell
 * metacharacters, whitespace, or option-injection dashes. The transport passes
 * these as discrete argv (never a shell string), but validating here keeps a
 * hostile ad-hoc string ("-oProxyCommand=…", "$(rm -rf /)") from ever forming a
 * target at all.
 */
const SAFE_USER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_HOST_RE = /^(?!-)[A-Za-z0-9._:-]{1,255}$/;

function isSafeUsername(value) {
  return SAFE_USER_RE.test(String(value || ""));
}

function isSafeHostname(value) {
  const host = String(value || "");
  // Reject a leading dash (option injection) and anything with shell/space
  // metacharacters. Allow IPv6 colons and dotted names.
  return SAFE_HOST_RE.test(host) && !host.startsWith("-");
}

/**
 * Parse an ad-hoc target string ("user@host", "host", "user@host:2222", or an
 * "ssh user@host -p 2222" fragment) into { username, host, port } WITHOUT
 * resolving or persisting anything. Returns null when the string cannot be
 * parsed into a safe target — a hostile string never becomes a target.
 */
function parseAdHocTarget(input) {
  let raw = String(input || "").trim();
  if (!raw) return null;
  // Tolerate a leading "ssh " the user may have typed verbatim.
  raw = raw.replace(/^ssh\s+/i, "").trim();
  if (!raw) return null;

  let port = DEFAULT_SSH_PORT;
  // Pull an explicit `-p <port>` / `-p<port>` flag if present, then strip it.
  const portFlag = raw.match(/\s-p\s*(\d{1,5})\b/);
  if (portFlag) {
    port = Number(portFlag[1]);
    raw = raw.replace(portFlag[0], " ").trim();
  }
  // After stripping the port flag, exactly ONE token may remain. Anything else
  // ("user@exa mple.com", "user@host; rm -rf /", a trailing command) is
  // ambiguous or hostile and never becomes a target.
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length !== 1) return null;
  const token = tokens[0];

  let username = "";
  let hostPart = token;
  const at = token.lastIndexOf("@");
  if (at >= 0) {
    username = token.slice(0, at);
    hostPart = token.slice(at + 1);
  }
  // host:port form (only when not an IPv6 literal in brackets).
  if (!hostPart.startsWith("[")) {
    const colon = hostPart.lastIndexOf(":");
    if (colon > 0 && /^\d{1,5}$/.test(hostPart.slice(colon + 1))) {
      port = Number(hostPart.slice(colon + 1));
      hostPart = hostPart.slice(0, colon);
    }
  } else {
    // [ipv6]:port
    const m = hostPart.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (!m) return null;
    hostPart = m[1];
    if (m[2]) port = Number(m[2]);
  }

  if (username && !isSafeUsername(username)) return null;
  if (!isSafeHostname(hostPart)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { username: username || "", host: hostPart, port };
}

/**
 * Canonicalize a RemoteTarget record. Throws TypeError when host/username are
 * unsafe or missing, so an invalid target can never be persisted or connected.
 *
 * @param {object} input
 * @param {object} [options] { now, id }
 */
function createRemoteTarget(input = {}, options = {}) {
  const host = String(input.host || "").trim();
  if (!isSafeHostname(host)) throw new TypeError("RemoteTarget requires a safe host");
  const username = String(input.username || "").trim();
  if (username && !isSafeUsername(username)) throw new TypeError("RemoteTarget username is unsafe");
  const port = Number.isInteger(Number(input.port)) ? Number(input.port) : DEFAULT_SSH_PORT;
  if (port < 1 || port > 65535) throw new TypeError("RemoteTarget port is out of range");

  const now = String(options.now || input.createdAt || new Date().toISOString());
  const id = String(options.id || input.id || newTargetId());
  const name =
    String(input.name || "").trim().slice(0, 80) ||
    (username ? `${username}@${host}` : host);

  return Object.freeze({
    id,
    name,
    type: "ssh",
    host,
    port,
    username,
    environment: cleanEnvironment(input.environment),
    // authRef: a credential REFERENCE, never a secret. Shapes:
    //   { kind: "agent" }                       — use the running SSH agent
    //   { kind: "default" }                     — let ssh/~/.ssh/config decide
    //   { kind: "keyFile", path: "~/.ssh/id" }  — a key path (never its body)
    //   { kind: "sshConfigHost", host: "prod" } — a Host alias in ~/.ssh/config
    authRef: sanitizeAuthRef(input.authRef),
    workingDirectory: String(input.workingDirectory || "").trim().slice(0, 512) || "",
    trustedHostFingerprint: sanitizeFingerprint(input.trustedHostFingerprint),
    // Optional per-target default capability envelope the host may apply when a
    // Task targets this host. Purely advisory here; enforcement is in policy.
    defaultCapabilities: Array.isArray(input.defaultCapabilities)
      ? input.defaultCapabilities.map(String).filter(Boolean).slice(0, 20)
      : [],
    saved: input.saved !== false,
    createdAt: now,
    updatedAt: String(input.updatedAt || now),
  });
}

/**
 * authRef sanitization: it must NEVER contain secret material. Any key that
 * looks like a secret is dropped; only a reference kind + a path/host label
 * survives. A private-key BODY (multi-line PEM) can never masquerade as a path.
 */
function sanitizeAuthRef(authRef) {
  const ref = authRef && typeof authRef === "object" ? authRef : {};
  const kind = String(ref.kind || "default").trim();
  const allowed = new Set(["default", "agent", "keyFile", "sshConfigHost"]);
  const safeKind = allowed.has(kind) ? kind : "default";
  const out = { kind: safeKind };
  if (safeKind === "keyFile") {
    const p = String(ref.path || "").trim();
    // A path is a single line with no PEM markers and no whitespace-newlines.
    if (p && !/[\n\r]/.test(p) && !/BEGIN [A-Z ]*PRIVATE KEY/.test(p)) {
      out.path = p.slice(0, 512);
    } else {
      out.kind = "default";
    }
  }
  if (safeKind === "sshConfigHost") {
    const h = String(ref.host || "").trim();
    if (h && isSafeHostname(h)) out.host = h.slice(0, 255);
    else out.kind = "default";
  }
  return Object.freeze(out);
}

/** A trusted host fingerprint is a short single-line token (e.g. SHA256:…). */
function sanitizeFingerprint(value) {
  const fp = String(value || "").trim();
  if (!fp) return "";
  if (/[\n\r\s]/.test(fp)) return "";
  return fp.slice(0, 200);
}

/**
 * The ONLY projection of a target the model/prompt/event/notification may see.
 * It carries identity and environment, never authRef material, host, or
 * fingerprint. "Remote target: Production API Server" — not the address, not
 * the key. Callers that need the address for the transport read the full
 * record in host code, never through this view.
 */
function modelView(target) {
  if (!target) return null;
  return Object.freeze({
    id: target.id,
    name: target.name,
    environment: target.environment,
    trusted: !!target.trustedHostFingerprint,
  });
}

/**
 * A redacted projection safe for the Remote Targets UI and Activity: shows the
 * connection address (which the user configured and needs to recognize the
 * host) but never authRef material or the raw fingerprint bytes.
 */
function publicView(target) {
  if (!target) return null;
  return Object.freeze({
    id: target.id,
    name: target.name,
    type: target.type,
    host: target.host,
    port: target.port,
    username: target.username,
    environment: target.environment,
    workingDirectory: target.workingDirectory,
    authKind: target.authRef?.kind || "default",
    trusted: !!target.trustedHostFingerprint,
    saved: target.saved,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  });
}

/**
 * Apply a model-suggested environment classification. Enforces the one-way
 * ratchet: a suggestion may only move the target to a STRICTER environment.
 * A model can never downgrade production → development to dodge approval.
 *
 * @returns {{ environment: string, changed: boolean }}
 */
function applyModelSuggestion(currentEnvironment, suggestedEnvironment) {
  const current = cleanEnvironment(currentEnvironment);
  // A suggestion that is not a real environment name is ignored outright — it
  // must never mutate configuration, not even toward "unknown".
  const raw = String(suggestedEnvironment || "").trim().toLowerCase();
  if (!ENVIRONMENTS.includes(raw)) return { environment: current, changed: false };
  const currentStrictness = ENVIRONMENT_STRICTNESS[current] ?? 2;
  const suggestedStrictness = ENVIRONMENT_STRICTNESS[raw] ?? 2;
  if (suggestedStrictness > currentStrictness) {
    return { environment: raw, changed: true };
  }
  return { environment: current, changed: false };
}

module.exports = {
  DEFAULT_SSH_PORT,
  ENVIRONMENT_STRICTNESS,
  createRemoteTarget,
  parseAdHocTarget,
  sanitizeAuthRef,
  sanitizeFingerprint,
  modelView,
  publicView,
  applyModelSuggestion,
  isSafeUsername,
  isSafeHostname,
  cleanEnvironment,
};
