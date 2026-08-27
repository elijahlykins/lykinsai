"use strict";

/**
 * SSH transport — the internal mechanism RemoteExecutor/RemoteSession use to
 * reach a host. The model-facing authority is RemoteExecutor; this module is a
 * transport detail it owns.
 *
 * TRANSPORT DECISION (documented per the phase brief): LYKN drives the system
 * `ssh` / `ssh-keyscan` binaries through child_process rather than bundling a
 * Node SSH library (ssh2). The repository has no ssh2/keytar today, and the
 * system client is the strongest fit for this phase's hard constraints:
 *
 *   - Credentials stay in the OS. The `ssh` client resolves keys from the
 *     running SSH agent, the OS keychain, and `~/.ssh/config`; LYKN passes a
 *     target address and a credential REFERENCE, never key material. ssh2 would
 *     force us to read private keys into our own process — the exact thing the
 *     credential rule forbids.
 *   - Host-key verification is explicit and in our hands: we keep our own
 *     known_hosts anchor and compare fingerprints ourselves (see below),
 *     rather than trusting an interactive "yes" the model could fabricate.
 *   - Cancellation is a process kill — identical to localSystem's shell, which
 *     already ships and is trusted.
 *   - Packaging: no native addon to notarize across macOS/Windows.
 *   - `BatchMode=yes` guarantees ssh never blocks on an interactive password
 *     prompt; if auth needs a human (passphrase / 2FA), ssh fails fast and the
 *     executor surfaces waiting_for_user instead of hanging.
 *
 * A subprocess is used internally, but nothing here is "LocalExecutor shelling
 * out to ssh": the boundary the Task and model see is RemoteExecutor →
 * RemoteSession → this transport, with capability and consequence policy
 * enforced above it.
 */

const { spawn: realSpawn } = require("node:child_process");

/** Hard ceiling on captured bytes per command; the session applies head/tail. */
const OUTPUT_CAP_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120 * 1000;
const SCAN_TIMEOUT_MS = 15 * 1000;

const HOST_KEY_CHANGED = "HOST_KEY_CHANGED";
const HOST_UNTRUSTED = "HOST_UNTRUSTED";
const AUTH_REQUIRED = "AUTH_REQUIRED";

/**
 * Translate a credential REFERENCE into ssh identity argv. Never returns secret
 * material — only an identity FILE path (ssh reads the key itself) or nothing.
 */
function authRefToArgs(authRef) {
  const ref = authRef && typeof authRef === "object" ? authRef : { kind: "default" };
  const args = [];
  if (ref.kind === "keyFile" && ref.path && !/[\n\r]/.test(ref.path)) {
    args.push("-i", ref.path);
    // With an explicit key, do not also try every agent identity.
    args.push("-o", "IdentitiesOnly=yes");
  }
  // agent / default / sshConfigHost: rely on the agent and ~/.ssh/config, which
  // the OS resolves. Nothing to add; publickey is preferred and password is
  // disabled by BatchMode below.
  return args;
}

/**
 * Run a child process to completion with bounded output and cancellation.
 * Injectable `spawn` lets unit tests drive a fake transport with no network.
 */
function runProcess(spawnImpl, bin, args, { signal, input, timeoutMs, capBytes = OUTPUT_CAP_BYTES } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: "", stderr: String(e?.message || e), error: "spawn_failed" });
      return;
    }

    let outBytes = 0;
    let errBytes = 0;
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill("SIGKILL");
            } catch {
              /* already gone */
            }
          }, timeoutMs)
        : null;
    timer?.unref?.();

    child.stdout?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (outBytes < capBytes) {
        const room = capBytes - outBytes;
        stdout += buf.subarray(0, room).toString("utf8");
        if (buf.length > room) truncated = true;
      } else {
        truncated = true;
      }
      outBytes += buf.length;
    });
    child.stderr?.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (errBytes < capBytes) {
        const room = capBytes - errBytes;
        stderr += buf.subarray(0, room).toString("utf8");
      }
      errBytes += buf.length;
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({
        ok: code === 0 && !aborted && !timedOut,
        code,
        stdout,
        stderr,
        truncated,
        aborted,
        timedOut,
        bytesOut: outBytes,
      });
    };

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ ok: false, code: null, stdout, stderr: stderr || String(e?.message || e), error: "process_error", aborted });
    });
    child.on("close", (code) => finish(code));

    if (input != null && child.stdin) {
      try {
        child.stdin.end(String(input));
      } catch {
        /* remote side will error out; captured on close */
      }
    }
  });
}

/**
 * Create a transport bound to one resolved target. `spawn` is injectable for
 * tests. `knownHostsFile` is LYKN's own anchor (userData) — never the user's
 * ~/.ssh/known_hosts, so LYKN's trust decisions cannot silently rewrite the
 * user's global SSH trust.
 */
function createSshTransport({
  target,
  spawn = realSpawn,
  knownHostsFile,
  sshBin = "ssh",
  keyscanBin = "ssh-keyscan",
  keygenBin = "ssh-keygen",
  connectTimeoutS = 15,
} = {}) {
  if (!target || !target.host) throw new TypeError("sshTransport requires a target with a host");

  const port = Number(target.port) || 22;
  const destination = target.username ? `${target.username}@${target.host}` : target.host;

  function baseSshArgs() {
    const args = [
      "-p", String(port),
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${connectTimeoutS}`,
      "-o", "StrictHostKeyChecking=yes",
      "-o", "PreferredAuthentications=publickey",
      "-o", "NumberOfPasswordPrompts=0",
    ];
    const honorUserConfig = target.authRef?.kind === "sshConfigHost";
    if (!honorUserConfig) {
      args.push("-F", "/dev/null");
      args.push("-o", `HostName=${target.host}`);
    }
    if (knownHostsFile) args.push("-o", `UserKnownHostsFile=${knownHostsFile}`);
    args.push(...authRefToArgs(target.authRef));
    return args;
  }

  /**
   * Fetch the host's current public key and compute its SHA256 fingerprint,
   * WITHOUT connecting or authenticating. This is how first-use trust and
   * change-detection are decided in our code rather than by ssh's prompt.
   *
   * @returns {Promise<{ok, fingerprint?, keyLine?, error?}>}
   */
  async function scanHostFingerprint({ signal } = {}) {
    const scan = await runProcess(spawn, keyscanBin, ["-p", String(port), "-T", "10", target.host], {
      signal,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    // ssh-keyscan writes the host key line(s) to stdout and progress to stderr.
    const keyLines = String(scan.stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    if (!keyLines.length) {
      return { ok: false, error: scan.aborted ? "aborted" : scan.timedOut ? "timeout" : "no_host_key" };
    }
    // Prefer a modern key type when several are offered.
    const preferred =
      keyLines.find((l) => / ssh-ed25519 /.test(` ${l} `)) ||
      keyLines.find((l) => / ecdsa-/.test(` ${l} `)) ||
      keyLines[0];
    // Compute the fingerprint by piping the key line through ssh-keygen -lf -.
    const fp = await runProcess(spawn, keygenBin, ["-lf", "-"], {
      signal,
      input: `${preferred}\n`,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    // ssh-keygen -l output: "<bits> SHA256:<hash> <comment> (<type>)".
    const match = String(fp.stdout || "").match(/\bSHA256:[A-Za-z0-9+/=]+/);
    if (!match) return { ok: false, error: "fingerprint_unavailable" };
    return { ok: true, fingerprint: match[0], keyLine: preferred };
  }

  /**
   * Decide trust before any authenticated connection.
   *
   * - No trusted fingerprint yet  → HOST_UNTRUSTED (first-use establishment).
   * - Scanned fingerprint matches → trusted, proceed.
   * - Scanned fingerprint differs → HOST_KEY_CHANGED. This is NEVER auto-
   *   accepted: the executor pauses the Task for human attention. A model
   *   "yes, trust it" cannot reach this decision.
   *
   * @param {{ trustedFingerprint?: string, signal?: AbortSignal }} opts
   */
  async function verifyHostTrust({ trustedFingerprint, signal } = {}) {
    const scan = await scanHostFingerprint({ signal });
    if (!scan.ok) return { ok: false, error: scan.error || "scan_failed" };
    const trusted = String(trustedFingerprint || "").trim();
    if (!trusted) {
      return {
        ok: false,
        state: HOST_UNTRUSTED,
        fingerprint: scan.fingerprint,
        keyLine: scan.keyLine,
      };
    }
    if (trusted !== scan.fingerprint) {
      return {
        ok: false,
        state: HOST_KEY_CHANGED,
        fingerprint: scan.fingerprint,
        trustedFingerprint: trusted,
      };
    }
    return { ok: true, fingerprint: scan.fingerprint, keyLine: scan.keyLine };
  }

  /** Write a scanned host key line into LYKN's known_hosts anchor. */
  function persistKnownHostLine(keyLine) {
    if (!knownHostsFile || !keyLine) return { ok: false };
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      fs.mkdirSync(path.dirname(knownHostsFile), { recursive: true });
      let existing = "";
      try {
        existing = fs.readFileSync(knownHostsFile, "utf8");
      } catch {
        existing = "";
      }
      if (!existing.split("\n").some((l) => l.trim() === keyLine.trim())) {
        fs.appendFileSync(knownHostsFile, `${keyLine.trim()}\n`, { mode: 0o600 });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * Run one command on the remote host. The command string is passed as a
   * single argv element after `--`, so nothing on the LOCAL side interprets it
   * as a shell — the only shell that sees it is the remote login shell, which
   * is the intended target of the work (and is gated by capability/consequence
   * policy before it ever reaches here).
   *
   * @returns {Promise<{ok, code, stdout, stderr, truncated, aborted, timedOut, authRequired?}>}
   */
  async function exec(command, { signal, cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const remote = cwd ? `cd ${shellQuote(cwd)} && ${command}` : String(command);
    const args = [...baseSshArgs(), destination, "--", remote];
    const result = await runProcess(spawn, sshBin, args, { signal, timeoutMs });
    // Distinguish an auth failure (needs a human) from a remote command error.
    if (!result.ok && result.code === 255 && /permission denied|no more authentication|host key verification failed|could not resolve/i.test(result.stderr || "")) {
      const authRequired = /permission denied|no more authentication/i.test(result.stderr || "");
      return { ...result, authRequired, transportError: AUTH_REQUIRED };
    }
    return result;
  }

  return {
    destination,
    port,
    scanHostFingerprint,
    verifyHostTrust,
    persistKnownHostLine,
    exec,
  };
}

/** Single-quote a value for a POSIX remote shell (for cwd only). */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  createSshTransport,
  runProcess,
  authRefToArgs,
  shellQuote,
  OUTPUT_CAP_BYTES,
  DEFAULT_TIMEOUT_MS,
  HOST_KEY_CHANGED,
  HOST_UNTRUSTED,
  AUTH_REQUIRED,
};
