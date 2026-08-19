#!/usr/bin/env node
// ============================================================================
// scripts/eval/run-mind2web.mjs — supervisor for the Online-Mind2Web matrix
// ============================================================================
// Usage:
//   node scripts/eval/run-mind2web.mjs --run-id 2026-08-19a --all-arms [--chunk 5]
//   node scripts/eval/run-mind2web.mjs --run-id 2026-08-19a --resume
//   node scripts/eval/run-mind2web.mjs --run-id smoke --arms luna-refs --task-id <id> --show
//
// Spawns a FRESH Electron child every --chunk units and after any crash. Over
// ~288 runs a single long-lived process accumulates leaked sessions and service
// workers, and we would end up attributing that to the agent.
//
// The child emits NDJSON on stdout; this appends it to results.jsonl, which IS
// the resume state — no separate bookkeeping to fall out of sync with reality.
//
// ORDERING
// --------
// Units are (task × arm) pairs, interleaved so all arms see a task at roughly
// the same moment. Running arm 1 to completion on Monday and arm 4 on Thursday
// bakes three days of the live web changing into the comparison. The trade-off
// is that four visits to one host land close together, so a same-host cooldown
// spaces them enough to avoid tripping rate limits and captchas.
// ============================================================================

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { buildUnits, pendingUnits, chunkUnits, parseResults, hostOf, unitKey } from '../../lib/eval/runPlan.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const arg = (n, d = null) => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d;
};
const flag = (n) => process.argv.includes(n);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadDone(resultsPath) {
  if (!existsSync(resultsPath)) return new Map();
  return parseResults(await readFile(resultsPath, 'utf8'));
}

/**
 * Run one chunk in a fresh Electron process.
 *
 * The hard kill is deliberately longer than the child's own per-task
 * AbortController: the child should time a task out and keep going, and this
 * only fires when the child itself has stopped making progress.
 */
function runChunk({ jobPath, token, hardKillMs, onLine }) {
  return new Promise((resolve) => {
    const electron = require('electron');
    const child = spawn(electron, [path.join(REPO_ROOT, 'electron/eval/harness-main.cjs'), '--job', jobPath], {
      cwd: REPO_ROOT,
      // The token travels in the environment. Never on the command line, where
      // any `ps` would show it, and never in the job file on disk.
      env: { ...process.env, LYKN_EVAL_TOKEN: token, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, hardKillMs);

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { onLine(JSON.parse(line)); } catch { /* Electron chatter on stdout */ }
      }
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 2000); });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, killed, stderr: stderr.slice(-2000) });
    });
  });
}

async function main() {
  const runId = arg('--run-id');
  if (!runId) { console.error('--run-id is required'); process.exit(2); }

  const chunkSize = Number(arg('--chunk', 5));
  const taskTimeoutMs = Number(arg('--task-timeout', 600)) * 1000;
  const cooldownMs = Number(arg('--cooldown', 60)) * 1000;
  const onlyTask = arg('--task-id', null);
  const limit = Number(arg('--limit', 0));
  const show = flag('--show');

  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'eval/mind2web/manifest.v1.json'), 'utf8'));
  const armsCfg = JSON.parse(await readFile(path.join(REPO_ROOT, 'eval/mind2web/arms.json'), 'utf8'));

  // The manifest PROPOSES; only a human promotes. Refusing to run "propose"
  // is the whole reason that field exists.
  const included = manifest.tasks.filter((t) => t.decision === 'include');
  const proposed = manifest.tasks.filter((t) => t.decision === 'propose').length;
  if (!included.length) {
    console.error(`No tasks with decision:"include" in the manifest (${proposed} still "propose").`);
    console.error('Review eval/mind2web/manifest.v1.json and promote the tasks you accept.');
    process.exit(2);
  }
  if (proposed) console.log(`Note: ${proposed} task(s) still "propose" and will not run.`);

  let tasks = included;
  if (onlyTask) tasks = tasks.filter((t) => t.taskId === onlyTask);
  if (limit > 0) tasks = tasks.slice(0, limit);

  const armIds = flag('--all-arms')
    ? armsCfg.arms.map((a) => a.id)
    : String(arg('--arms', '')).split(',').map((s) => s.trim()).filter(Boolean);
  if (!armIds.length) { console.error('Pass --all-arms or --arms a,b'); process.exit(2); }
  const arms = armsCfg.arms.filter((a) => armIds.includes(a.id));
  if (arms.length !== armIds.length) {
    console.error(`Unknown arm(s): ${armIds.filter((i) => !arms.some((a) => a.id === i)).join(', ')}`);
    process.exit(2);
  }

  // --direct skips our own API and calls the providers straight from .env. No
  // session needed, and the agent loop under test is identical — only the HTTP
  // hop, its auth, and server-side arm resolution go unexercised.
  const direct = flag('--direct');
  const token = process.env.LYKN_EVAL_TOKEN || (direct ? 'direct-mode' : '');
  if (!token) {
    console.error('LYKN_EVAL_TOKEN is not set.');
    console.error('  Either mint one (scripts/eval/mint-token.mjs) to run through the server,');
    console.error('  or pass --direct to call the providers straight from .env.');
    process.exit(2);
  }
  if (direct) {
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
      if (!process.env[k]) { console.error(`--direct needs ${k} in the environment.`); process.exit(2); }
    }
    console.log('Direct mode: provider calls bypass the server. Local runs only.');
  }

  const outDir = path.join(REPO_ROOT, 'eval/runs', runId);
  const jobDir = path.join(outDir, 'jobs');
  await mkdir(jobDir, { recursive: true });
  const resultsPath = path.join(outDir, 'results.jsonl');

  const done = await loadDone(resultsPath);
  const all = buildUnits(tasks, arms);
  const pending = pendingUnits(all, done);
  const chunks = chunkUnits(pending, chunkSize);

  console.log(`Run ${runId}: ${tasks.length} tasks × ${arms.length} arms = ${all.length} units`);
  console.log(`  already done: ${done.size}, pending: ${pending.length}, chunk size ${chunkSize}`);
  if (!pending.length) { console.log('Nothing to do.'); return; }

  if (show) {
    console.log('\n  --show disables offscreen rendering so you can watch, and screenshots');
    console.log('  are unavailable without it. Use --show for smoke runs only; a scored');
    console.log('  run needs the frames.\n');
  }
  const options = { maxRounds: 24, taskTimeoutMs, maxHosts: 25, show, direct };
  let completed = 0;
  let lastHost = '';

  for (const [ci, chunk] of chunks.entries()) {

    // Space same-host visits apart across the chunk boundary too.
    const firstHost = hostOf(chunk[0].startUrl);
    if (cooldownMs && lastHost && firstHost === lastHost) {
      console.log(`  cooling down ${cooldownMs / 1000}s before revisiting ${firstHost}`);
      await sleep(cooldownMs);
    }

    const jobPath = path.join(jobDir, `chunk-${String(ci).padStart(4, '0')}.json`);
    await writeFile(jobPath, JSON.stringify({
      runId, apiBase: process.env.LYKN_API_BASE || 'https://app.lykn.io',
      outDir, options, tasks: chunk,
    }, null, 2));

    const hardKillMs = taskTimeoutMs * chunk.length + 120000;
    process.stdout.write(`\n[chunk ${ci + 1}/${chunks.length}] ${chunk.length} units…\n`);

    const seen = new Set();
    const { code, killed, stderr } = await runChunk({
      jobPath, token, hardKillMs,
      onLine: async (msg) => {
        if (msg.type === 'result') {
          seen.add(unitKey(msg));
          completed += 1;
          await appendFile(resultsPath, `${JSON.stringify(msg)}\n`);
          const flags = msg.blocks?.length ? ` [${msg.blocks.length} blocked]` : '';
          console.log(`  ${msg.ok ? 'ok  ' : 'FAIL'} ${msg.arm.padEnd(12)} ${msg.status.padEnd(18)}`
            + ` ${Math.round((msg.wallMs || 0) / 1000)}s  ${msg.goal?.slice(0, 46) ?? ''}${flags}`);
        } else if (msg.type === 'fatal') {
          console.error(`  child fatal: ${msg.error}`);
        }
      },
    });

    // Anything the child never reported on is recorded as a harness failure
    // rather than left to look like it was never attempted — a silently
    // dropped unit would quietly shrink one arm's denominator.
    for (const u of chunk) {
      if (seen.has(unitKey(u))) continue;
      await appendFile(resultsPath, `${JSON.stringify({
        type: 'result', runId, arm: u.arm, grounding: u.grounding, taskId: u.taskId,
        goal: u.goal, startUrl: u.startUrl, status: killed ? 'harness_timeout' : 'crashed',
        ok: false, answer: `child exited ${code}${killed ? ' (SIGKILL)' : ''}: ${stderr.slice(-300)}`,
        steps: [], blocks: [], wallMs: 0, finishedAt: new Date().toISOString(),
      })}\n`);
      console.log(`  LOST ${u.arm.padEnd(12)} ${killed ? 'harness_timeout' : 'crashed'}  ${u.taskId}`);
    }

    lastHost = hostOf(chunk[chunk.length - 1].startUrl);
    console.log(`  progress ${completed}/${pending.length}`);
  }

  console.log(`\nDone. Results in ${path.relative(REPO_ROOT, resultsPath)}`);
  console.log('Re-run with --resume to pick up anything that failed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
