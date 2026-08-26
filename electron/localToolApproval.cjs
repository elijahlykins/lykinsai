/**
 * Main-process approval tokens for renderer-invoked Local Mode tools.
 *
 * The `lykn:local-tool-run` IPC used to accept a renderer-supplied
 * `approved: true` boolean and forward it straight into `localSystem.run`,
 * where it skips the risky-action gate. That let any renderer turn an
 * unapproved destructive action into an approved one with a single flag.
 *
 * This registry removes renderer authority to self-assert approval. Approval
 * can now only come from a token that:
 *   - is minted by MAIN (crypto-random, unguessable), never by the renderer,
 *   - is bound to the exact tool + normalized security-relevant args,
 *   - is single-use (consumed on first check, so it cannot be replayed), and
 *   - expires after a short TTL.
 *
 * Main mints a token only when `localSystem.run` itself reports the action
 * needs approval (i.e. main's own risk classifier fired). The renderer's
 * approval UI carries that token back to authorize the SAME action. It cannot
 * be used to approve a different command or a different file operation, and it
 * is invalid the moment it is consumed.
 *
 * NOTE: this does not, by itself, prove a human clicked Approve — a fully
 * compromised privileged renderer could still round-trip a token. Closing that
 * requires per-IPC sender attestation, which is deferred to the agent-harness
 * security phase. What this closes is the trivial `approved: true` forgery and
 * cross-action / replay reuse.
 */

const crypto = require("node:crypto");

const DEFAULT_TTL_MS = 2 * 60 * 1000; // 2 minutes: long enough for a human to read + click.

/**
 * Reduce a tool call to the security-relevant fields a token is bound to.
 * Two calls that would run the same destructive operation produce the same
 * key; changing the command, path, or contents produces a different key, so a
 * token minted for one action cannot authorize another.
 */
function normalizeArgsForApproval(name, args = {}) {
  const a = args && typeof args === "object" ? args : {};
  const str = (v) => (v === undefined || v === null ? "" : String(v));
  switch (name) {
    case "local_run_command":
      return JSON.stringify({ command: str(a.command), cwd: str(a.cwd) });
    case "local_write_file":
      return JSON.stringify({ path: str(a.path), content: str(a.content) });
    case "local_edit_file":
      return JSON.stringify({
        path: str(a.path),
        oldText: str(a.oldText),
        newText: str(a.newText),
        replaceAll: a.replaceAll === true,
        overwrite: a.overwrite === true,
      });
    default:
      // Unknown / future risky tools: bind to the full arg set so a token is
      // never broader than the action it was minted for.
      return JSON.stringify({ name: str(name), args: a });
  }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] token lifetime in ms
 * @param {() => number} [opts.now] clock (injectable for tests)
 */
function createLocalApprovalRegistry({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  /** @type {Map<string, { name: string, argsKey: string, expiresAt: number }>} */
  const pending = new Map();

  function sweep() {
    const t = now();
    for (const [token, rec] of pending) {
      if (t > rec.expiresAt) pending.delete(token);
    }
  }

  /** Mint a token bound to this exact tool + args. */
  function issue(name, args) {
    sweep();
    const token = crypto.randomBytes(32).toString("hex");
    pending.set(token, {
      name: String(name || ""),
      argsKey: normalizeArgsForApproval(name, args),
      expiresAt: now() + ttlMs,
    });
    return token;
  }

  /**
   * Single-use check: returns true only if the token exists, is unexpired, and
   * was minted for this exact tool + args. The token is removed regardless of
   * the outcome, so a wrong/expired attempt cannot be retried and a valid one
   * cannot be replayed.
   */
  function consume(token, name, args) {
    const t = String(token || "");
    if (!t) return false;
    const rec = pending.get(t);
    if (!rec) return false;
    pending.delete(t);
    if (now() > rec.expiresAt) return false;
    if (rec.name !== String(name || "")) return false;
    if (rec.argsKey !== normalizeArgsForApproval(name, args)) return false;
    return true;
  }

  function size() {
    return pending.size;
  }

  return { issue, consume, size, normalizeArgsForApproval };
}

module.exports = { createLocalApprovalRegistry, normalizeArgsForApproval, DEFAULT_TTL_MS };
