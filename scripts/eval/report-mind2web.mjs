#!/usr/bin/env node
// ============================================================================
// scripts/eval/report-mind2web.mjs — turn a scored run into a readable report
// ============================================================================
// Usage: node scripts/eval/report-mind2web.mjs --run-id 2026-08-19a
//        [--out eval/reports/<runId>.md]
//
// Reads results.jsonl, the scorer's verdicts, and the per-task traces, and
// writes one markdown file with aggregate numbers only — no per-task rows, so
// the report can be committed while eval/runs/ stays gitignored.
// ============================================================================

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseResults } from '../../lib/eval/runPlan.js';
import { wilson, summarize, mcnemar, pairCounts, power } from '../../lib/eval/stats.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d;
};

const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const ms = (x) => (x == null ? '—' : `${Math.round(x)}`);

// settle() caps waitForLoad at 8000ms and swallows the timeout, so a span at
// the cap IS the timeout. Without flagging these, p95 settle just reports the
// constant back at us and looks like a finding.
const SETTLE_CAP_MS = 8000;
const SETTLE_TIMEOUT_MS = 7900;

/** Majority verdict per task across the judge's N samples. */
async function loadVerdicts(runDir, armId) {
  const armDir = path.join(runDir, 'scores', armId);
  if (!existsSync(armDir)) return { byTask: new Map(), samples: 0 };
  const samples = (await readdir(armDir)).filter((d) => d.startsWith('sample-')).sort();
  const votes = new Map();
  for (const s of samples) {
    const dir = path.join(armDir, s);
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.json'))) {
      for (const line of (await readFile(path.join(dir, f), 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (o?.task_id == null || o.predicted_label == null) continue;
          if (!votes.has(o.task_id)) votes.set(o.task_id, []);
          votes.get(o.task_id).push(Number(o.predicted_label) === 1 ? 1 : 0);
        } catch { /* torn line */ }
      }
    }
  }
  const byTask = new Map();
  for (const [taskId, vs] of votes) {
    const yes = vs.filter((v) => v === 1).length;
    byTask.set(taskId, yes * 2 > vs.length ? 1 : 0);
  }
  return { byTask, samples: samples.length, votes };
}

/** Per-stage span durations for one arm, read from the per-task traces. */
async function loadSpans(runDir, armId) {
  const stages = new Map();
  const logsRoot = path.join(runDir, armId, 'logs');
  if (!existsSync(logsRoot)) return stages;
  for (const taskId of await readdir(logsRoot)) {
    const dir = path.join(logsRoot, taskId, 'browser-agent-logs');
    if (!existsSync(dir)) continue;
    for (const f of (await readdir(dir)).filter((x) => x.endsWith('.jsonl'))) {
      for (const line of (await readFile(path.join(dir, f), 'utf8')).split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e?.event !== 'span' || !Number.isFinite(e.ms)) continue;
          if (!stages.has(e.name)) stages.set(e.name, []);
          stages.get(e.name).push(e.ms);
        } catch { /* torn line */ }
      }
    }
  }
  return stages;
}

async function main() {
  const runId = arg('--run-id');
  if (!runId) { console.error('--run-id is required'); process.exit(2); }
  const runDir = path.join(REPO_ROOT, 'eval/runs', runId);
  const resultsPath = path.join(runDir, 'results.jsonl');
  if (!existsSync(resultsPath)) { console.error(`No results at ${resultsPath}`); process.exit(2); }

  const results = [...parseResults(await readFile(resultsPath, 'utf8')).values()];
  const armsCfg = JSON.parse(await readFile(path.join(REPO_ROOT, 'eval/mind2web/arms.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'eval/mind2web/manifest.v1.json'), 'utf8'));
  const levelOf = new Map(manifest.tasks.map((t) => [t.taskId, t.level]));

  const armIds = [...new Set(results.map((r) => r.arm))].sort();
  const arms = armIds.map((id) => armsCfg.arms.find((a) => a.id === id) ?? { id, middleModel: '?', grounding: '?' });

  const L = [];
  const w = (s = '') => L.push(s);

  w(`# Online-Mind2Web — run \`${runId}\``);
  w();
  w(`_Generated ${new Date().toISOString()}._`);
  w();
  w('> **These numbers are internally comparable across the four arms below and are NOT');
  w('> comparable to the published Online-Mind2Web leaderboard.** Different task subset,');
  w('> different judge configuration, different action space. The planner');
  w(`> (\`${armsCfg.planner.model}\`) and grounder (\`${armsCfg.grounder.model}\`) are held fixed,`);
  w('> so any difference between arms is attributable to the middle model or the grounding');
  w('> mode — which is the only question this eval is built to answer.');
  w();

  // --- Per-arm outcome ------------------------------------------------------
  const perArm = new Map();
  for (const a of arms) {
    const rs = results.filter((r) => r.arm === a.id);
    const { byTask, samples } = await loadVerdicts(runDir, a.id);
    const spans = await loadSpans(runDir, a.id);
    perArm.set(a.id, { arm: a, results: rs, verdicts: byTask, samples, spans });
  }

  const anyScored = [...perArm.values()].some((p) => p.verdicts.size);

  w('## Success rate');
  w();
  if (!anyScored) {
    w('No judge verdicts found — run `scripts/eval/judge-mind2web.mjs --score` first.');
    w('Everything below is derived from the runs themselves and needs no judge.');
  } else {
    w('| arm | middle model | grounding | judged | success | 95% CI (Wilson) |');
    w('|---|---|---|---|---|---|');
    for (const a of arms) {
      const p = perArm.get(a.id);
      const n = p.verdicts.size;
      const k = [...p.verdicts.values()].filter((v) => v === 1).length;
      const ci = wilson(k, n);
      w(`| \`${a.id}\` | ${a.middleModel} | ${a.grounding} | ${n} | ${n ? pct(k / n) : '—'} `
        + `| ${n ? `${pct(ci.lo)} – ${pct(ci.hi)}` : '—'} |`);
    }
    w();
    w(`Judged ${[...perArm.values()][0]?.samples || 0}× per task, majority vote. At n≈${
      [...perArm.values()][0]?.verdicts.size || 0} the interval is wide — read the paired`);
    w('tests below before concluding anything from a difference in the success column.');
  }
  w();

  // --- Paired comparisons ---------------------------------------------------
  if (anyScored) {
    w('## Paired comparisons (McNemar)');
    w();
    w('All arms ran the same task list, so the paired test is the correct one: tasks both');
    w('arms got right, or both got wrong, carry no information about which is better and are');
    w('excluded. `b` counts tasks only the first arm solved, `c` only the second.');
    w();
    w('| comparison | b | c | paired n | p | verdict |');
    w('|---|---|---|---|---|---|');
    for (let i = 0; i < arms.length; i += 1) {
      for (let j = i + 1; j < arms.length; j += 1) {
        const A = perArm.get(arms[i].id);
        const B = perArm.get(arms[j].id);
        const counts = pairCounts(A.verdicts, B.verdicts);
        const t = mcnemar(counts.b, counts.c);
        const verdict = t.significant
          ? `**${counts.b > counts.c ? arms[i].id : arms[j].id} better** (${t.method})`
          : 'no detectable difference';
        w(`| \`${arms[i].id}\` vs \`${arms[j].id}\` | ${counts.b} | ${counts.c} `
          + `| ${counts.paired} | ${t.p < 0.001 ? '<0.001' : t.p.toFixed(3)} | ${verdict} |`);
      }
    }
    w();
    w('A "no detectable difference" at this sample size means exactly that — it is not');
    w('evidence the arms are equivalent. How far from equivalent it could be:');
    w();

    // Power computed from the discordant rate this run actually produced, so
    // it describes this eval rather than an idealised one.
    const rates = [];
    for (let i = 0; i < arms.length; i += 1) {
      for (let j = i + 1; j < arms.length; j += 1) {
        const cc = pairCounts(perArm.get(arms[i].id).verdicts, perArm.get(arms[j].id).verdicts);
        if (cc.paired) rates.push((cc.b + cc.c) / cc.paired);
      }
    }
    const psi = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0.3;
    const nPaired = Math.max(...[...perArm.values()].map((p) => p.verdicts.size), 1);
    w(`### What this run could detect`);
    w();
    w(`Arms disagreed on ${pct(psi)} of tasks on average, over ${nPaired} paired tasks.`);
    w('At that discordant rate, the chance of detecting a true difference of:');
    w();
    w('| true difference | chance of detecting it |');
    w('|---|---|');
    for (const row of power(nPaired, psi)) {
      w(`| ${(row.delta * 100).toFixed(0)} pp | ${pct(row.power)} |`);
    }
    w();
    w('**Read the small rows first.** A difference below roughly 15 pp is more likely to be');
    w('missed than found here, so a null result on this run rules out a *large* difference');
    w('and says little about a small one. Doubling the task count is the only thing that');
    w('moves these numbers much; judging more samples per task does not.');
    w();
  }

  // --- Run status -----------------------------------------------------------
  w('## Run status');
  w();
  w('`waiting_for_user` and `crashed` are infrastructure outcomes, not agent failures.');
  w('Folding them into `failed` makes a harness problem look like a capability problem.');
  w();
  const statuses = [...new Set(results.map((r) => r.status))].sort();
  w(`| arm | ${statuses.join(' | ')} | total |`);
  w(`|---|${statuses.map(() => '---').join('|')}|---|`);
  for (const a of arms) {
    const rs = perArm.get(a.id).results;
    const cells = statuses.map((s) => rs.filter((r) => r.status === s).length);
    w(`| \`${a.id}\` | ${cells.join(' | ')} | ${rs.length} |`);
  }
  w();

  // --- Latency --------------------------------------------------------------
  w('## Per-stage latency (ms)');
  w();
  w('`decide` is the middle model — the stage this eval exists to compare. `ground` is');
  w('genuinely n=0 in the refs arms; an empty cell there means the stage does not run, not');
  w('that data is missing.');
  w();
  const allStages = [...new Set([...perArm.values()].flatMap((p) => [...p.spans.keys()]))];
  const ORDER = ['plan', 'settle', 'snapshot', 'screenshot', 'decide', 'ground', 'actuate',
    'settle_after', 'observe_after', 'verify', 'learn'];
  const stages = [...ORDER.filter((s) => allStages.includes(s)), ...allStages.filter((s) => !ORDER.includes(s))];

  for (const a of arms) {
    const p = perArm.get(a.id);
    w(`**\`${a.id}\`**`);
    w();
    w('| stage | n | p50 | p95 | p99 | total s |');
    w('|---|---|---|---|---|---|');
    for (const st of stages) {
      const s = summarize(p.spans.get(st) ?? []);
      w(`| ${st} | ${s.n} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.p99)} | ${(s.total / 1000).toFixed(1)} |`);
    }
    const wall = summarize(p.results.map((r) => r.wallMs));
    const overhead = summarize(p.results.map((r) => r.harnessOverheadMs));
    w(`| _task wall clock_ | ${wall.n} | ${ms(wall.p50)} | ${ms(wall.p95)} | ${ms(wall.p99)} | ${(wall.total / 1000).toFixed(1)} |`);
    w(`| _harness overhead_ | ${overhead.n} | ${ms(overhead.p50)} | ${ms(overhead.p95)} | ${ms(overhead.p99)} | ${(overhead.total / 1000).toFixed(1)} |`);
    w();
    const settles = [...(p.spans.get('settle') ?? []), ...(p.spans.get('settle_after') ?? [])];
    const timedOut = settles.filter((v) => v >= SETTLE_TIMEOUT_MS).length;
    if (settles.length) {
      w(`Settle hit its ${SETTLE_CAP_MS} ms cap on ${timedOut}/${settles.length} `
        + `(${pct(timedOut / settles.length)}) of settles. Those are the constant, not a measurement.`);
      w();
    }
  }

  // --- Cost -----------------------------------------------------------------
  w('## Tokens and cost');
  w();
  const anyUsage = results.some((r) => r.usage?.calls);
  if (!anyUsage) {
    w('No token usage recorded for this run.');
  } else {
    w('| arm | calls | input tokens | output tokens | per task | per _successful_ task |');
    w('|---|---|---|---|---|---|');
    for (const a of arms) {
      const p = perArm.get(a.id);
      const u = p.results.reduce((acc, r) => ({
        calls: acc.calls + (r.usage?.calls ?? 0),
        inp: acc.inp + (r.usage?.inputTokens ?? 0),
        out: acc.out + (r.usage?.outputTokens ?? 0),
      }), { calls: 0, inp: 0, out: 0 });
      const successes = [...p.verdicts.values()].filter((v) => v === 1).length;
      const perTask = p.results.length ? Math.round((u.inp + u.out) / p.results.length) : 0;
      const perWin = successes ? Math.round((u.inp + u.out) / successes) : null;
      w(`| \`${a.id}\` | ${u.calls} | ${u.inp.toLocaleString()} | ${u.out.toLocaleString()} `
        + `| ${perTask.toLocaleString()} tok | ${perWin ? `${perWin.toLocaleString()} tok` : '—'} |`);
    }
    w();
    w('Tokens rather than dollars: per-token prices move, and the token counts are what we');
    w('actually measured. Multiply by the rate on the day.');
  }
  w();

  // --- Guard ----------------------------------------------------------------
  const blocked = results.filter((r) => (r.blocks?.length ?? 0) > 0);
  w('## Harness interventions');
  w();
  if (!blocked.length) {
    w('The safety guard blocked nothing. No run in this set was steered by the harness.');
  } else {
    const byRule = {};
    for (const r of blocked) for (const b of r.blocks) byRule[b.rule] = (byRule[b.rule] ?? 0) + 1;
    w(`The guard blocked an action in ${blocked.length} of ${results.length} runs.`);
    w('**A run the guard steered is not a clean measurement of the agent** — these are');
    w('flagged rather than silently included.');
    w();
    w('| rule | blocks |');
    w('|---|---|');
    for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) w(`| ${rule} | ${n} |`);
    w();
    w('| arm | runs with a block |');
    w('|---|---|');
    for (const a of arms) {
      w(`| \`${a.id}\` | ${blocked.filter((r) => r.arm === a.id).length} |`);
    }
  }
  w();

  // --- Difficulty -----------------------------------------------------------
  if (anyScored && levelOf.size) {
    w('## By task difficulty');
    w();
    const levels = [...new Set([...levelOf.values()].filter(Boolean))].sort();
    w(`| arm | ${levels.join(' | ')} |`);
    w(`|---|${levels.map(() => '---').join('|')}|`);
    for (const a of arms) {
      const p = perArm.get(a.id);
      const cells = levels.map((lv) => {
        const ids = [...p.verdicts.keys()].filter((t) => levelOf.get(t) === lv);
        if (!ids.length) return '—';
        const k = ids.filter((t) => p.verdicts.get(t) === 1).length;
        return `${pct(k / ids.length)} (${k}/${ids.length})`;
      });
      w(`| \`${a.id}\` | ${cells.join(' | ')} |`);
    }
    w();
  }

  // --- Method ---------------------------------------------------------------
  w('## Method notes');
  w();
  w('- **Judge.** Verdicts come from the upstream WebJudge, run unmodified except for a');
  w('  pinned-key-points lookup, so the same task is scored against identical criteria in');
  w('  every arm. Measured judge-vs-human agreement is in `npm run eval:m2w:calibrate`;');
  w('  it is ~82%, not the ~85% usually quoted, and the errors are not symmetric. Read that');
  w('  before treating any absolute success rate as exact. Judge bias shifts all four arms');
  w('  together, so the paired comparisons remain the trustworthy part.');
  w('- **Blinding.** The judge never sees an arm id, model name, or grounding mode, and both');
  w('  aiming modes render into one action vocabulary. Verified per submission at judge time.');
  w('- **Ordering.** Arms were interleaved per task, not run one after another, so live-site');
  w('  drift lands as noise across all arms instead of as bias against the last one.');
  w('- **Retry rule, declared in advance.** A `crashed` or `harness_timeout` run is retried');
  w('  once; failing twice counts as a **failure**, not a drop. Dropping them would quietly');
  w('  favour whichever arm crashed most.');
  w('- **Memory off.** No durable per-site notes, so no task inherits another.');
  w('- **Sessions.** Every task ran in a fresh ephemeral partition; no logged-in state.');
  w();

  const outPath = path.resolve(REPO_ROOT, arg('--out', `eval/reports/${runId}.md`));
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${L.join('\n')}\n`);
  console.log(`Wrote ${path.relative(REPO_ROOT, outPath)}`);
  console.log(`  ${results.length} results across ${arms.length} arms`
    + `${anyScored ? '' : ' (unscored — run judge-mind2web.mjs --score for success rates)'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
