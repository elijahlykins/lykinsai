// Tests for the Online-Mind2Web manifest screening and selection.
//
// These cover the decisions that determine what the eval actually measures, so
// they are written against the real 300-task list wherever the assertion is
// about outcomes rather than mechanics.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  AUTH_HOST_RE, AUTH_PATH_RE, RULES,
  commandVerbs, registrableDomain, parseUrl, selectionKey, screen, select, apportion,
} from './mind2webManifest.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const HUMAN_LABEL = path.join(REPO_ROOT, 'eval/mind2web/cache/data/evaluation_results'
  + '/online_mind2web_evaluation_results/human_label.json');

const task = (goal, extra = {}) => ({ taskId: 'x', goal, startUrl: 'https://example.com', ...extra });

// ---------------------------------------------------------------------------
// commandVerbs — the reason the screen is not a substring match
// ---------------------------------------------------------------------------

test('commandVerbs takes the leading word of each clause, not every word', () => {
  assert.deepEqual([...commandVerbs('Find X and message the owner')], ['find', 'message']);
  assert.deepEqual([...commandVerbs('Book 4 tickets')], ['book']);
});

test('commandVerbs ignores denylisted words used as nouns', () => {
  // Every one of these is a real Online-Mind2Web task that a substring match
  // over the same verb list rejects.
  const nounCases = [
    'View the most recent job posting for a full-time pharmacy position in the US.',
    'Find discussions of the community and open one with the most replies on Flightaware.',
    'Show me community posts about pregnancy fever from the past 30 days.',
    'Find the latest 2 bed and 1.5+ bath apartment listing for rent in New York.',
    'Find a Single-Family House for Rent in Houston, TX with 1 bed.',
  ];
  for (const goal of nounCases) {
    const hit = RULES.find((r) => r.test(task(goal)));
    assert.equal(hit, undefined, `should not be excluded: ${goal}`);
  }
});

test('commandVerbs still catches the verb when the task commands it', () => {
  const verbCases = [
    ['Book 4 tickets in the upper for any Kevin Hart show in New York.', 'goal_command_verb'],
    ['Submit a request for vehicle registration renewal with title number X123456.', 'goal_command_verb'],
    ['Find a dog groomer within 100 miles of zip 10005 and message the owner.', 'goal_command_verb'],
  ];
  for (const [goal, rule] of verbCases) {
    assert.equal(RULES.find((r) => r.test(task(goal)))?.id, rule, goal);
  }
});

test('a goal that says it wants no login is not excluded for saying "login"', () => {
  const goal = 'Find and open an animal learning course on YouTube Kids for my '
    + '6-year-old without login in. As a parent born in 1992, I would prefer not to enable search.';
  assert.equal(RULES.find((r) => r.test(task(goal))), undefined);
});

test('"my trip" is not an account page but "my trips" is', () => {
  const generic = 'Tell me what identification I need to bring on my trip on Amtrak.';
  assert.equal(RULES.find((r) => r.test(task(generic))), undefined);
  const accountPage = 'Open my trips and show the next flight.';
  assert.equal(RULES.find((r) => r.test(task(accountPage)))?.id, 'goal_account_scoped');
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

test('each exclusion rule fires on a representative goal', () => {
  const cases = [
    ['goal_contains_contact_details', 'Check order 12345 with email 12345@gmail.com.'],
    ['goal_spends_money', 'I want to purchase an open-box Galaxy S25.'],
    ['goal_destroys_data', 'Delete the saved search on Zillow.'],
    ['goal_command_verb', 'Submit a request for renewal.'],
    ['goal_creates_account', 'Take a newsletter subscription for allergy updates.'],
    ['goal_account_scoped', 'Show my orders from last month.'],
  ];
  for (const [ruleId, goal] of cases) {
    assert.equal(RULES.find((r) => r.test(task(goal)))?.id, ruleId, goal);
  }
});

test('URL rules fire on start URLs, not on goals', () => {
  const g = 'Find the store hours.';
  assert.equal(RULES.find((r) => r.test({ taskId: 'x', goal: g, startUrl: null }))?.id, 'no_start_url');
  assert.equal(RULES.find((r) => r.test({ taskId: 'x', goal: g, startUrl: 'ftp://x.com' }))?.id, 'bad_start_url');
  assert.equal(RULES.find((r) => r.test({ taskId: 'x', goal: g, startUrl: 'https://login.acme.com' }))?.id, 'auth_start_url');
  assert.equal(RULES.find((r) => r.test({ taskId: 'x', goal: g, startUrl: 'https://acme.com/signup' }))?.id, 'auth_start_url');
  assert.equal(RULES.find((r) => r.test({ taskId: 'x', goal: g, startUrl: 'https://www.reddit.com/r/x' }))?.id, 'blocked_domain');
});

test('a delivery advisory flags a task without excluding it', () => {
  const { eligible, excluded } = screen([
    task('Show me community posts about pregnancy fever from the past 30 days.', { taskId: 'a' }),
  ]);
  assert.equal(excluded.length, 0);
  assert.deepEqual(eligible[0].advisories, ['delivery_intent']);
});

// ---------------------------------------------------------------------------
// Domain handling
// ---------------------------------------------------------------------------

test('registrableDomain strips www, keeps eTLD+1, and handles multi-part TLDs', () => {
  assert.equal(registrableDomain('https://www.gamestop.com/stores'), 'gamestop.com');
  assert.equal(registrableDomain('https://new.mta.info/'), 'mta.info');
  assert.equal(registrableDomain('https://shop.marks.co.uk/x'), 'marks.co.uk');
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('not a url'), '');
  assert.equal(registrableDomain(null), '');
});

test('parseUrl rejects non-http schemes', () => {
  assert.equal(parseUrl('file:///etc/passwd'), null);
  assert.equal(parseUrl('javascript:alert(1)'), null);
  assert.ok(parseUrl('https://example.com'));
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const many = (n, domain = (i) => `site${i}.com`) =>
  Array.from({ length: n }, (_, i) => ({
    taskId: `task-${i}`, goal: 'Find the store hours.',
    startUrl: `https://${domain(i)}/`, advisories: [],
  }));

test('selection is deterministic across runs', () => {
  const a = select(many(40), { target: 10, perDomainCap: 2 });
  const b = select([...many(40)].reverse(), { target: 10, perDomainCap: 2 });
  assert.deepEqual(a.selected.map((t) => t.taskId), b.selected.map((t) => t.taskId));
});

test('selection follows ascending sha256(task_id)', () => {
  const { selected } = select(many(40), { target: 10, perDomainCap: 2 });
  const keys = selected.map((t) => selectionKey(t.taskId));
  assert.deepEqual(keys, [...keys].sort());
});

test('the per-domain cap is enforced and the overflow is recorded', () => {
  const all = many(20, () => 'onesite.com');
  const { selected, excluded } = select(all, { target: 20, perDomainCap: 2 });
  assert.equal(selected.length, 2);
  assert.equal(excluded.filter((e) => e.rule === 'domain_cap').length, 18);
});

test('every eligible task is either selected or recorded as excluded', () => {
  const all = many(50);
  const { selected, excluded } = select(all, { target: 10, perDomainCap: 2 });
  assert.equal(selected.length + excluded.length, all.length);
  assert.equal(excluded.filter((e) => e.rule === 'over_target').length, 40);
});

// ---------------------------------------------------------------------------
// Drift detectors
// ---------------------------------------------------------------------------

test('the copied auth regexes still match electron/ownedBrowserAct.cjs', async () => {
  const src = await readFile(path.join(REPO_ROOT, 'electron/ownedBrowserAct.cjs'), 'utf8');
  for (const [name, ours] of [['AUTH_HOST_RE', AUTH_HOST_RE], ['AUTH_PATH_RE', AUTH_PATH_RE]]) {
    const m = src.match(new RegExp(`const ${name} =\\s*(/[\\s\\S]*?/[a-z]*);`));
    assert.ok(m, `${name} not found in ownedBrowserAct.cjs — the copy has lost its source`);
    assert.equal(
      m[1].replace(/\s+/g, ''),
      ours.toString().replace(/\s+/g, ''),
      `${name} has drifted from production. Re-copy it into lib/eval/mind2webManifest.js.`,
    );
  }
});

test('the risk screens are the shipping ones, not copies', () => {
  const executor = require(path.join(REPO_ROOT, 'electron/browser-agent/runtime/executor.cjs'));
  for (const name of ['SPENDS_MONEY_RE', 'DESTROYS_DATA_RE', 'DELIVERY_INTENT_RE']) {
    assert.ok(executor[name] instanceof RegExp, `executor.cjs must export ${name}`);
  }
  assert.equal(typeof executor.goalCommitsMoney, 'function');
});

test('goals are screened as prose, not as button labels', () => {
  const executor = require(path.join(REPO_ROOT, 'electron/browser-agent/runtime/executor.cjs'));
  // SPENDS_MONEY_RE reads a control label, where "$49.00" is a commitment tell.
  // A goal is a sentence, where a price is a filter. Screening goals with the
  // label pattern excluded 31 of these 300 tasks for saying "under $40".
  const browsing = [
    "Search for boys' infant pajamas below $40.",
    'Show houses for sale in Maryland with a maximum price of $60,000.',
    'Find a flight from Dublin to anywhere under $100 tomorrow.',
    'Add a $50 Uber gift card to the cart.',
    'Estimate the federal income tax I would owe on $158,500 of taxable income.',
  ];
  for (const goal of browsing) {
    assert.equal(executor.goalCommitsMoney(goal), false, goal);
  }
  const committing = [
    'I want to purchase an open-box Samsung Galaxy S25 Plus.',
    'Buy a pair of running shoes in size 10.',
    'Find a hotel in Rome and book it.',
    'Book a table at Nopa for Friday.',
  ];
  for (const goal of committing) {
    assert.equal(executor.goalCommitsMoney(goal), true, goal);
  }
});

// ---------------------------------------------------------------------------
// Against the real task list
// ---------------------------------------------------------------------------

test('screening the real 300 tasks is byte-stable', async (t) => {
  let human;
  try {
    human = JSON.parse(await readFile(HUMAN_LABEL, 'utf8'));
  } catch {
    t.skip('run scripts/eval/mind2web-fetch.mjs first');
    return;
  }
  assert.equal(human.length, 300);

  // Goal rules only — start URLs are absent until the HuggingFace file lands,
  // and no_start_url would otherwise swallow every result.
  const tasks = human.map((r) => ({
    taskId: r.task_id, goal: r.confirmed_task, startUrl: 'https://example.com',
  }));
  const { eligible, excluded } = screen(tasks);
  assert.equal(eligible.length + excluded.length, 300);

  const counts = {};
  for (const e of excluded) counts[e.rule] = (counts[e.rule] ?? 0) + 1;
  assert.deepEqual(counts, {
    goal_contains_contact_details: 3,
    goal_command_verb: 3,
    goal_spends_money: 1,
  });
});

test('parseUrl does not rewrite a non-http scheme into an http one', () => {
  // The bug this guards: prepending "https://" to a scheme-bearing string turns
  // "file:///etc/passwd" into the perfectly valid "https://file///etc/passwd".
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'ftp://x.com']) {
    assert.equal(parseUrl(bad), null, bad);
    assert.equal(registrableDomain(bad), '', bad);
  }
  // Scheme-less input is still normalised, including with a port.
  assert.equal(parseUrl('example.com').protocol, 'https:');
  assert.equal(parseUrl('example.com:8080/x').hostname, 'example.com');
});

test('a task with no instruction text is excluded, not silently selected', () => {
  // Regression: sourcing goals from one file and URLs from another left 60 HF
  // tasks with goal:"" — and an empty string matches no rule, so 9 of them were
  // proposed for a live run with no instruction at all.
  for (const goal of ['', '   ', null, undefined]) {
    assert.equal(
      RULES.find((r) => r.test({ taskId: 'x', goal, startUrl: 'https://example.com' }))?.id,
      'no_goal',
      JSON.stringify(goal),
    );
  }
  const { eligible, excluded } = screen([{ taskId: 'x', goal: '', startUrl: 'https://example.com' }]);
  assert.equal(eligible.length, 0);
  assert.equal(excluded[0].rule, 'no_goal');
});

// ---------------------------------------------------------------------------
// Stratified selection
// ---------------------------------------------------------------------------

test('apportion splits a target proportionally and sums exactly', () => {
  const q = apportion(new Map([['easy', 80], ['medium', 141], ['hard', 79]]), 72);
  assert.equal([...q.values()].reduce((a, b) => a + b, 0), 72);
  assert.deepEqual([...q].sort(), [['easy', 19], ['hard', 19], ['medium', 34]].sort());
});

test('apportion never over-allocates a stratum beyond its size', () => {
  const q = apportion(new Map([['a', 2], ['b', 100]]), 50);
  assert.ok(q.get('a') <= 2);
  assert.equal([...q.values()].reduce((a, b) => a + b, 0), 50);
});

test('apportion is stable when remainders tie', () => {
  const once = [...apportion(new Map([['a', 10], ['b', 10], ['c', 10]]), 11)];
  const again = [...apportion(new Map([['c', 10], ['b', 10], ['a', 10]]), 11)];
  assert.deepEqual(once.sort(), again.sort());
});

test('stratified selection mirrors the input mix', () => {
  const pool = [
    ...Array.from({ length: 80 }, (_, i) => ({ taskId: `e${i}`, goal: 'g', startUrl: `https://e${i}.com/`, level: 'easy' })),
    ...Array.from({ length: 141 }, (_, i) => ({ taskId: `m${i}`, goal: 'g', startUrl: `https://m${i}.com/`, level: 'medium' })),
    ...Array.from({ length: 79 }, (_, i) => ({ taskId: `h${i}`, goal: 'g', startUrl: `https://h${i}.com/`, level: 'hard' })),
  ];
  const { selected } = select(pool, { target: 72, perDomainCap: 2, stratifyBy: 'level' });
  assert.equal(selected.length, 72);
  const mix = {};
  for (const t of selected) mix[t.level] = (mix[t.level] ?? 0) + 1;
  assert.deepEqual(mix, { easy: 19, medium: 34, hard: 19 });
});

test('stratified selection still hits the target when a stratum is starved by the domain cap', () => {
  // All 60 "hard" tasks live on one domain, so the cap allows only 2 of them.
  const pool = [
    ...Array.from({ length: 60 }, (_, i) => ({ taskId: `h${i}`, goal: 'g', startUrl: 'https://one.com/', level: 'hard' })),
    ...Array.from({ length: 60 }, (_, i) => ({ taskId: `e${i}`, goal: 'g', startUrl: `https://e${i}.com/`, level: 'easy' })),
  ];
  const { selected, excluded } = select(pool, { target: 40, perDomainCap: 2, stratifyBy: 'level' });
  assert.equal(selected.length, 40, 'target must still be met');
  assert.equal(selected.filter((t) => t.level === 'hard').length, 2);
  assert.equal(selected.length + excluded.length, pool.length);
});

test('stratified selection is deterministic and still hash-ordered', () => {
  const pool = Array.from({ length: 60 }, (_, i) => ({
    taskId: `t${i}`, goal: 'g', startUrl: `https://s${i}.com/`, level: ['easy', 'medium', 'hard'][i % 3],
  }));
  const a = select(pool, { target: 20, perDomainCap: 2, stratifyBy: 'level' });
  const b = select([...pool].reverse(), { target: 20, perDomainCap: 2, stratifyBy: 'level' });
  assert.deepEqual(a.selected.map((t) => t.taskId), b.selected.map((t) => t.taskId));
  const keys = a.selected.map((t) => selectionKey(t.taskId));
  assert.deepEqual(keys, [...keys].sort());
});
