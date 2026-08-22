#!/usr/bin/env node
// ============================================================================
// scripts/eval/mind2web-fetch.mjs — pull the Online-Mind2Web eval assets we
//                                   need into eval/mind2web/cache/ (gitignored)
// ============================================================================
// Usage:
//   node scripts/eval/mind2web-fetch.mjs [--force] [--sha <commit>]
//   HF_TOKEN=hf_… node scripts/eval/mind2web-fetch.mjs --hf
//
// The --hf flag additionally pulls the HuggingFace dataset file, which is the
// ONLY source of each task's `website` (its start URL) and `reference_length`.
// Neither is in the GitHub repo, and the task text usually does not name the
// site — see mind2web-build-manifest.mjs. The dataset is gated:"auto", i.e.
// self-serve: accept the terms at huggingface.co/datasets/osunlp/Online-Mind2Web
// and any account token works immediately. No manual review, no waiting.
//
// Why not `git clone`
// -------------------
// OSU-NLP-Group/Online-Mind2Web is ~5.7 GB. Over 99% of that is
// data/evaluation_results/agent_reward_bench_evaluation_results/ — trajectories
// for a *different* benchmark (WebArena / VisualWebArena / AssistantBench) that
// this harness never reads. A shallow clone still transfers the whole tree and
// times out. So we fetch the ~13 files we actually use over raw.githubusercontent
// at a pinned commit.
//
// Integrity
// ---------
// Each file carries its git blob SHA-1 as recorded in the pinned commit's tree.
// We recompute it locally (sha1("blob <len>\0" + bytes), exactly how git hashes a
// blob) and refuse to write on mismatch. That ties every byte to the pinned
// commit rather than to whatever the CDN served us — a plain size check would
// not, and a sha256 of our own first download would only prove we downloaded it
// twice the same way.
//
// What lands where
//   eval/mind2web/cache/<upstream path>   the files themselves
//   eval/mind2web/cache/FETCHED.json      commit + per-file blob sha + bytes
// ============================================================================

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'OSU-NLP-Group/Online-Mind2Web';

// Pinned 2026-08-18. Bumping this is a deliberate act: re-run with --sha, then
// re-run mind2web-build-manifest.mjs and diff the manifest before committing.
const PINNED_SHA = 'f0d805ee0e9e0b3ea70911e45e5264b72968f3dc';

// The HuggingFace dataset, pinned the same way. Gated:"auto" — self-serve.
const HF_REPO = 'osunlp/Online-Mind2Web';
const HF_SHA = 'eacad896a84dc5b65e29b0b06e4699ab0544d701';
const HF_FILE = ['Online_Mind2Web.json', 'e8a5e5a99f2be9eae14f4e4259bd5af562f80da9', 88382];

// [upstream path, git blob sha-1, bytes] from the pinned commit's tree.
const FILES = [
  ['LICENSE', 'bb7c724a543b8951fe6332f1751a42d7f17eb198', 1087],
  ['requirements.txt', '17fbc1cae0980dffdb17adedbbdd4ab3fc75a051', 45],
  ['script/eval.sh', '9632985c437f031eaf717a38816d56324d2f3112', 536],

  // The task list: 300 tasks (task_id + confirmed_task) plus human success
  // labels for six agents. Those 1,800 labels are our judge-calibration set.
  ['data/evaluation_results/online_mind2web_evaluation_results/human_label.json',
    '22f1c3cfb4a94a961ab29ffac3410d976354387f', 109294],

  // Reference key_points per task, as used by the published WebJudge runs. We
  // reuse these rather than generating our own so key-point wording is not a
  // source of arm-to-arm variance. Two agents' files, because neither one is
  // guaranteed to cover all 300 tasks on its own.
  ['data/evaluation_results/online_mind2web_evaluation_results/webjudge_gpt4o/operator_results.json',
    '7380cceb7f5c7db03f560878dd94602e122d31f2', 5265916],
  ['data/evaluation_results/online_mind2web_evaluation_results/webjudge_gpt4o/claude_computer_use_3.7_results.json',
    '8ce9f9068cc7e68238dd731114dedee984676b81', 5932676],

  // The same 300 tasks judged by a DIFFERENT judge model. Fetched to measure
  // judge-vs-human agreement per judge config before picking one: the gpt-4o
  // runs agree with humans 78-79%, not the ~85% the literature summary
  // suggests, and their errors skew heavily false-positive. Choosing the judge
  // on measured agreement rather than reputation is cheap here because both
  // sets of verdicts are already published.
  ['data/evaluation_results/online_mind2web_evaluation_results/webjudge_o4-mini/operator_results.json',
    'e88eff91215a372eff3dfba555c385b47b333e28', 6331569],
  ['data/evaluation_results/online_mind2web_evaluation_results/webjudge_o4-mini/claude_computer_use_3.7_results.json',
    'd3f1dbbc076e64805b04535753f0af67fc1f73c9', 5455618],
  ['data/evaluation_results/online_mind2web_evaluation_results/webjudge_o4-mini/agente_results.json',
    '2d406261a2211560d68503c2f904fbbf4c41cd31', 3441093],
  ['data/evaluation_results/online_mind2web_evaluation_results/webjudge_o4-mini/browser_use_results.json',
    'eee6565889c514a816095f1198b2e8f5b2540930', 3109641],
  ['data/evaluation_results/online_mind2web_evaluation_results/webjudge_o4-mini/seeact_results.json',
    'adf74aa3c60671091011cc15f61af3eb39959e3e', 3536604],
  ['data/evaluation_results/online_mind2web_evaluation_results/webjudge_o4-mini/claude_computer_use_3.5_results.json',
    '3374e7d7c812d988f8e7db5a60c63814bbb19ee7', 2273901],

  // The v2 submission schema our runner must emit, plus a worked example.
  ['data/schema_v2/schema_v2.json', 'fc3b109f417e160d2749b6680c9f53406e3a9931', 5938],
  ['data/schema_v2/README.md', '34082735fba5859c3b183834d00334ef786d83e1', 15819],
  ['data/schema_v2/example_v2.json', '2f51b033a1776dec1e91ccffb4bfcced1e909e30', 5849],

  // The scorer itself — run as-is in a scratch venv, never ported to JS.
  ['src/methods/webjudge_online_mind2web.py', '0e673dd3bbbed7e0c1ab5a352d4c921a0ff25651', 9962],
  ['src/run.py', 'bc63dd4a966386bc41797f8a3e5b407a3456dfa6', 7565],
  ['src/utils.py', 'f3db59d458af38e50a81e22048f7415f8615ade9', 3875],
  ['data/example_result/WebJudge_Online_Mind2Web_eval_gpt-4o-mini_score_threshold_3_auto_eval_results.json',
    '37d35c4ec4eb696f2b862073daa698ed0fa10d20', 8443],
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(REPO_ROOT, 'eval', 'mind2web', 'cache');

/** Git's blob hash: sha1 over "blob <bytelen>\0" followed by the raw content. */
function gitBlobSha(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

async function readIfIntact(dest, sha) {
  try {
    const buf = await readFile(dest);
    return gitBlobSha(buf) === sha ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Pull the HuggingFace dataset file. Returns a short status string.
 *
 * This is the only place `website` (start URL) and `reference_length` exist.
 * We keep it optional rather than required so the GitHub half of the fetch —
 * task list, key points, scorer, schema — works with no credentials at all.
 */
async function fetchHf({ force }) {
  const [name, sha, bytes] = HF_FILE;
  const dest = path.join(CACHE, 'hf', name);
  await mkdir(path.dirname(dest), { recursive: true });

  if (!force) {
    const have = await readIfIntact(dest, sha);
    if (have) return `cached (${have.length} bytes)`;
  }

  const token = process.env.HF_TOKEN;
  if (!token) {
    return 'skipped — no HF_TOKEN in env';
  }

  const url = `https://huggingface.co/datasets/${HF_REPO}/resolve/${HF_SHA}/${name}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) {
    return `denied (${res.status}) — accept the terms at https://huggingface.co/datasets/${HF_REPO}`;
  }
  if (!res.ok) return `failed (${res.status})`;

  const buf = Buffer.from(await res.arrayBuffer());
  const got = gitBlobSha(buf);
  if (got !== sha) {
    return `blob sha mismatch: expected ${sha}, got ${got} — not written`;
  }
  if (buf.length !== bytes) return `expected ${bytes} bytes, got ${buf.length} — not written`;

  await writeFile(dest, buf);
  return `fetched (${buf.length} bytes)`;
}

async function main() {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const shaIdx = argv.indexOf('--sha');
  const commit = shaIdx >= 0 ? argv[shaIdx + 1] : PINNED_SHA;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    console.error(`Not a full 40-char commit sha: ${commit}`);
    process.exit(2);
  }
  const pinned = commit === PINNED_SHA;

  console.log(`Fetching ${FILES.length} files from ${REPO} @ ${commit.slice(0, 10)}`);
  if (!pinned) {
    console.log('  ! --sha overrides the pin, so blob-hash checks are skipped.');
    console.log('    Re-pin PINNED_SHA and FILES from the tree API before committing.');
  }

  const records = [];
  let fetched = 0;
  let cached = 0;

  for (const [rel, sha, bytes] of FILES) {
    const dest = path.join(CACHE, rel);
    await mkdir(path.dirname(dest), { recursive: true });

    if (pinned && !force) {
      const have = await readIfIntact(dest, sha);
      if (have) {
        records.push({ path: rel, blobSha: sha, bytes: have.length, source: 'cache' });
        cached += 1;
        continue;
      }
    }

    const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${rel}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`FAIL ${res.status} ${rel}`);
      process.exit(1);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const got = gitBlobSha(buf);

    if (pinned && got !== sha) {
      console.error(`FAIL ${rel}\n  blob sha mismatch: expected ${sha}, got ${got}`);
      console.error('  Refusing to write. The pin and the served bytes disagree.');
      process.exit(1);
    }
    if (pinned && buf.length !== bytes) {
      console.error(`FAIL ${rel}: expected ${bytes} bytes, got ${buf.length}`);
      process.exit(1);
    }

    await writeFile(dest, buf);
    records.push({ path: rel, blobSha: got, bytes: buf.length, source: 'network' });
    fetched += 1;
    console.log(`  ${String(buf.length).padStart(8)}  ${rel}`);
  }

  const hfStatus = await fetchHf({ force });
  const hfOk = /^(fetched|cached)/.test(hfStatus);
  console.log(`\n  HuggingFace ${HF_FILE[0]}: ${hfStatus}`);

  const total = records.reduce((a, r) => a + r.bytes, 0);
  await writeFile(
    path.join(CACHE, 'FETCHED.json'),
    `${JSON.stringify({
      schema: 'lykn.eval.mind2web.fetched/1',
      repo: REPO,
      commit,
      pinned,
      fetchedAt: new Date().toISOString(),
      totalBytes: total,
      files: records,
      hf: { repo: HF_REPO, sha: HF_SHA, file: HF_FILE[0], status: hfStatus, available: hfOk },
    }, null, 2)}\n`,
  );

  console.log(`\n${fetched} fetched, ${cached} already cached — ${(total / 1e6).toFixed(1)} MB in eval/mind2web/cache/`);
  if (!hfOk) {
    console.log('\n  Start URLs are unavailable without the HuggingFace file.');
    console.log(`  Accept the terms (self-serve, instant) at https://huggingface.co/datasets/${HF_REPO}`);
    console.log('  then re-run with HF_TOKEN set. mind2web-build-manifest.mjs needs it.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
