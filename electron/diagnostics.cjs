/**
 * What we can find out about a run after it has finished.
 *
 * Two jobs, sharing one directory.
 *
 * RECORDING A FALLBACK
 * --------------------
 * The browser agent has two implementations: the modular runtime (plan → decide
 * → act → observe → verify) and the legacy monolithic loop it replaced. When
 * the server does not answer the modular runtime's model endpoint, the client
 * raises AgentModelUnavailableError and the caller quietly drops to the legacy
 * loop. That fallback is correct — a task the user asked for should still run —
 * but it was completely silent: no log, no event, no difference the user or we
 * could see. A version-skewed deploy, where the desktop app ships before the
 * server route exists, would therefore look exactly like a successful rollout
 * while not one user was running the new code. `recordRuntimeFallback` is what
 * makes that visible.
 *
 * BUILDING A REPORT
 * -----------------
 * Every modular run already writes a full JSONL trace next to these records.
 * Those traces are detailed on purpose and are NOT safe to hand out: they carry
 * the user's own goal text, page content the agent read, the plan it wrote, the
 * skills it selected and the models it called. That is private to the user and
 * revealing about how the product works.
 *
 * So `buildDiagnosticsReport` never copies a trace. It reads them and emits
 * counts: how many rounds, how many recoveries, how many verifications passed,
 * which runtime served each task, how it ended. Enough to answer "did the new
 * architecture run, and where did it stop" in a bug report; not enough to
 * reconstruct a prompt, a plan, or a page. Anything not on the allow-list below
 * is dropped rather than summarised — a redactor that has to recognise secrets
 * fails the first time something new is logged, whereas one that only passes
 * through known-safe fields fails closed.
 */

const fs = require("node:fs");
const path = require("node:path");

const LOG_DIR_NAME = "browser-agent-logs";
const FALLBACK_FILE = "runtime-fallbacks.jsonl";
const ROUTE_FILE = "route-decisions.jsonl";

/** Traces to summarise. Recent enough to cover the session being reported on. */
const MAX_TASKS_IN_REPORT = 20;

/** A runaway trace should not stall the report. */
const MAX_TRACE_BYTES = 4 * 1024 * 1024;

/**
 * Fallbacks seen since this app started. The file is the durable record; this
 * is what lets a report say "and it is happening right now" without a re-read.
 */
let fallbacksThisSession = 0;

function logDir(userDataPath) {
  return path.join(String(userDataPath || ""), LOG_DIR_NAME);
}

/**
 * Note that a task ran on the legacy loop because the modular runtime could not
 * reach its model endpoint.
 *
 * Deliberately best-effort and synchronous-safe: this runs on a path that is
 * already degrading, and a diagnostics failure must never be the reason a
 * user's task does not run.
 *
 * @param {object}  opts
 * @param {string}  opts.userDataPath
 * @param {string}  opts.surface    which caller fell back ("browse", "mail")
 * @param {string}  opts.reason     the error's message
 * @param {string} [opts.appVersion]
 */
/**
 * Where an ambiguous ask was routed, and why.
 *
 * The keyword heuristics send anything they cannot place to the chat model,
 * which has no browser — so a misroute looks like the assistant saying it is
 * looking into something and then nothing happening. Recording the model's
 * routing calls is what makes that answerable after the fact rather than
 * reproducible only by accident.
 */
function recordRouteDecision({ userDataPath, ask, route, reason } = {}) {
  if (!userDataPath) return;
  try {
    const dir = logDir(userDataPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, ROUTE_FILE),
      `${JSON.stringify({
        at: new Date().toISOString(),
        ask: String(ask || "").slice(0, 160),
        route: String(route || "").slice(0, 12),
        reason: String(reason || "").slice(0, 160),
      })}\n`,
    );
  } catch {
    /* diagnostics must never break a run */
  }
}

function recordRuntimeFallback({ userDataPath, surface, reason, appVersion = "" } = {}) {
  fallbacksThisSession += 1;
  // Visible in `npm run dev:overlay`, where the console is actually read.
  console.warn(
    `[browser-agent] modular runtime unavailable (${surface}) — running the legacy loop instead: ${String(
      reason || "",
    ).slice(0, 200)}`,
  );
  if (!userDataPath) return;
  try {
    const dir = logDir(userDataPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, FALLBACK_FILE),
      `${JSON.stringify({
        at: new Date().toISOString(),
        surface: String(surface || "unknown").slice(0, 24),
        // The message can carry an upstream response body, so keep only the
        // shape of it: the status code is the whole diagnostic value here.
        status: (String(reason || "").match(/\((\d{3})\)/) || [])[1] || "",
        appVersion: String(appVersion || "").slice(0, 24),
      })}\n`,
    );
  } catch {
    /* diagnostics must never break a run */
  }
}

function fallbackCountThisSession() {
  return fallbacksThisSession;
}

/** Every field a summarised trace may contribute. Nothing else is read. */
function summariseTrace(text) {
  const summary = {
    rounds: 0,
    decisions: {},
    verifiedOk: 0,
    verifiedFail: 0,
    recoveries: 0,
    replans: 0,
    groundingAssists: 0,
    planFailed: false,
    status: "",
    startedAt: "",
    endedAt: "",
    events: 0,
  };
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    summary.events += 1;
    const event = String(entry.event || "");
    const at = String(entry.at || "");
    if (at && !summary.startedAt) summary.startedAt = at;
    if (at) summary.endedAt = at;
    if (event === "decision") {
      // The kind — act / finish / ask_user / replan — says how the run went.
      // The action and the model's reasoning for it do not leave the machine.
      const kind = String(entry.kind || "unknown").slice(0, 16);
      summary.decisions[kind] = (summary.decisions[kind] || 0) + 1;
      if (Number.isFinite(Number(entry.round))) {
        summary.rounds = Math.max(summary.rounds, Number(entry.round));
      }
    } else if (event === "verified") {
      if (entry.success) summary.verifiedOk += 1;
      else summary.verifiedFail += 1;
    } else if (event === "recovery") summary.recoveries += 1;
    else if (event === "replanning") summary.replans += 1;
    else if (event === "grounded" || event === "assist_degraded") summary.groundingAssists += 1;
    else if (event === "plan_failed") summary.planFailed = true;
    else if (event === "task_finished") summary.status = String(entry.status || "").slice(0, 24);
  }
  return summary;
}

function durationSeconds(startedAt, endedAt) {
  const a = Date.parse(startedAt || "");
  const b = Date.parse(endedAt || "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 100) / 10;
}

function readFallbackRecords(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, FALLBACK_FILE), "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A shareable report. Plain text, no trace content, safe to paste into a bug
 * report or attach to an email.
 *
 * @param {object} opts
 * @param {string} opts.userDataPath
 * @param {object} [opts.env] app/runtime versions to stamp on the report
 * @returns {string}
 */
function buildDiagnosticsReport({ userDataPath, env = {} } = {}) {
  const dir = logDir(userDataPath);
  const lines = [];
  const out = (s = "") => lines.push(s);

  out("LYKN diagnostics");
  out("================");
  out(`Generated:    ${new Date().toISOString()}`);
  out(`App version:  ${env.appVersion || "unknown"}`);
  out(`Platform:     ${env.platform || process.platform} ${env.arch || process.arch}`);
  out(`Electron:     ${env.electron || process.versions?.electron || "n/a"}`);
  out(`Packaged:     ${env.packaged === undefined ? "unknown" : !!env.packaged}`);
  out("");
  out("This report contains counts only. Task text, page content, plans and");
  out("model details stay on this machine and are not included.");
  out("");

  const fallbacks = readFallbackRecords(dir);
  out("Browser agent runtime");
  out("---------------------");
  out(`Legacy fallbacks, all time:     ${fallbacks.length}`);
  out(`Legacy fallbacks, this session: ${fallbacksThisSession}`);
  if (fallbacks.length) {
    const recent = fallbacks.slice(-5);
    out("Most recent:");
    for (const record of recent) {
      out(
        `  ${record.at || "?"}  surface=${record.surface || "?"}  ` +
          `status=${record.status || "?"}  app=${record.appVersion || "?"}`,
      );
    }
    out("");
    out("  A fallback means the modular runtime could not reach the server's");
    out("  agent-model endpoint and the task ran on the legacy loop instead.");
    out("  A status of 404 usually means the app is newer than the server.");
  }
  out("");

  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith("task-") && name.endsWith(".jsonl"))
      .map((name) => {
        const full = path.join(dir, name);
        let mtime = 0;
        let size = 0;
        try {
          const stat = fs.statSync(full);
          mtime = stat.mtimeMs;
          size = stat.size;
        } catch {
          /* skip */
        }
        return { name, full, mtime, size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    files = [];
  }

  out("Recent tasks (modular runtime)");
  out("------------------------------");
  out(`Traces on disk: ${files.length}`);
  if (!files.length) {
    out("");
    out("  No traces. Either no browser task has run, or every task fell back");
    out("  to the legacy loop, which does not write one.");
  }
  out("");

  for (const file of files.slice(0, MAX_TASKS_IN_REPORT)) {
    if (file.size > MAX_TRACE_BYTES) {
      out(`${file.name}  (skipped: ${Math.round(file.size / 1024)}KB)`);
      continue;
    }
    let summary;
    try {
      summary = summariseTrace(fs.readFileSync(file.full, "utf8"));
    } catch {
      out(`${file.name}  (unreadable)`);
      continue;
    }
    const seconds = durationSeconds(summary.startedAt, summary.endedAt);
    const decisions = Object.entries(summary.decisions)
      .map(([kind, n]) => `${kind}=${n}`)
      .join(" ");
    out(file.name);
    out(
      `  status=${summary.status || "unfinished"}  rounds=${summary.rounds}  ` +
        `duration=${seconds === null ? "?" : `${seconds}s`}  events=${summary.events}`,
    );
    out(
      `  decisions: ${decisions || "none"}  verified ok/fail=${summary.verifiedOk}/${summary.verifiedFail}`,
    );
    out(
      `  recoveries=${summary.recoveries}  replans=${summary.replans}  ` +
        `grounding=${summary.groundingAssists}  planFailed=${summary.planFailed}`,
    );
    out("");
  }

  return lines.join("\n");
}

module.exports = {
  recordRuntimeFallback,
  recordRouteDecision,
  fallbackCountThisSession,
  buildDiagnosticsReport,
  summariseTrace,
  LOG_DIR_NAME,
  FALLBACK_FILE,
};
