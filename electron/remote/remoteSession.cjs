"use strict";

/**
 * RemoteSession — the transient authority for one remote execution.
 *
 * It owns everything about a single Task's presence on a host EXCEPT the
 * credential, which never enters its model-visible state:
 *   - task/run/target identity
 *   - connection + trust state
 *   - current working directory
 *   - cancellation (through the Task's AbortSignal)
 *   - a bounded command-history summary
 *   - output bounding (head/tail with truncation markers)
 *
 * A session is transient per execution. No connection pooling is built here:
 * each `exec` is a discrete `ssh` invocation, which is the simplest correct
 * behavior and matches how the local shell already runs. Pooling is deferred
 * until a real need appears.
 *
 * Structured file operations (read/list/search/write) are expressed as bounded
 * shell commands through the same transport, so there is one execution path and
 * one place output is bounded — not a second SFTP product.
 */

const {
  HOST_KEY_CHANGED,
  HOST_UNTRUSTED,
  AUTH_REQUIRED,
} = require("./sshTransport.cjs");

const DEFAULT_MAX_LINES = 400;
const DEFAULT_MAX_BYTES = 24 * 1024;

/**
 * Bound a large output for model context: keep the head and tail, drop the
 * middle, and mark the cut. Large output should become a retrievable artifact,
 * not repeated prompt content.
 */
function boundOutput(text, { maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let out = String(text || "");
  let truncated = false;
  const totalBytes = Buffer.byteLength(out, "utf8");
  const lines = out.split("\n");
  const totalLines = lines.length;

  if (lines.length > maxLines) {
    const head = lines.slice(0, Math.ceil(maxLines * 0.7));
    const tail = lines.slice(-Math.floor(maxLines * 0.3));
    out = `${head.join("\n")}\n…[${totalLines - head.length - tail.length} lines omitted]…\n${tail.join("\n")}`;
    truncated = true;
  }
  if (Buffer.byteLength(out, "utf8") > maxBytes) {
    const buf = Buffer.from(out, "utf8");
    const headBuf = buf.subarray(0, Math.floor(maxBytes * 0.7));
    const tailBuf = buf.subarray(buf.length - Math.floor(maxBytes * 0.3));
    out = `${headBuf.toString("utf8")}\n…[output truncated]…\n${tailBuf.toString("utf8")}`;
    truncated = true;
  }
  return { text: out, truncated, totalBytes, totalLines };
}

/** POSIX single-quote for building safe remote command strings. */
function q(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * @param {object} opts
 * @param {object} opts.target       resolved RemoteTarget (host-side, with host)
 * @param {object} opts.transport    createSshTransport(...) instance
 * @param {string} opts.taskId
 * @param {string} opts.runId
 * @param {string} [opts.trustedFingerprint]
 * @param {AbortSignal} [opts.signal]
 * @param {(detail: object) => void} [opts.onProgress]
 */
function createRemoteSession({
  target,
  transport,
  taskId,
  runId,
  trustedFingerprint,
  signal,
  onProgress = () => {},
}) {
  if (!target || !transport) throw new TypeError("createRemoteSession requires target and transport");

  const state = {
    taskId: String(taskId || ""),
    runId: String(runId || ""),
    remoteTargetId: String(target.id || ""),
    environment: String(target.environment || "unknown"),
    connected: false,
    trust: "unknown",
    cwd: String(target.workingDirectory || "").trim() || "",
    commandCount: 0,
  };
  const history = [];

  const aborted = () => signal?.aborted === true;

  function recordHistory(entry) {
    history.push(entry);
    if (history.length > 40) history.shift();
  }

  /**
   * Establish trust and mark the session connected. Returns a structured trust
   * result the executor acts on — this function NEVER auto-accepts a changed or
   * unknown host key; it reports the state and lets the executor pause the Task.
   *
   * @returns {Promise<{ok, state?, fingerprint?, keyLine?, error?}>}
   */
  async function connect() {
    if (aborted()) return { ok: false, error: "aborted" };
    onProgress({ event: "remote.connecting", taskId: state.taskId, targetId: state.remoteTargetId });
    const trust = await transport.verifyHostTrust({ trustedFingerprint, signal });
    if (aborted()) return { ok: false, error: "aborted" };
    if (!trust.ok) {
      state.trust = trust.state || "error";
      if (trust.state === HOST_KEY_CHANGED) {
        onProgress({ event: "remote.host_key_changed", taskId: state.taskId, targetId: state.remoteTargetId });
      } else if (trust.state === HOST_UNTRUSTED) {
        onProgress({ event: "remote.host_untrusted", taskId: state.taskId, targetId: state.remoteTargetId });
      }
      return trust;
    }
    state.connected = true;
    state.trust = "trusted";
    onProgress({ event: "remote.connected", taskId: state.taskId, targetId: state.remoteTargetId });
    return trust;
  }

  /**
   * Run a remote command. Output is bounded before it returns. The caller
   * (executor) is responsible for capability/consequence gating BEFORE calling
   * this — the session executes, it does not authorize.
   */
  async function exec(command, { cwd, timeoutMs, bound = true } = {}) {
    if (aborted()) return { ok: false, aborted: true, stdout: "", stderr: "", output: "" };
    const useCwd = cwd !== undefined ? cwd : state.cwd || undefined;
    state.commandCount += 1;
    onProgress({
      event: "remote.command_started",
      taskId: state.taskId,
      command: String(command).slice(0, 200),
    });
    const raw = await transport.exec(command, { signal, cwd: useCwd, timeoutMs });
    const combined = raw.stdout + (raw.stderr ? (raw.stdout ? "\n" : "") + raw.stderr : "");
    const boundedOut = bound ? boundOutput(combined) : { text: combined, truncated: raw.truncated };
    const result = {
      ok: raw.ok,
      code: raw.code,
      stdout: raw.stdout,
      stderr: raw.stderr,
      output: boundedOut.text,
      truncated: boundedOut.truncated || raw.truncated === true,
      aborted: raw.aborted === true,
      timedOut: raw.timedOut === true,
      authRequired: raw.authRequired === true,
      transportError: raw.transportError || "",
    };
    recordHistory({
      command: String(command).slice(0, 200),
      ok: result.ok,
      code: result.code,
      bytes: boundedOut.totalBytes || 0,
    });
    onProgress({
      event: "remote.command_completed",
      taskId: state.taskId,
      command: String(command).slice(0, 200),
      ok: result.ok,
    });
    return result;
  }

  // ── Structured file operations (bounded shell under the hood) ───────────────

  async function readFile(path, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
    // head -c bounds the transfer at the source so a huge file never crosses
    // the wire in full.
    const res = await exec(`head -c ${Math.max(1, Math.floor(maxBytes * 1.2))} ${q(path)}`, { bound: true });
    return res;
  }

  async function listDir(path) {
    return exec(`ls -la ${q(path)}`, { bound: true });
  }

  async function search(path, pattern, { fixed = true } = {}) {
    const flags = fixed ? "-rnF" : "-rn";
    return exec(`grep ${flags} -- ${q(pattern)} ${q(path)}`, { bound: true });
  }

  /**
   * Write content to a remote file. Content is delivered via base64 to avoid any
   * quoting hazard in the command string; the remote decodes it deterministically.
   */
  async function writeFile(path, content) {
    const b64 = Buffer.from(String(content ?? ""), "utf8").toString("base64");
    // `printf %s` avoids echo's backslash interpretation; base64 -d is standard
    // on Linux and macOS remotes.
    return exec(`printf %s ${q(b64)} | base64 -d > ${q(path)}`, { bound: true });
  }

  function setCwd(path) {
    state.cwd = String(path || "").trim();
    return state.cwd;
  }

  function summary() {
    return {
      taskId: state.taskId,
      runId: state.runId,
      remoteTargetId: state.remoteTargetId,
      environment: state.environment,
      connected: state.connected,
      trust: state.trust,
      cwd: state.cwd,
      commandCount: state.commandCount,
      recentCommands: history.slice(-8).map((h) => ({ command: h.command, ok: h.ok })),
    };
  }

  function close() {
    state.connected = false;
  }

  return {
    state,
    connect,
    exec,
    readFile,
    listDir,
    search,
    writeFile,
    setCwd,
    summary,
    close,
  };
}

module.exports = {
  createRemoteSession,
  boundOutput,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_BYTES,
  HOST_KEY_CHANGED,
  HOST_UNTRUSTED,
  AUTH_REQUIRED,
};
