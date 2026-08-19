/**
 * Electron main for the Online-Mind2Web harness.
 *
 * Deliberately NOT electron/main.cjs, which builds Studio, the tray, the
 * overlay, the auth keeper and the updater across ~11k lines. None of that is
 * wanted here, and much of it would contaminate the measurement.
 *
 * Usage (the supervisor spawns this; you rarely run it by hand):
 *   electron electron/eval/harness-main.cjs --job <job.json>
 *
 * The job file carries {runId, arm, apiBase, outDir, tasks[], options}. The
 * access token arrives in the environment, never on the command line or on
 * disk. One NDJSON line per finished task goes to stdout; the supervisor
 * appends those to results.jsonl, which doubles as resume state. stdout rather
 * than a file because a line already written survives a crash that an
 * unflushed file buffer would lose.
 *
 * SESSION ISOLATION IS THE POINT
 * ------------------------------
 * Every task gets a fresh WebContentsView on an EPHEMERAL partition — no
 * `persist:` prefix — so cookies, localStorage and IndexedDB die with the view.
 * Never `agentBrowserPartition(id)`: that is persist:-backed and shares the
 * user's real signed-in profile, which would both leak live logins into a
 * login-free benchmark and inflate every success rate that touched one.
 */

const { app, BrowserWindow, WebContentsView, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const browserAgent = require("../browser-agent/index.cjs");
const ownedBrowserAct = require("../ownedBrowserAct.cjs");
const { createEvalGuard } = require("./guard.cjs");
const { createDirectFetch } = require("./directModel.cjs");

// Electron's own UA advertises Electron, and some sites serve different DOM for
// it. A stock Chrome string keeps the pages we measure the pages users see.
const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
  + " (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const emit = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}

/**
 * Lock a session down before anything loads into it.
 *
 * Denying rather than ignoring: a permission prompt in a headless run blocks
 * forever, and a download is a file written by a page we do not control.
 */
function hardenSession(sess) {
  sess.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  sess.setPermissionCheckHandler(() => false);
  sess.setUserAgent(CHROME_UA);
  sess.on("will-download", (e) => e.preventDefault());
}

/**
 * What an action is aiming at, in a form that is the same for both arms.
 *
 * refs mode aims with an element reference — the label and the on-screen point
 * both live in the snapshot. holo mode aims with a description the grounder
 * wrote onto the action, plus the point it grounded to. Reading both here is
 * what lets the emitted trajectory speak one vocabulary: without it refs reads
 * "click e12" and holo "click_coord x=… y=…", and the judge can identify the
 * arm from the text alone.
 */
function resolveTarget(action, snapshot) {
  if (!action) return { label: null, x: null, y: null };

  const described = String(action.label || "").trim();
  const hasPoint = Number.isFinite(action.x) && Number.isFinite(action.y);
  if (described || hasPoint) {
    return {
      label: described ? described.slice(0, 120) : null,
      x: hasPoint ? Math.round(action.x) : null,
      y: hasPoint ? Math.round(action.y) : null,
    };
  }

  const ref = String(action.target || "").trim();
  if (!ref) return { label: null, x: null, y: null };
  try {
    const el = snapshot?.byRef?.get?.(ref);
    const label = String(el?.label || "").trim();
    const cx = Number(el?.raw?.clientX);
    const cy = Number(el?.raw?.clientY);
    return {
      label: label ? label.slice(0, 120) : null,
      x: Number.isFinite(cx) ? Math.round(cx) : null,
      y: Number.isFinite(cy) ? Math.round(cy) : null,
    };
  } catch {
    return { label: null, x: null, y: null };
  }
}

/** Controller methods that change the page, and so have a SUCCESS/FAILED outcome. */
const ACTION_METHODS = [
  "navigate", "click", "clickCoord", "type", "typeAtCoord", "drag",
  "replaceText", "select", "scroll", "pressKey", "goBack", "goForward",
];

/**
 * Attach each action's outcome to the step that was recorded just before it.
 *
 * The loop pushes a step in onBeforeAct and then immediately actuates, so the
 * pairing is positional and deterministic. The v2 schema wants a SUCCESS or
 * FAILED suffix on every executed action, and a trajectory that claims every
 * step worked would tell the judge a story the run did not support.
 */
function recordOutcomes(controller, steps) {
  const wrapped = Object.create(null);
  for (const key of Object.keys(controller)) {
    const fn = controller[key];
    if (typeof fn !== "function") { wrapped[key] = fn; continue; }
    if (!ACTION_METHODS.includes(key)) { wrapped[key] = fn.bind(controller); continue; }
    wrapped[key] = async (...args) => {
      const res = await fn.apply(controller, args);
      const step = steps[steps.length - 1];
      if (step && step.status == null) step.status = res && res.ok ? "SUCCESS" : "FAILED";
      return res;
    };
  }
  return wrapped;
}

/** One task, start to finish, in its own disposable browser session. */
async function runOneTask({ win, job, task, token }) {
  const started = Date.now();
  // The arm rides on the unit, not the job, so one chunk can interleave arms.
  // Running an arm to completion before the next one bakes a week of the live
  // web changing into the comparison; alternating them spreads that noise
  // evenly across all four.
  const arm = task.arm ?? job.arm;
  const grounding = task.grounding ?? job.grounding;
  const partition = `eval-${job.runId}-${arm}-${task.taskId}`;
  const shotDir = path.join(job.outDir, arm, "shots", task.taskId);
  fs.mkdirSync(shotDir, { recursive: true });

  const sess = session.fromPartition(partition, { cache: false });
  hardenSession(sess);

  // OFFSCREEN RENDERING IS REQUIRED, NOT AN OPTIMISATION.
  //
  // capturePage() fails with "Current display surface not available for
  // capture" on a hidden window, on a window positioned off-screen, AND on a
  // visible one — it depends on a compositing surface the OS will not hand an
  // unattended process. Measured: of {show:false, off-screen position,
  // showInactive, offscreen:true}, only offscreen:true returns pixels.
  //
  // That matters more than it sounds. Harness-captured screenshots on a fixed
  // schedule are what makes the WebJudge scoring valid — judging on whatever
  // frames the agent happened to take would manufacture a grounding-mode
  // effect, since refs mode may capture nothing all task and holo mode
  // captures every round. No screenshots, no comparable scores.
  //
  // Verified under offscreen rendering: snapshot, click by ref, click by
  // coordinate, type by ref, type by coordinate (OS-level write, verified),
  // and screenshot. The trade-off is a software compositing path, so
  // GPU-heavy pages may render differently — identically across all four arms,
  // so it cannot bias the comparison.
  //
  // --show turns it off so a smoke run can be watched, and screenshots are
  // then unavailable. Never use --show for a scored run.
  const offscreen = job.options?.show !== true;

  const view = new WebContentsView({
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Hidden views throttle timers and rAF, which leaves lazy-loading pages
      // stuck on spinners and reads as an agent failure.
      backgroundThrottling: false,
      offscreen,
    },
  });

  const wc = view.webContents;
  wc.setUserAgent(CHROME_UA);
  wc.setWindowOpenHandler(() => ({ action: "deny" }));

  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 900 });

  // Screenshots on a FIXED schedule, captured by the harness rather than by the
  // agent. In refs mode the vision policy may never fire on an ordinary
  // shopping site, while holo mode needs pixels every round — judging on
  // whichever screenshots happened to exist would manufacture a grounding-mode
  // effect out of pure evidence availability.
  const steps = [];
  let harnessOverheadMs = 0;

  const captureFrame = async (controller, meta) => {
    const t0 = Date.now();
    try {
      const shot = await controller.screenshot();
      if (!shot?.ok || !shot.dataUrl) return null;
      const b64 = String(shot.dataUrl).split(",")[1] || "";
      // Zero-padded so filenames sort lexicographically into step order, which
      // the upstream v2 schema requires of every submission.
      const name = `${String(steps.length).padStart(4, "0")}.jpg`;
      fs.writeFileSync(path.join(shotDir, name), Buffer.from(b64, "base64"));
      return name;
    } catch {
      return null;
    } finally {
      harnessOverheadMs += Date.now() - t0;
    }
  };

  let result;
  let guard = null;
  let usage = { calls: 0, inputTokens: 0, outputTokens: 0, upstreamMs: 0, byStage: {} };
  const timeoutMs = Number(job.options?.taskTimeoutMs ?? 600000);
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const nav = await ownedBrowserAct.navigate(wc, task.startUrl);
    if (nav && nav.ok === false) throw new Error(`start_url_failed: ${nav.error || "unknown"}`);

    const rawController = browserAgent.createBrowserController({
      webContents: wc,
      actuator: ownedBrowserAct,
    });
    guard = createEvalGuard({
      controller: rawController,
      maxHosts: Number(job.options?.maxHosts ?? 25),
      onBlock: (b) => emit({ type: "block", taskId: task.taskId, arm, ...b }),
    });

    // In direct mode the model calls never leave this process: the same client
    // runs, with a local transport instead of an HTTP one. See directModel.cjs
    // for what that does and does not exercise.
    const fetchImpl = job.options?.direct ? await createDirectFetch({ arm }) : undefined;

    const model = browserAgent.createAgentModel({
      apiBase: job.apiBase,
      getAuthToken: async () => token,
      fetchImpl,
      arm,
      onUsage: (u) => {
        usage.calls += 1;
        usage.inputTokens += u.inputTokens;
        usage.outputTokens += u.outputTokens;
        usage.upstreamMs += u.upstreamMs;
        const st = usage.byStage[u.stage] || (usage.byStage[u.stage] = { calls: 0, in: 0, out: 0, ms: 0 });
        st.calls += 1; st.in += u.inputTokens; st.out += u.outputTokens; st.ms += u.upstreamMs;
      },
    });

    result = await browserAgent.runBrowserAgentTask({
      goal: task.goal,
      userAsk: task.goal,
      controller: recordOutcomes(guard.controller, steps),
      model,
      // Non-negotiable. recordWhatWeLearned writes durable per-site notes, so
      // with memory on, task 40 inherits task 12 — and arms running at
      // different times inherit differently.
      memory: null,
      signal: ac.signal,
      maxRounds: Number(job.options?.maxRounds ?? 24),
      groundingMode: grounding,
      timing: true,
      // Per task, because debugLog names the file by the agent's INTERNAL task
      // id (a uuid we never see), so a shared directory would leave the report
      // unable to say which trace belongs to which unit. The per-stage latency
      // numbers live in these files.
      userDataPath: path.join(job.outDir, arm, "logs", task.taskId),
      onBeforeAct: async ({ decision, snapshot } = {}) => {
        const shot = await captureFrame(guard.controller);
        const action = decision?.action ?? null;
        const target = resolveTarget(action, snapshot);
        steps.push({
          step: steps.length,
          screenshot: shot,
          url: (() => { try { return wc.getURL(); } catch { return null; } })(),
          action,
          target,
          status: null,
          thought: decision?.reason ?? null,
        });
      },
      // Fails CLOSED. Passing null is wrong: that path leaves `declined` false
      // and falls through to waitForUser, which hangs an unattended run.
      onApprovalNeeded: async () => false,
      onNeedsUser: async () => ({ resumed: false }),
    });
  } catch (e) {
    result = {
      ok: false,
      status: ac.signal.aborted ? "task_timeout" : "crashed",
      answer: String(e?.message || e).slice(0, 500),
      task: null,
      history: [],
    };
  } finally {
    clearTimeout(killer);
  }

  // A final frame, so the judge can see the end state even if the last action
  // was the one that reached it.
  try {
    if (guard) {
      const shot = await captureFrame(guard.controller);
      if (shot) {
        steps.push({
          step: steps.length, screenshot: shot,
          url: (() => { try { return wc.getURL(); } catch { return null; } })(),
          action: "FINAL_STATE", thought: null,
        });
      }
    }
  } catch { /* the run is already over */ }

  // Tear the session down completely; an ephemeral partition should leave
  // nothing behind, and clearing makes that true rather than assumed.
  try {
    win.contentView.removeChildView(view);
    await sess.clearStorageData();
    wc.close();
  } catch { /* the view may already be gone */ }

  return {
    type: "result",
    runId: job.runId,
    arm,
    grounding,
    taskId: task.taskId,
    goal: task.goal,
    startUrl: task.startUrl,
    level: task.level ?? null,
    referenceLength: task.referenceLength ?? null,
    status: result?.status ?? "crashed",
    ok: result?.ok === true,
    answer: String(result?.answer ?? "").slice(0, 4000),
    rounds: result?.task?.round ?? 0,
    steps,
    blocks: guard ? guard.blocks : [],
    hosts: guard ? guard.hosts.length : 0,
    harnessOverheadMs,
    usage: guard ? usage : null,
    wallMs: Date.now() - started,
    finishedAt: new Date().toISOString(),
  };
}

async function main() {
  const jobPath = arg("--job");
  if (!jobPath) {
    emit({ type: "fatal", error: "missing --job" });
    app.exit(2);
    return;
  }
  const job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
  // Direct mode needs no session: it talks to the providers, not to our API.
  const direct = job.options?.direct === true;
  const token = process.env.LYKN_EVAL_TOKEN || (direct ? "direct-mode" : "");
  if (!token) {
    emit({ type: "fatal", error: "LYKN_EVAL_TOKEN not set" });
    app.exit(2);
    return;
  }

  const win = new BrowserWindow({
    show: job.options?.show === true,
    width: 1280,
    height: 900,
    webPreferences: { offscreen: false },
  });

  if (job.options?.show === true) {
    emit({
      type: "warn",
      warning: "show_mode_disables_screenshots",
      detail: "--show turns off offscreen rendering so the run can be watched. "
        + "capturePage() cannot capture a composited window in this environment, "
        + "so no screenshots will be written and WebJudge cannot score this run.",
    });
  }

  emit({ type: "chunk_start", runId: job.runId, tasks: job.tasks.length });

  for (const task of job.tasks) {
    try {
      emit(await runOneTask({ win, job, task, token }));
    } catch (e) {
      emit({
        type: "result", runId: job.runId, arm: task.arm ?? job.arm, taskId: task.taskId,
        status: "crashed", ok: false,
        answer: `harness_error: ${String(e?.message || e).slice(0, 300)}`,
        steps: [], blocks: [], wallMs: 0, finishedAt: new Date().toISOString(),
      });
    }
  }

  emit({ type: "chunk_done", runId: job.runId });
  app.exit(0);
}

app.disableHardwareAcceleration();
app.whenReady().then(main).catch((e) => {
  emit({ type: "fatal", error: String(e?.message || e) });
  app.exit(1);
});

// A renderer crash must not strand the supervisor waiting on a process that
// will never emit another line.
process.on("uncaughtException", (e) => {
  emit({ type: "fatal", error: `uncaught: ${String(e?.message || e)}` });
  app.exit(1);
});
