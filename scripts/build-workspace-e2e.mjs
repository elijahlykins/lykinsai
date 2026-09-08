/**
 * Build-workspace E2E harness.
 *
 * Drives the PRODUCTION agent loop (chat-agent-loop.js) with the PRODUCTION
 * workspace tools (electron/localSystem.cjs, workspaceOnly mode) against a
 * real model — the same wiring as a Studio Build turn, minus the HTTP/SSE
 * transport and the desktop round trip. Approvals are auto-granted the way a
 * user clicking "Allow" would be.
 *
 * Usage:
 *   node scripts/build-workspace-e2e.mjs                # all scenarios
 *   node scripts/build-workspace-e2e.mjs greenfield     # one scenario
 *
 * Scenarios: greenfield, debug, repo, game
 * Requires ANTHROPIC_API_KEY in .env. Network needed for repo/game.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Env + workspace setup (before importing anything that reads them).
// ---------------------------------------------------------------------------
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const RUN_ROOT = path.join(os.tmpdir(), `lykn-build-e2e-${Date.now().toString(36)}`);
process.env.LYKN_BUILDS_DIR = RUN_ROOT;
fs.mkdirSync(RUN_ROOT, { recursive: true });

const { runAgentLoop } = await import(path.join(root, 'chat-agent-loop.js'));
const { BUILD_WORKSPACE_TOOL_NAMES } = await import(path.join(root, 'mcp-tools/localTools.js'));
const { buildWorkspaceGuidance } = await import(path.join(root, 'server/ai/buildWorkspaceTurn.js'));
const localSystem = require(path.join(root, 'electron/localSystem.cjs'));
const processManager = require(path.join(root, 'electron/build-workspace/processManager.cjs'));

const MODEL = process.env.E2E_BUILD_MODEL || 'claude-sonnet-5';

// ---------------------------------------------------------------------------
// The desktop side of the round trip, inlined: run the tool in workspaceOnly
// mode; if it pauses for approval, grant it (the user clicking "Allow").
// ---------------------------------------------------------------------------
let toolCalls = 0;
let approvals = 0;

async function executeLocalTool(call) {
  const started = Date.now();
  toolCalls += 1;
  let result = await localSystem.run(call.name, call.args || {}, { workspaceOnly: true });
  if (result?.needsApproval === true) {
    approvals += 1;
    console.log(`    [approval granted] ${result.summary || call.name}`);
    result = await localSystem.run(call.name, call.args || {}, {
      workspaceOnly: true,
      approved: true,
    });
  }
  const isError = !result || result.ok === false;
  return { payload: result, isError, latencyMs: Date.now() - started };
}

function briefArgs(args = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${String(s).slice(0, 100).replace(/\n/g, '\\n')}`);
  }
  return parts.join(' ');
}

async function runScenario(name, userMessage, { seed, verify } = {}) {
  console.log(`\n=== ${name} ===`);
  if (seed) await seed();

  const transcript = [];
  const result = await runAgentLoop({
    provider: 'anthropic',
    model: MODEL,
    env: process.env,
    systemPrompt:
      'You are LYKN, a software engineering agent building real software for the user.' +
      buildWorkspaceGuidance(),
    userContent: userMessage,
    maxOutputTokens: 8192,
    chatToolNames: [...BUILD_WORKSPACE_TOOL_NAMES],
    workspaceMode: true,
    ctx: {
      localToolNames: [...BUILD_WORKSPACE_TOOL_NAMES],
      awaitLocalTool: async (call, record) => {
        console.log(`  → ${call.name} ${briefArgs(call.args)}`);
        record({ id: call.id, name: call.name, args: call.args, status: 'running' });
        const out = await executeLocalTool(call);
        record({
          id: call.id,
          name: call.name,
          args: call.args,
          status: out.isError ? 'error' : 'done',
          result: out.payload,
        });
        if (out.isError) {
          console.log(`    ✖ ${String(out.payload?.error || 'failed').slice(0, 200)}`);
        }
        transcript.push({ tool: call.name, ok: !out.isError });
        return out;
      },
    },
    onTextChunk: () => {},
  });

  const failures = transcript.filter((t) => !t.ok).length;
  console.log(
    `  loop ok=${result.ok} reason=${result.reason || 'done'} tools=${transcript.length} toolErrors=${failures}`,
  );
  if (result.errorMessage) console.log(`  loop error: ${result.errorMessage}`);

  let verified = true;
  if (verify) {
    try {
      await verify();
      console.log('  ✔ verification passed');
    } catch (e) {
      verified = false;
      console.log(`  ✖ verification FAILED: ${e.message}`);
    }
  }
  return { name, ok: result.ok && verified, tools: transcript.length, failures };
}

function assertExists(p, what) {
  if (!fs.existsSync(p)) throw new Error(`${what} missing: ${p}`);
}

function findProject(fragment) {
  const dirs = fs.readdirSync(RUN_ROOT).filter((d) => !d.startsWith('.'));
  const hit = dirs.find((d) => d.includes(fragment)) || dirs[0];
  if (!hit) throw new Error(`no project folder created under ${RUN_ROOT}`);
  return path.join(RUN_ROOT, hit);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const scenarios = {
  greenfield: () =>
    runScenario(
      'greenfield: static site + managed server',
      'Build me a small pomodoro timer web app (plain HTML/CSS/JS, no framework). ' +
        'Then serve it locally with a static server as a background process, confirm it is ' +
        'actually serving, then stop the server and tell me where the project lives.',
      {
        verify: async () => {
          const proj = findProject('pomodoro');
          assertExists(path.join(proj, 'index.html'), 'index.html');
          const all = processManager.processStatus({});
          for (const p of all.processes || []) {
            if (p.running) throw new Error(`process ${p.processId} left running`);
          }
        },
      },
    ),

  debug: () =>
    runScenario(
      'debug: fix failing tests in an existing project',
      'The project "broken-calc" in my workspace has a failing test suite. ' +
        'Find the bug, fix it, and make the tests pass. Show me the passing test output.',
      {
        seed: async () => {
          const proj = path.join(RUN_ROOT, 'broken-calc');
          fs.mkdirSync(proj, { recursive: true });
          fs.writeFileSync(
            path.join(proj, 'package.json'),
            JSON.stringify(
              { name: 'broken-calc', version: '1.0.0', scripts: { test: 'node test.js' } },
              null,
              2,
            ),
          );
          fs.writeFileSync(
            path.join(proj, 'calc.js'),
            // Classic off-by-one: sums indices 1..n-1, skipping the first item.
            'function sumCart(prices) {\n  let total = 0;\n  for (let i = 1; i < prices.length; i++) total += prices[i];\n  return total;\n}\nmodule.exports = { sumCart };\n',
          );
          fs.writeFileSync(
            path.join(proj, 'test.js'),
            'const assert = require("assert");\nconst { sumCart } = require("./calc.js");\nassert.strictEqual(sumCart([10, 20, 30]), 60, "sumCart should sum every item");\nconsole.log("all tests passed");\n',
          );
        },
        verify: async () => {
          const res = await localSystem.run(
            'local_run_command',
            { command: 'npm test', cwd: path.join(RUN_ROOT, 'broken-calc') },
            { workspaceOnly: true },
          );
          if (!res.ok) throw new Error(`npm test still failing: ${String(res.output).slice(0, 300)}`);
        },
      },
    ),

  repo: () =>
    runScenario(
      'repo: clone, inspect, modify, commit',
      'Clone https://github.com/octocat/Hello-World.git into my workspace. Look at what is in ' +
        'it, then add a NOTES.md file summarizing the repository contents, commit that file ' +
        '(author "LYKN Agent <agent@lykn.io>"), and show me the git log.',
      {
        verify: async () => {
          const proj = path.join(RUN_ROOT, 'Hello-World');
          assertExists(path.join(proj, '.git'), '.git');
          assertExists(path.join(proj, 'NOTES.md'), 'NOTES.md');
          const log = await localSystem.run(
            'local_run_command',
            { command: 'git log --oneline -n 3', cwd: proj },
            { workspaceOnly: true },
          );
          if (!log.ok || !/NOTES|notes|summary|add/i.test(log.output)) {
            throw new Error(`commit not found in git log: ${String(log.output).slice(0, 200)}`);
          }
        },
      },
    ),

  game: () =>
    runScenario(
      'game: Vite project, npm install, dev server',
      'Create a playable 2D snake game as a real Vite vanilla-JS project in my workspace: ' +
        'scaffold the project files yourself (package.json with vite, index.html, src modules — ' +
        'separate files for the game loop, snake logic, and rendering), install the ' +
        'dependencies, start the dev server as a background process, confirm it is serving and ' +
        'on which port, then stop it and summarize.',
      {
        verify: async () => {
          const proj = findProject('snake');
          assertExists(path.join(proj, 'package.json'), 'package.json');
          assertExists(path.join(proj, 'node_modules'), 'node_modules (deps installed)');
          const all = processManager.processStatus({});
          for (const p of all.processes || []) {
            if (p.running) throw new Error(`process ${p.processId} left running`);
          }
        },
      },
    ),
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const picked = process.argv.slice(2);
const toRun = picked.length ? picked : Object.keys(scenarios);
console.log(`workspace: ${RUN_ROOT}`);
console.log(`model: ${MODEL}`);

const results = [];
for (const name of toRun) {
  if (!scenarios[name]) {
    console.error(`unknown scenario: ${name}`);
    process.exit(2);
  }
  try {
    results.push(await scenarios[name]());
  } catch (e) {
    console.error(`scenario ${name} crashed:`, e);
    results.push({ name, ok: false, tools: 0, failures: 0 });
  }
  processManager.stopAll();
}

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (tools=${r.tools}, toolErrors=${r.failures})`);
}
console.log(`total tool calls: ${toolCalls}, approvals auto-granted: ${approvals}`);
console.log(`workspace kept for inspection: ${RUN_ROOT}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
