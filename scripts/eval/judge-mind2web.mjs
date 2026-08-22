#!/usr/bin/env node
// ============================================================================
// scripts/eval/judge-mind2web.mjs — score a run with the upstream WebJudge
// ============================================================================
// Usage:
//   node scripts/eval/judge-mind2web.mjs --run-id 2026-08-19a               # dry run
//   node scripts/eval/judge-mind2web.mjs --run-id 2026-08-19a --score --samples 3
//   node scripts/eval/judge-mind2web.mjs --run-id 2026-08-19a --score --calibrate
//
// Dry run is the DEFAULT and costs nothing: it materialises every submission,
// checks it against the v2 schema, and greps every assembled payload for arm
// and model identifiers. --score is what spends money.
//
// The upstream scorer is run AS PUBLISHED, in a scratch venv, with exactly one
// patch (pinned key points — see patches/pinned-key-points.py.patch). Porting
// it to JS would risk silently diverging from the implementation whose ~85%
// human agreement is the reason these numbers mean anything.
//
// --calibrate scores the benchmark's own published trajectories instead of
// ours and compares the verdicts to human_label.json. Do that FIRST: an
// agreement rate you never measured makes the whole eval unfalsifiable.
// ============================================================================

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSubmission, validateSubmission, findLeaks, blindingTerms } from '../../lib/eval/submission.js';
import { parseResults } from '../../lib/eval/runPlan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(REPO_ROOT, 'eval/mind2web/cache');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(n);

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const c = spawn(cmd, args, { stdio: 'inherit', ...opts });
  c.on('error', reject);
  c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
});

/** Copy the upstream src/ tree into a scratch dir and apply the one patch. */
async function prepareScorer(scratch) {
  const src = path.join(scratch, 'src');
  await mkdir(path.join(src, 'methods'), { recursive: true });
  for (const f of ['run.py', 'utils.py']) {
    await copyFile(path.join(CACHE, 'src', f), path.join(src, f));
  }
  for (const f of ['agenttrek_eval.py', 'automomous_eval.py', 'webjudge_general_eval.py', 'webvoyager_eval.py']) {
    const from = path.join(CACHE, 'src/methods', f);
    if (existsSync(from)) await copyFile(from, path.join(src, 'methods', f));
  }
  await run(process.execPath, [
    path.join(HERE, 'apply-scorer-patch.mjs'),
    path.join(CACHE, 'src/methods/webjudge_online_mind2web.py'),
    path.join(src, 'methods/webjudge_online_mind2web.py'),
  ]);
  return src;
}

/** A throwaway venv with the upstream pins. Never the project's environment. */
async function prepareVenv(scratch) {
  const venv = path.join(scratch, 'venv');
  const py = path.join(venv, 'bin', 'python');
  if (!existsSync(py)) {
    console.log('Creating scratch venv…');
    await run('python3', ['-m', 'venv', venv]);
    await run(py, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']);
    await run(py, ['-m', 'pip', 'install', '--quiet', '-r', path.join(CACHE, 'requirements.txt')]);
  }
  return py;
}

async function main() {
  const runId = arg('--run-id');
  if (!runId) { console.error('--run-id is required'); process.exit(2); }
  const samples = Number(arg('--samples', 3));
  // o4-mini, not gpt-4o. Measured on the benchmark's own published verdicts
  // (scripts/eval/judge-calibration.mjs): head to head on the agents both
  // judges scored, o4-mini agrees with humans 82.5% vs 81.0%. The margin is
  // modest; the DIRECTION is not. gpt-4o over-calls success (FP 73 / FN 38)
  // and o4-mini under-calls it (FP 33 / FN 69). For an eval whose output is a
  // success rate, a judge that inflates every arm — and rewards a
  // confident-sounding final answer with no screenshot evidence — is the worse
  // failure. Override with --model if you want the published gpt-4o config.
  const model = arg('--model', 'o4-mini');
  const threshold = arg('--score-threshold', '3');
  const doScore = flag('--score');

  const outDir = path.join(REPO_ROOT, 'eval/runs', runId);
  const resultsPath = path.join(outDir, 'results.jsonl');
  if (!existsSync(resultsPath)) {
    console.error(`No results at ${path.relative(REPO_ROOT, resultsPath)}. Run the harness first.`);
    process.exit(2);
  }

  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'eval/mind2web/manifest.v1.json'), 'utf8'));
  const armsCfg = JSON.parse(await readFile(path.join(REPO_ROOT, 'eval/mind2web/arms.json'), 'utf8'));
  const refLen = new Map(manifest.tasks.map((t) => [t.taskId, t.referenceLength]));

  const results = [...parseResults(await readFile(resultsPath, 'utf8')).values()];
  console.log(`Loaded ${results.length} results from ${runId}.`);

  // Everything the judge must never see.
  const terms = blindingTerms({
    arms: armsCfg.arms.map((a) => a.id),
    models: [armsCfg.planner.model, armsCfg.grounder.model, ...armsCfg.arms.map((a) => a.middleModel)],
  });

  const judgeRoot = path.join(outDir, 'judge');
  await rm(judgeRoot, { recursive: true, force: true });

  const problems = [];
  const leaks = [];
  const byArm = new Map();
  let written = 0;

  for (const r of results) {
    if (!byArm.has(r.arm)) byArm.set(r.arm, []);
    byArm.get(r.arm).push(r);

    // A run that never produced a frame cannot be judged on evidence, and
    // handing the judge a narrative with no screenshots is precisely the
    // failure mode WebJudge is known for. Recorded, not scored.
    const sub = buildSubmission(r, { referenceLength: refLen.get(r.taskId) ?? null });
    if (!sub.action_history.length) {
      problems.push({ taskId: r.taskId, arm: r.arm, why: 'no screenshots — cannot be judged on evidence' });
      continue;
    }
    const errs = validateSubmission(sub);
    if (errs.length) { problems.push({ taskId: r.taskId, arm: r.arm, why: errs.join('; ') }); continue; }

    const found = findLeaks(sub, terms);
    if (found.length) { leaks.push({ taskId: r.taskId, arm: r.arm, terms: found }); continue; }

    const taskDir = path.join(judgeRoot, r.arm, r.taskId);
    await mkdir(path.join(taskDir, 'trajectory'), { recursive: true });
    await writeFile(path.join(taskDir, 'result.json'), `${JSON.stringify(sub, null, 2)}\n`);
    for (const s of sub.action_history) {
      const from = path.join(outDir, r.arm, 'shots', r.taskId, s.screenshot);
      if (existsSync(from)) await copyFile(from, path.join(taskDir, 'trajectory', s.screenshot));
      else problems.push({ taskId: r.taskId, arm: r.arm, why: `missing frame ${s.screenshot}` });
    }
    written += 1;
  }

  console.log(`\nMaterialised ${written} submissions across ${byArm.size} arms.`);
  for (const [armId, rs] of byArm) console.log(`  ${armId.padEnd(14)} ${rs.length} results`);

  if (leaks.length) {
    console.error(`\nBLINDING FAILURE on ${leaks.length} submission(s) — nothing was written for them:`);
    for (const l of leaks.slice(0, 10)) console.error(`  ${l.arm} ${l.taskId}: ${l.terms.join(', ')}`);
    console.error('An unblinded trajectory invalidates the arm comparison. Fix before scoring.');
    process.exit(1);
  }
  console.log('Blinding check: no arm or model identifier in any assembled submission.');

  if (problems.length) {
    console.log(`\n${problems.length} result(s) could not be submitted:`);
    const byWhy = {};
    for (const p of problems) byWhy[p.why.slice(0, 60)] = (byWhy[p.why.slice(0, 60)] ?? 0) + 1;
    for (const [why, n] of Object.entries(byWhy)) console.log(`  ${String(n).padStart(4)}  ${why}`);
    await writeFile(path.join(outDir, 'judge-problems.json'), `${JSON.stringify(problems, null, 2)}\n`);
    console.log(`  full list: ${path.relative(REPO_ROOT, path.join(outDir, 'judge-problems.json'))}`);
  }

  if (!doScore) {
    console.log('\nDry run only. Nothing was scored and nothing was spent.');
    console.log('Add --score to run the upstream WebJudge (this costs money).');
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('\nOPENAI_API_KEY is not set; the upstream scorer needs it.'); process.exit(2); }

  const scratch = path.join(outDir, 'scorer');
  await mkdir(scratch, { recursive: true });
  const src = await prepareScorer(scratch);
  const py = await prepareVenv(scratch);
  const keyPoints = path.join(REPO_ROOT, 'eval/mind2web/keypoints.v1.json');

  // Judge each arm N times. WebJudge agrees with humans ~85%, so at n≈72 a
  // single sample carries roughly ±6pp of noise — the same magnitude as the
  // effects we are trying to detect. Majority of three cuts that materially.
  for (const armId of byArm.keys()) {
    for (let s = 1; s <= samples; s += 1) {
      const outPath = path.join(outDir, 'scores', armId, `sample-${s}`);
      await mkdir(outPath, { recursive: true });
      console.log(`\nScoring ${armId}, sample ${s}/${samples}…`);
      await run(py, [
        path.join(src, 'run.py'),
        '--mode', 'WebJudge_Online_Mind2Web_eval',
        '--model', model,
        '--trajectories_dir', path.join(judgeRoot, armId),
        '--api_key', apiKey,
        '--output_path', outPath,
        '--score_threshold', threshold,
        '--num_worker', '8',
      ], { cwd: src, env: { ...process.env, LYKN_KEYPOINTS: keyPoints, PYTHONPATH: src } });
    }
  }

  console.log(`\nScored. Raw verdicts under ${path.relative(REPO_ROOT, path.join(outDir, 'scores'))}`);
  console.log('Aggregate with scripts/eval/report-mind2web.mjs.');
}

main().catch((e) => { console.error(e); process.exit(1); });
