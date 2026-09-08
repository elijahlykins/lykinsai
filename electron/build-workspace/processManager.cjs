/**
 * Managed long-running processes for the Build agent.
 *
 * `local_run_command` is one-shot: it blocks until exit and hard-kills at its
 * timeout, which makes dev servers, watchers, and long installs impossible.
 * This module owns the other shape: spawn a command detached from the tool
 * call, keep a ring buffer of its output, detect the port it starts serving
 * on, and let the agent poll logs / stop / restart it on later tool calls.
 *
 * One authority: every background process the Build agent starts lives here.
 * Nothing else in the app should spawn agent-owned daemons.
 *
 * Plain Node (no Electron imports) so localSystem and tests can load it
 * anywhere. Best-effort cleanup on process exit kills every child group.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const MAX_RUNNING = 8;
const MAX_TRACKED = 24;
const LOG_BUFFER_BYTES = 256 * 1024;
const DEFAULT_START_WAIT_MS = 3_000;
const MAX_START_WAIT_MS = 20_000;
const DEFAULT_LOG_LINES = 60;
const MAX_LOG_LINES = 400;
const STOP_GRACE_MS = 3_000;

// url-ish first (http://localhost:5173), then bare host:port, then "port 3000".
const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::(\d{2,5}))/i,
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/i,
  /\bport\s*[:=]?\s*(\d{2,5})\b/i,
];

let nextId = 1;
const processes = new Map(); // id → entry

function detectPort(text) {
  for (const re of PORT_PATTERNS) {
    const m = re.exec(text);
    if (m) {
      const port = Number(m[1]);
      if (port > 0 && port < 65536) return port;
    }
  }
  return null;
}

function appendLog(entry, chunk) {
  entry.log += chunk.toString("utf8");
  if (entry.log.length > LOG_BUFFER_BYTES) {
    // Trim from the front, keeping whole lines where possible.
    const cut = entry.log.length - LOG_BUFFER_BYTES;
    const nl = entry.log.indexOf("\n", cut);
    entry.log = entry.log.slice(nl === -1 ? cut : nl + 1);
    entry.logTrimmed = true;
  }
  if (entry.logFile) {
    try {
      fs.appendFileSync(entry.logFile, chunk);
    } catch {
      entry.logFile = null; // disk issue — keep the in-memory buffer working
    }
  }
  if (entry.port == null) {
    const port = detectPort(entry.log);
    if (port != null) entry.port = port;
  }
}

function logTail(entry, lines) {
  const n = Math.min(Math.max(Number(lines) || DEFAULT_LOG_LINES, 1), MAX_LOG_LINES);
  const all = entry.log.split("\n");
  return all.slice(Math.max(0, all.length - n)).join("\n");
}

function killGroup(entry, signal) {
  if (!entry.child || entry.exitCode !== null) return;
  if (entry.child.pid && process.platform !== "win32") {
    try {
      process.kill(-entry.child.pid, signal);
      return;
    } catch {
      /* group gone — fall through to the direct handle */
    }
  }
  try {
    entry.child.kill(signal);
  } catch {
    /* already dead */
  }
}

function snapshot(entry, { logLines = DEFAULT_LOG_LINES } = {}) {
  const running = entry.exitCode === null && !entry.exitSignal;
  return {
    processId: entry.id,
    name: entry.name,
    command: entry.command,
    cwd: entry.cwd,
    pid: entry.child?.pid ?? null,
    running,
    startedAt: entry.startedAt,
    ...(running ? {} : { exitCode: entry.exitCode, exitSignal: entry.exitSignal || undefined }),
    ...(entry.port != null
      ? { port: entry.port, url: `http://localhost:${entry.port}` }
      : {}),
    ...(entry.logFile ? { logFile: entry.logFile } : {}),
    logTail: logTail(entry, logLines),
    ...(entry.logTrimmed ? { logTrimmed: true } : {}),
    ...(entry.spawnError ? { spawnError: entry.spawnError } : {}),
  };
}

function runningCount() {
  let n = 0;
  for (const entry of processes.values()) {
    if (entry.exitCode === null && !entry.exitSignal && !entry.spawnError) n += 1;
  }
  return n;
}

/** Drop the oldest exited entries once the table outgrows MAX_TRACKED. */
function reap() {
  if (processes.size <= MAX_TRACKED) return;
  const exited = [...processes.values()]
    .filter((e) => e.exitCode !== null || e.exitSignal || e.spawnError)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const entry of exited) {
    if (processes.size <= MAX_TRACKED) break;
    processes.delete(entry.id);
  }
}

/**
 * Start a managed background process.
 *
 * Resolves after `waitMs` (or on early exit) with a snapshot that includes
 * the first output — enough for the agent to see "VITE ready … localhost:5173"
 * or the immediate crash, without blocking on a process that never exits.
 *
 * @param {{ command: string, cwd: string, name?: string, waitMs?: number,
 *           env?: object, logFile?: string }} args
 */
async function startProcess(args = {}) {
  const command = String(args.command || "").trim();
  const cwd = String(args.cwd || "").trim();
  if (!command) return { ok: false, error: "command is required" };
  if (!cwd) return { ok: false, error: "cwd is required" };

  // One instance per (cwd, command): starting the same server in the same
  // project again IS a restart. Without this, "run the dev server" on a
  // project whose server is already up piled a second instance onto a busy
  // port — and the stale one sat there with no way for the user to shut it
  // off short of quitting LYKN.
  let replacedProcessId = null;
  for (const entry of processes.values()) {
    if (
      entry.exitCode === null && !entry.exitSignal && !entry.spawnError &&
      entry.cwd === cwd && entry.command === command
    ) {
      await stopProcess({ processId: entry.id });
      replacedProcessId = entry.id;
      break;
    }
  }

  if (runningCount() >= MAX_RUNNING) {
    return {
      ok: false,
      error:
        `Too many managed processes are running (${MAX_RUNNING} max). ` +
        "Stop one with local_stop_process first (local_process_status lists them).",
    };
  }

  const id = `proc_${nextId++}`;
  const entry = {
    id,
    name: String(args.name || "").trim().slice(0, 80) || command.slice(0, 60),
    command,
    cwd,
    child: null,
    log: "",
    logTrimmed: false,
    logFile: typeof args.logFile === "string" && args.logFile ? args.logFile : null,
    port: null,
    startedAt: Date.now(),
    exitCode: null,
    exitSignal: null,
    spawnError: null,
  };

  if (entry.logFile) {
    try {
      fs.mkdirSync(path.dirname(entry.logFile), { recursive: true });
      fs.writeFileSync(entry.logFile, `# ${command}\n# cwd: ${cwd}\n`);
    } catch {
      entry.logFile = null;
    }
  }

  let child;
  try {
    child = spawn("/bin/zsh", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        ...(args.env && typeof args.env === "object" ? args.env : {}),
        LYKN_LOCAL_MODE: "1",
        PATH: `${process.env.PATH || ""}:/opt/homebrew/bin:/usr/local/bin`,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
  } catch (e) {
    entry.spawnError = e?.message || "spawn failed";
    entry.exitCode = -1;
    processes.set(id, entry);
    return Promise.resolve({ ok: false, error: entry.spawnError, ...snapshot(entry) });
  }

  entry.child = child;
  processes.set(id, entry);
  reap();

  child.stdout.on("data", (chunk) => appendLog(entry, chunk));
  child.stderr.on("data", (chunk) => appendLog(entry, chunk));
  child.on("error", (err) => {
    entry.spawnError = err?.message || "process error";
    if (entry.exitCode === null) entry.exitCode = -1;
  });
  child.on("close", (code, signal) => {
    entry.exitCode = code === null ? (entry.exitCode ?? -1) : code;
    entry.exitSignal = signal || null;
  });

  const waitMs = Math.min(
    Math.max(Number(args.waitMs) || DEFAULT_START_WAIT_MS, 250),
    MAX_START_WAIT_MS,
  );

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const snap = snapshot(entry);
      const failedFast = !snap.running && snap.exitCode !== 0;
      resolve({
        ok: !failedFast,
        ...(failedFast
          ? {
              error:
                `The process exited almost immediately (exit ${snap.exitCode}). ` +
                "Check logTail for the reason.",
            }
          : {}),
        ...(replacedProcessId ? { replacedProcessId } : {}),
        ...snap,
      });
    };
    const timer = setTimeout(finish, waitMs);
    // If it dies before the wait window ends, report right away.
    child.on("close", () => {
      clearTimeout(timer);
      // One tick so the final stdout/stderr flushes land in the buffer.
      setImmediate(finish);
    });
  });
}

/**
 * Status + recent logs for one process (by id) or all tracked processes.
 */
function processStatus(args = {}) {
  const id = String(args.processId || "").trim();
  const logLines = args.logLines;
  if (id) {
    const entry = processes.get(id);
    if (!entry) {
      return {
        ok: false,
        error: `No managed process ${id}. Call local_process_status without processId to list them.`,
      };
    }
    return { ok: true, ...snapshot(entry, { logLines }) };
  }
  return {
    ok: true,
    processes: [...processes.values()].map((e) => {
      const snap = snapshot(e, { logLines: 5 });
      return snap;
    }),
  };
}

/** Stop one managed process (SIGTERM, then SIGKILL after a grace period). */
function stopProcess(args = {}) {
  const id = String(args.processId || "").trim();
  if (!id) return Promise.resolve({ ok: false, error: "processId is required" });
  const entry = processes.get(id);
  if (!entry) {
    return Promise.resolve({
      ok: false,
      error: `No managed process ${id}. Call local_process_status to list them.`,
    });
  }
  if (entry.exitCode !== null || entry.exitSignal) {
    return Promise.resolve({ ok: true, ...snapshot(entry), note: "Already exited." });
  }
  return new Promise((resolve) => {
    const done = () => resolve({ ok: true, ...snapshot(entry), stopped: true });
    const killTimer = setTimeout(() => killGroup(entry, "SIGKILL"), STOP_GRACE_MS);
    // Resolve when close lands (or shortly after SIGKILL as a backstop).
    const backstop = setTimeout(() => {
      entry.exitCode = entry.exitCode ?? -1;
      done();
    }, STOP_GRACE_MS + 2_000);
    entry.child.on("close", () => {
      clearTimeout(killTimer);
      clearTimeout(backstop);
      done();
    });
    killGroup(entry, "SIGTERM");
  });
}

/** Kill every managed process. Called on app shutdown (and test teardown). */
function stopAll() {
  for (const entry of processes.values()) {
    if (entry.exitCode === null && !entry.exitSignal) killGroup(entry, "SIGKILL");
  }
}

/** Test helper — forget all tracked processes (kills running ones first). */
function resetForTests() {
  stopAll();
  processes.clear();
  nextId = 1;
}

// Last-resort cleanup: never leave orphaned dev servers when LYKN quits.
process.on("exit", stopAll);

module.exports = {
  startProcess,
  processStatus,
  stopProcess,
  stopAll,
  resetForTests,
  detectPort,
  MAX_RUNNING,
};
