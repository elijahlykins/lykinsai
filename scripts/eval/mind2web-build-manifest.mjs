#!/usr/bin/env node
// ============================================================================
// scripts/eval/mind2web-build-manifest.mjs — propose the login-free subset
// ============================================================================
// Usage:
//   node scripts/eval/mind2web-build-manifest.mjs [--target 72] [--probe]
//        [--cap 2] [--concurrency 8] [--urls <file>] [--out <file>]
//
// Reads the cache written by mind2web-fetch.mjs and proposes a subset of
// Online-Mind2Web that is safe to run unattended against the live web. The
// screening and selection decisions live in lib/eval/mind2webManifest.js; this
// file is the I/O around them.
//
// This script PROPOSES. Every task it selects is written with
// `decision: "propose"`, and the runner refuses to execute anything that is not
// `decision: "include"`. Promoting them is a deliberate human act. That is the
// point: an automated filter is a first pass over live-web tasks, not an
// authority.
//
// Two things make the output auditable rather than merely plausible:
//   1. EXCLUSIONS ARE RECORDED, with the rule that fired and its version. A
//      subset you cannot argue with is a subset nobody checked. Every one of
//      the 300 tasks appears in the manifest, included or excluded.
//   2. Selection is deterministic — tasks sort by sha256(task_id), so the same
//      inputs always yield the same subset, byte for byte. No sampling seed to
//      lose, and a re-run after a rule change produces a reviewable diff.
//
// Start URLs
// ----------
// The benchmark records each task's site in the HuggingFace dataset only; the
// GitHub repo does not carry it, and the task text names the site too rarely
// (86 of 300) to infer one honestly. Two sources, in order:
//   1. eval/mind2web/cache/hf/Online_Mind2Web.json  — authoritative.
//   2. --urls <file>, a {taskId: url} JSON map      — hand-resolved.
// Each task records which source its URL came from, so a hand-resolved run is
// never mistaken for an authoritative one.
// ============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RULES, ADVISORIES, lateRules, screen, select,
  registrableDomain, parseUrl, AUTH_HOST_RE, AUTH_PATH_RE,
} from '../../lib/eval/mind2webManifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const CACHE = path.join(REPO_ROOT, 'eval', 'mind2web', 'cache');
const M2W = 'data/evaluation_results/online_mind2web_evaluation_results';

const AGENTS = ['Operator', 'Agent-E', 'Browser_Use', 'Claude_Computer_Use_3.5',
  'Claude_Computer_Use_3.7', 'SeeAct'];

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const readJson = async (rel) => JSON.parse(await readFile(path.join(CACHE, rel), 'utf8'));

/** The webjudge result files are JSONL despite the .json suffix. */
async function readJsonl(rel) {
  const text = await readFile(path.join(CACHE, rel), 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

/**
 * Reference key points, keyed by task_id.
 *
 * These come from the published WebJudge runs. The scorer normally regenerates
 * key points per trajectory from the task text alone — which means the same
 * task would get slightly different key points in each of our four arms, adding
 * noise to exactly the comparison this eval exists to make. Pinning the
 * upstream text removes that, and it is the benchmark authors' own wording
 * rather than ours.
 */
async function loadKeyPoints() {
  const byId = new Map();
  for (const f of ['operator_results.json', 'claude_computer_use_3.7_results.json']) {
    for (const rec of await readJsonl(`${M2W}/webjudge_gpt4o/${f}`)) {
      if (!rec?.task_id || !rec.key_points || byId.has(rec.task_id)) continue;
      byId.set(rec.task_id, {
        keyPoints: String(rec.key_points).replace(/\n\n/g, '\n').trim(),
        goal: String(rec.confirmed_task ?? '').trim(),
        source: `webjudge_gpt4o/${f}`,
      });
    }
  }
  return byId;
}

/** Start URL + reference_length, from the HuggingFace file when it is present. */
async function loadHfMeta() {
  let raw;
  try {
    raw = await readFile(path.join(CACHE, 'hf', 'Online_Mind2Web.json'), 'utf8');
  } catch {
    return { available: false, byId: new Map() };
  }
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    rows = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  if (!Array.isArray(rows)) rows = rows.data ?? rows.rows ?? [];

  const byId = new Map();
  for (const r of rows) {
    const id = r.task_id ?? r.id;
    if (!id) continue;
    byId.set(id, {
      // The task text belongs to the same row as the URL and must travel with
      // it. Reading the goal from the other file is how a rewritten task ends
      // up pointed at the new site with the old instruction.
      goal: r.confirmed_task ?? r.task ?? null,
      startUrl: r.website ?? r.url ?? r.start_url ?? null,
      referenceLength: r.reference_length ?? r.reference_len ?? null,
      level: r.level ?? null,
    });
  }
  return { available: byId.size > 0, byId };
}

/** Hand-resolved {taskId: url} overrides. */
async function loadUrlOverrides(file) {
  if (!file) return new Map();
  const raw = JSON.parse(await readFile(path.resolve(REPO_ROOT, file), 'utf8'));
  const src = raw.urls ?? raw;
  return new Map(Object.entries(src).filter(([, v]) => typeof v === 'string' && v));
}

// ---------------------------------------------------------------------------
// Reachability probe
// ---------------------------------------------------------------------------

/**
 * A cheap liveness check, deliberately not a browser. It catches dead hosts and
 * sites that bounce straight to a login wall; it cannot catch a page that needs
 * JavaScript to render, or a bot wall that only fires on a real browser. Those
 * survive to the pilot, which is where they belong.
 */
async function probe(url, timeoutMs = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          + ' (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const final = parseUrl(res.url || url);
    if (res.status >= 400) return { ok: false, status: res.status, reason: `http_${res.status}` };
    if (final && (AUTH_HOST_RE.test(final.hostname) || AUTH_PATH_RE.test(final.pathname))) {
      return { ok: false, status: res.status, finalUrl: res.url, reason: 'redirects_to_auth' };
    }
    return { ok: true, status: res.status, finalUrl: res.url };
  } catch (e) {
    return { ok: false, reason: e?.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function arg(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
}

async function main() {
  const argv = process.argv.slice(2);
  const target = Number(arg(argv, '--target', 72));
  const perDomainCap = Number(arg(argv, '--cap', 2));
  const concurrency = Number(arg(argv, '--concurrency', 8));
  const doProbe = argv.includes('--probe');
  const urlsFile = arg(argv, '--urls', null);
  const outPath = path.resolve(REPO_ROOT, arg(argv, '--out', 'eval/mind2web/manifest.v1.json'));

  const fetched = await readJson('FETCHED.json').catch(() => null);
  if (!fetched) {
    console.error('No eval/mind2web/cache/FETCHED.json — run scripts/eval/mind2web-fetch.mjs first.');
    process.exit(2);
  }

  const human = await readJson(`${M2W}/human_label.json`);
  const keyPoints = await loadKeyPoints();
  const hf = await loadHfMeta();
  const overrides = await loadUrlOverrides(urlsFile);

  console.log(`Loaded ${human.length} tasks, ${keyPoints.size} with reference key points.`);
  console.log(`Start URLs: ${hf.available ? `${hf.byId.size} from HuggingFace` : 'none from HuggingFace'}`
    + `${overrides.size ? `, ${overrides.size} from ${urlsFile}` : ''}`);

  // -------------------------------------------------------------------------
  // The HuggingFace file is the SPINE when it is present, and human_label.json
  // only decorates it.
  //
  // They are not two views of one task list. 60 of the 300 HF task_ids carry a
  // date suffix (_110325 … _070826) marking a task the maintainers REWROTE when
  // the site changed, and for 59 of those the goal text no longer resembles the
  // frozen one — `b7258ee0…` is a Trader Joe's task upstream and a Gamestop task
  // in human_label.json. Three more diverged without a suffix bump.
  //
  // So human_label.json is a snapshot pinned to the published agent results,
  // and the HF file is the live benchmark. Goals, URLs, and ids must come from
  // one source or a task ends up paired with another task's start URL. Human
  // labels attach on EXACT task_id only — never by stripping the suffix, which
  // is precisely how the Trader Joe's URL would acquire the Gamestop goal.
  // -------------------------------------------------------------------------
  const humanById = new Map(human.map((r) => [r.task_id, r]));

  const spine = hf.available
    ? [...hf.byId].map(([taskId, meta]) => ({ taskId, meta, row: humanById.get(taskId) ?? null }))
    : human.map((r) => ({ taskId: r.task_id, meta: {}, row: r }));

  let staleTextSkipped = 0;
  const tasks = spine.map(({ taskId, meta, row }) => {
    const goal = meta.goal ?? row?.confirmed_task ?? '';
    const override = overrides.get(taskId) ?? null;

    // Key points were generated from the task text as it read at the time. If
    // the text has since changed they describe a different task, and pinning
    // them would score this run against the wrong criteria. Only reuse them
    // when the wording is byte-identical; otherwise Phase 6 regenerates.
    const kp = keyPoints.get(taskId);
    const kpUsable = !!kp && kp.goal === goal.trim();
    if (kp && !kpUsable) staleTextSkipped += 1;

    return {
      taskId,
      goal,
      // HuggingFace is authoritative; a hand-resolved URL only fills a gap.
      startUrl: meta.startUrl ?? override,
      urlSource: meta.startUrl ? 'huggingface' : (override ? 'manual' : null),
      taskTextSource: meta.goal ? 'huggingface' : 'human_label',
      referenceLength: meta.referenceLength ?? null,
      level: meta.level ?? null,
      keyPointsStatus: kpUsable ? 'pinned' : 'regenerate',
      keyPointsSource: kpUsable ? kp.source : null,
      humanLabels: row
        ? Object.fromEntries(
          AGENTS.map((a) => [a, row[`${a}_human_label`]]).filter(([, v]) => v != null),
        )
        : {},
    };
  });

  const pinned = tasks.filter((t) => t.keyPointsStatus === 'pinned').length;
  const labelled = tasks.filter((t) => Object.keys(t.humanLabels).length).length;
  console.log(`Task text from: ${hf.available ? 'HuggingFace (live)' : 'human_label.json (snapshot)'}`);
  console.log(`  key points pinned ${pinned}/${tasks.length}`
    + `${staleTextSkipped ? ` (${staleTextSkipped} dropped: task text was revised upstream)` : ''}`);
  console.log(`  human labels attached ${labelled}/${tasks.length}`);

  // --- Screen -------------------------------------------------------------
  const { eligible: screened, excluded } = screen(tasks);
  let eligible = screened;
  const flagged = eligible.filter((t) => t.advisories.length).length;
  console.log(`\nScreened: ${eligible.length} eligible (${flagged} carry an advisory), ${excluded.length} excluded.`);

  // --- Probe --------------------------------------------------------------
  if (doProbe && eligible.length) {
    console.log(`Probing ${eligible.length} start URLs (concurrency ${concurrency})…`);
    const results = await mapLimit(eligible, concurrency, (t) => probe(t.startUrl));
    const kept = [];
    eligible.forEach((t, i) => {
      const r = results[i];
      t.probe = r;
      if (r.ok) kept.push(t);
      else {
        excluded.push({
          taskId: t.taskId, goal: t.goal, startUrl: t.startUrl,
          rule: 'unreachable', ruleVersion: 1, detail: r.reason, status: r.status ?? null,
        });
      }
    });
    console.log(`  reachable: ${kept.length}, dropped: ${eligible.length - kept.length}`);
    eligible = kept;
  }

  // --- Select -------------------------------------------------------------
  // Stratify on the benchmark's own difficulty label when we have it, so the
  // subset mirrors the benchmark's mix rather than whatever hash order lands on.
  const stratifyBy = eligible.some((t) => t.level) ? 'level' : null;
  const { selected, excluded: lateExcluded, domains } =
    select(eligible, { target, perDomainCap, stratifyBy });
  excluded.push(...lateExcluded);

  // --- Emit ---------------------------------------------------------------
  const byRule = {};
  for (const e of excluded) byRule[e.rule] = (byRule[e.rule] ?? 0) + 1;

  const manifest = {
    schema: 'lykn.eval.mind2web.manifest/1',
    generatedAt: new Date().toISOString(),
    source: {
      repo: fetched.repo,
      commit: fetched.commit,
      hf: hf.available ? { repo: 'osunlp/Online-Mind2Web', sha: fetched.hf?.sha ?? null } : null,
      manualUrls: urlsFile ?? null,
    },
    selection: {
      target, perDomainCap, probed: doProbe, stratifiedBy: stratifyBy,
      totalTasks: tasks.length, eligible: eligible.length, selected: selected.length,
      domains: domains.size,
      order: 'ascending sha256(task_id)',
    },
    review: {
      state: selected.length ? 'pending' : 'empty',
      note: 'Every task below is decision:"propose". The runner executes only '
          + 'decision:"include". Promoting a task is a human act — read the goal, '
          + 'confirm the start URL is the site the benchmark meant, and confirm the '
          + 'task commits nothing.',
      reviewedBy: null,
      reviewedAt: null,
    },
    rules: RULES.map((r) => ({ id: r.id, version: r.version, why: r.why }))
      .concat(lateRules({ perDomainCap, target })),
    advisories: ADVISORIES,
    exclusionCounts: byRule,
    tasks: selected.map((t) => ({
      decision: 'propose',
      taskId: t.taskId,
      goal: t.goal,
      startUrl: t.startUrl,
      urlSource: t.urlSource,
      domain: t.domain,
      referenceLength: t.referenceLength,
      level: t.level,
      taskTextSource: t.taskTextSource,
      advisories: t.advisories ?? [],
      keyPointsStatus: t.keyPointsStatus,
      keyPointsSource: t.keyPointsSource,
      humanLabels: t.humanLabels,
      probe: t.probe ? { status: t.probe.status ?? null, finalUrl: t.probe.finalUrl ?? null } : null,
    })),
    excluded,
  };

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Key points for ALL 300 tasks — cheap, and useful whatever the subset is.
  const kpPath = path.join(REPO_ROOT, 'eval', 'mind2web', 'keypoints.v1.json');
  await writeFile(kpPath, `${JSON.stringify({
    schema: 'lykn.eval.mind2web.keypoints/1',
    note: 'Reference key points from the published WebJudge runs, pinned so all four '
        + 'arms are scored against byte-identical text. Without this the scorer '
        + 'regenerates them per trajectory and the arms differ by noise.',
    source: { repo: fetched.repo, commit: fetched.commit },
    only: 'Entries whose task text is byte-identical to the current benchmark. '
        + 'Tasks revised upstream are deliberately ABSENT so the scorer falls back '
        + 'to generating key points rather than scoring against a rewritten task.',
    keyPoints: Object.fromEntries(
      tasks.filter((t) => t.keyPointsStatus === 'pinned')
        .map((t) => [t.taskId, keyPoints.get(t.taskId).keyPoints]),
    ),
    // Also keyed by task TEXT, because the upstream scorer's
    // identify_key_points() receives only the task string — it never sees the
    // id. Keying on the text is self-validating besides: if a task is revised
    // upstream the lookup simply misses and the scorer generates fresh key
    // points, which is exactly the behaviour a rewritten task needs.
    byTask: Object.fromEntries(
      tasks.filter((t) => t.keyPointsStatus === 'pinned')
        .map((t) => [t.goal.trim(), keyPoints.get(t.taskId).keyPoints]),
    ),
  }, null, 2)}\n`);

  // --- Report -------------------------------------------------------------
  const accounted = selected.length + excluded.length;
  const mix = {};
  for (const t of selected) mix[t.level ?? '(none)'] = (mix[t.level ?? '(none)'] ?? 0) + 1;
  console.log(`\nSelected ${selected.length}/${target} across ${domains.size} domains`
    + `${stratifyBy ? `, stratified by ${stratifyBy}: ${JSON.stringify(mix)}` : ''}.`);
  console.log(`Accounted for ${accounted}/${tasks.length} tasks.`);
  console.log('\nExclusions by rule:');
  for (const [rule, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${rule}`);
  }
  console.log(`\nWrote ${path.relative(REPO_ROOT, outPath)}`);
  console.log(`Wrote ${path.relative(REPO_ROOT, kpPath)} (${pinned} tasks with verified-current key points)`);

  if (!hf.available && !overrides.size) {
    console.log('\n  No start URLs, so every task was excluded as no_start_url.');
    console.log('  The benchmark records them in the HuggingFace dataset, which is');
    console.log('  gated:"auto" — self-serve, granted the moment you accept:');
    console.log('    https://huggingface.co/datasets/osunlp/Online-Mind2Web');
    console.log('  then: HF_TOKEN=hf_… node scripts/eval/mind2web-fetch.mjs');
    console.log('  Or supply hand-resolved URLs with --urls <{taskId: url} json>.');
  } else if (selected.length < target) {
    console.log(`\n  Only ${selected.length} of the requested ${target} tasks survived screening.`);
    console.log('  Raise --cap, supply more URLs, or relax a rule and re-run to see the diff.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
