#!/usr/bin/env node
// ============================================================================
// scripts/eval/judge-calibration.mjs — measure the autorater before trusting it
// ============================================================================
// Usage: node scripts/eval/judge-calibration.mjs
//
// Costs nothing: both the judges' verdicts and the human labels are already in
// the cache. Run this BEFORE scoring anything of our own. An agreement rate
// nobody measured makes the whole eval unfalsifiable, and picking a judge on
// reputation when the evidence is sitting on disk is a choice not to look.
// ============================================================================

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agreement, skewTest, pct } from '../../lib/eval/calibration.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const M2W = path.join(REPO_ROOT,
  'eval/mind2web/cache/data/evaluation_results/online_mind2web_evaluation_results');

const AGENTS = [
  ['operator_results.json', 'Operator_human_label', 'Operator'],
  ['claude_computer_use_3.7_results.json', 'Claude_Computer_Use_3.7_human_label', 'Claude CU 3.7'],
  ['claude_computer_use_3.5_results.json', 'Claude_Computer_Use_3.5_human_label', 'Claude CU 3.5'],
  ['browser_use_results.json', 'Browser_Use_human_label', 'Browser Use'],
  ['seeact_results.json', 'SeeAct_human_label', 'SeeAct'],
  ['agente_results.json', 'Agent-E_human_label', 'Agent-E'],
];
const JUDGES = ['webjudge_gpt4o', 'webjudge_o4-mini'];

async function readVerdicts(file) {
  const out = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o?.task_id != null && o.final_eval != null) out.push({ taskId: o.task_id, verdict: Number(o.final_eval) });
    } catch { /* torn line */ }
  }
  return out;
}

async function main() {
  const human = JSON.parse(await readFile(path.join(M2W, 'human_label.json'), 'utf8'));

  console.log('Judge-vs-human agreement on the benchmark\'s own published runs.\n');
  const totals = new Map(JUDGES.map((j) => [j, { correct: 0, n: 0, fp: 0, fn: 0 }]));

  for (const judge of JUDGES) {
    console.log(`${judge}`);
    console.log('  agent            n    agreement            precision   inflation   FP    FN  excl');
    for (const [file, col, label] of AGENTS) {
      const p = path.join(M2W, judge, file);
      if (!existsSync(p)) { console.log(`  ${label.padEnd(15)} (not fetched)`); continue; }
      // Pass the labels through RAW. Coercing here is what hid the "2" value:
      // Number("2") is finite, so a filter on isFinite let it through to be
      // miscounted downstream. agreement() decides what is a usable label.
      const labels = new Map(human.map((r) => [r.task_id, r[col]]));
      const a = agreement(await readVerdicts(p), labels);
      const t = totals.get(judge);
      t.correct += a.correct; t.n += a.n; t.fp += a.fp; t.fn += a.fn;
      console.log(`  ${label.padEnd(15)} ${String(a.n).padStart(3)}  `
        + `${pct(a.accuracy.p).padStart(6)} [${pct(a.accuracy.lo)}–${pct(a.accuracy.hi)}]  `
        + `${pct(a.precision.p).padStart(6)}      `
        + `${(a.inflation ?? 0).toFixed(2).padStart(5)}    ${String(a.fp).padStart(3)}  ${String(a.fn).padStart(3)}`
        + `  ${String(a.indeterminate).padStart(4)}`);
    }
    const t = totals.get(judge);
    const skew = skewTest(t.fp, t.fn);
    console.log(`  ${'POOLED'.padEnd(15)} ${String(t.n).padStart(3)}  ${pct(t.correct / t.n).padStart(6)}`
      + `                    ${String(t.fp).padStart(20)}  ${String(t.fn).padStart(3)}`);
    console.log(`  error skew: ${skew.significant ? 'SIGNIFICANT' : 'not significant'} `
      + `(z=${skew.z.toFixed(2)}, ${skew.favours === 'false_positive' ? 'over-calls success' : 'under-calls success'})\n`);
  }

  // Pooled rows above cover different agent sets, so comparing them directly
  // overstates the gap — o4-mini's extra agents happen to be weaker ones, which
  // are easier to judge. The only fair comparison is on the agents both judges
  // scored.
  const common = [];
  for (const [file, col, label] of AGENTS) {
    if (JUDGES.every((j) => existsSync(path.join(M2W, j, file)))) common.push([file, col, label]);
  }
  if (common.length && JUDGES.length > 1) {
    console.log(`Head to head on the ${common.length} agent(s) both judges scored `
      + `(${common.map((c) => c[2]).join(', ')}):`);
    const scored = [];
    for (const judge of JUDGES) {
      let correct = 0; let n = 0; let fp = 0; let fn = 0;
      for (const [file, col] of common) {
        const labels = new Map(human.map((r) => [r.task_id, r[col]]));
        const a = agreement(await readVerdicts(path.join(M2W, judge, file)), labels);
        correct += a.correct; n += a.n; fp += a.fp; fn += a.fn;
      }
      scored.push({ judge, acc: correct / n, n, fp, fn });
      console.log(`  ${judge.padEnd(18)} ${pct(correct / n)}  (FP ${fp}, FN ${fn})`);
    }
    scored.sort((a, b) => b.acc - a.acc);
    const [best, rest] = scored;
    console.log(`\n  ${best.judge} leads by ${((best.acc - rest.acc) * 100).toFixed(1)} points`
      + ` — a real but modest edge. The larger difference is DIRECTION: `
      + `${best.fp < best.fn ? 'it under-calls success' : 'it over-calls success'}`
      + `, while ${rest.judge} ${rest.fp > rest.fn ? 'over-calls' : 'under-calls'}.`);
    console.log('  A judge that over-calls inflates every arm and rewards a confident-sounding');
    console.log('  final answer with no screenshot evidence — the known WebJudge failure mode.');
  }
  console.log('\nRead the inflation column before reading any success rate we produce:');
  console.log('a judge above 1.00 reports more successes than happened, for every arm at once.');
  console.log('That shifts the absolute numbers; it cancels only in BETWEEN-arm comparisons,');
  console.log('which is why the paired tests in the report are the trustworthy part.');
}

main().catch((e) => { console.error(e); process.exit(1); });
