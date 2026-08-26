"use strict";

/**
 * Trust-gated connection orchestration, factored out so it is testable with a
 * fake transport and reused by the host seam that wires RemoteExecutor.
 *
 * The security contract lives here, not in the model loop:
 *
 *   - First use of a host (no trusted fingerprint) requires EXPLICIT human
 *     trust establishment. LYKN retrieves the fingerprint out-of-band
 *     (ssh-keyscan), shows it, and only persists it after the user trusts it.
 *     A model-generated "yes" cannot reach onTrustEstablish — the host wires it
 *     to real approval UI.
 *   - If a previously trusted host's key CHANGES, LYKN never silently accepts
 *     it. The connection is refused and the Task pauses as HOST_KEY_CHANGED for
 *     human attention (a possible MITM).
 *   - Interactive auth (passphrase / password / 2FA) surfaces as waiting_for_
 *     user rather than a generic failure or a hang.
 */

const { createSshTransport, HOST_KEY_CHANGED, HOST_UNTRUSTED } = require("./sshTransport.cjs");
const { createRemoteSession } = require("./remoteSession.cjs");

/**
 * @param {object} opts
 * @param {object} opts.target              resolved RemoteTarget (host-side)
 * @param {string} opts.taskId
 * @param {string} opts.runId
 * @param {string} [opts.trustedFingerprint]
 * @param {AbortSignal} [opts.signal]
 * @param {(args: {target: object}) => object} [opts.createTransport]
 * @param {(args: {fingerprint: string, target: object}) => Promise<boolean>} [opts.onTrustEstablish]
 * @param {(args: {fingerprint: string, keyLine: string}) => void} [opts.onTrusted]
 * @param {(detail: object) => void} [opts.onProgress]
 * @returns {Promise<{ok: boolean, session?: object, status?: string, answer?: string, waitingKind?: string, reason?: string, transport?: object}>}
 */
async function connectRemoteSession({
  target,
  taskId,
  runId,
  trustedFingerprint,
  signal,
  createTransport,
  onTrustEstablish = null,
  onTrusted = () => {},
  onProgress = () => {},
}) {
  if (!target || !target.host) {
    return { ok: false, status: "failed", reason: "invalid_target" };
  }
  const transport =
    typeof createTransport === "function"
      ? createTransport({ target })
      : createSshTransport({ target });

  const session = createRemoteSession({
    target,
    transport,
    taskId,
    runId,
    trustedFingerprint,
    signal,
    onProgress,
  });

  let trust = await session.connect();
  if (signal?.aborted) return { ok: false, status: "cancelled", answer: "Task cancelled." };

  if (trust.ok) return { ok: true, session, transport };

  if (trust.state === HOST_KEY_CHANGED) {
    // Never auto-accept. This is the MITM guard.
    return {
      ok: false,
      status: "waiting_for_user",
      waitingKind: "host_key_changed",
      fingerprint: trust.fingerprint,
      reason: HOST_KEY_CHANGED,
      answer:
        `The SSH host key for ${target.name || target.host} has CHANGED since you last trusted it. ` +
        "This can mean the server was rebuilt — or that the connection is being intercepted. " +
        "I've stopped and will not connect until you verify the host and re-establish trust.",
    };
  }

  if (trust.state === HOST_UNTRUSTED) {
    // First use: require explicit trust establishment.
    let trusted = false;
    if (typeof onTrustEstablish === "function") {
      trusted = await onTrustEstablish({ fingerprint: trust.fingerprint, target }).catch(() => false);
    }
    if (signal?.aborted) return { ok: false, status: "cancelled", answer: "Task cancelled." };
    if (!trusted) {
      return {
        ok: false,
        status: "waiting_for_approval",
        waitingKind: "host_untrusted",
        approvalKind: "remote-host-trust",
        fingerprint: trust.fingerprint,
        answer:
          `I need you to verify and trust the SSH host key for ${target.name || target.host} ` +
          `(fingerprint ${trust.fingerprint}) before I can connect.`,
      };
    }
    // Persist trust (fingerprint + known_hosts line) and reconnect once.
    try {
      transport.persistKnownHostLine?.(trust.keyLine);
    } catch {
      /* the reconnect will re-verify regardless */
    }
    try {
      onTrusted({ fingerprint: trust.fingerprint, keyLine: trust.keyLine });
    } catch {
      /* persistence is best-effort; verify below is the real gate */
    }
    // Reconnect with the now-trusted fingerprint so the same verification path
    // confirms the key we just trusted (no blind acceptance).
    const reconnected = createRemoteSession({
      target,
      transport,
      taskId,
      runId,
      trustedFingerprint: trust.fingerprint,
      signal,
      onProgress,
    });
    const confirm = await reconnected.connect();
    if (confirm.ok) return { ok: true, session: reconnected, transport };
    return { ok: false, status: "failed", reason: confirm.state || confirm.error || "trust_failed" };
  }

  return { ok: false, status: "failed", reason: trust.error || "connect_failed" };
}

module.exports = { connectRemoteSession };
