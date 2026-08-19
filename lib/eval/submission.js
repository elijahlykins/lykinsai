// ============================================================================
// lib/eval/submission.js — render a harness result as an Online-Mind2Web v2
//                          submission, blinded
// ============================================================================
// Pure: takes a result record, returns the object that becomes result.json.
// Split out from the CLI because the blinding is the part that has to be
// right, and it is only testable if it is a function.
//
// WHY BLINDING IS NOT COSMETIC
// ----------------------------
// The judge scores four arms on the same tasks. If it can tell which arm it is
// looking at, its verdict can drift with that knowledge, and the whole
// comparison rests on the assumption that it cannot. The obvious leaks — arm
// id, model name, file path — are easy. The one that matters is the ACTION
// VOCABULARY: refs mode aims by element reference and holo mode by coordinate,
// so a raw trajectory reads "click e12" in one arm and "click_coord x=… y=…" in
// the other. That is a perfect arm fingerprint sitting in the text the judge
// reads most carefully. Both are rendered here into one grammar.
// ============================================================================

/** Verbs the upstream schema accepts, keyed by our internal action type. */
const VERB = {
  navigate: 'NAVIGATE',
  click: 'CLICK',
  click_coord: 'CLICK',
  type: 'TYPE',
  type_coord: 'TYPE',
  drag: 'CLICK',
  select: 'SELECT',
  replace_text: 'TYPE',
  scroll: 'SCROLL',
  press_key: 'PRESS_KEY',
  go_back: 'GO_BACK',
  go_forward: 'GO_FORWARD',
  refresh: 'REFRESH',
  extract: 'WAIT',
  wait: 'WAIT',
};

/** Verbs whose target is the page rather than an element. */
const PAGE_VERBS = new Set(['NAVIGATE', 'SCROLL', 'WAIT', 'GO_BACK', 'GO_FORWARD', 'REFRESH', 'PRESS_KEY']);

const clean = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Articles and adjectives a grounding model puts in front of what it names. */
const LEADING_FILLER_RE =
  /^\W*(?:the|a|an|this|that|its)\s+/i;

/** Nouns a description appends that a DOM label never carries. */
const TRAILING_CONTROL_RE =
  /\s+(?:button|link|icon|control|tab|toggle|field|box|input|dropdown|menu|option|checkbox|element)s?\W*$/i;

/**
 * Converge the two arms' ways of naming the same control.
 *
 * refs mode reports the element's own DOM label — "Show results". holo mode
 * reports the description the grounder wrote — "the Show results button". Both
 * name the same control, but the phrasing is a systematic difference: across a
 * whole run every holo step reads like a sentence and every refs step like a
 * DOM string, which is an arm fingerprint sitting in the text the judge reads
 * most closely. Peeling the article and the trailing control noun collapses
 * both to "Show results".
 *
 * Deliberately conservative — it removes framing, not content. Emitting no
 * label at all would blind the arms perfectly and also stop the judge
 * understanding the trajectory, which is worse for everyone.
 */
export function normalizeTargetLabel(label) {
  let out = clean(label, 90);
  if (!out) return '';
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(LEADING_FILLER_RE, '');
    if (next === out) break;
    out = next;
  }
  out = out.replace(TRAILING_CONTROL_RE, '');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * One step as a Grammar A action string.
 *
 * Coordinates are used as the target for BOTH arms — refs resolves them from
 * the element it clicked, holo from the point it grounded to. Using a selector
 * for one and coords for the other would re-introduce exactly the fingerprint
 * this function exists to remove.
 */
export function renderAction(step) {
  if (!step) return 'WAIT page -> no action recorded';
  if (step.action === 'FINAL_STATE') return 'WAIT page -> final state of the page after the run';

  const a = step.action;
  if (!a || typeof a !== 'object') return 'WAIT page -> observing the page';

  const type = String(a.type || '').toLowerCase();
  const verb = VERB[type] || 'WAIT';
  const label = normalizeTargetLabel(step.target?.label || a.label || '');
  const x = step.target?.x;
  const y = step.target?.y;

  const target = PAGE_VERBS.has(verb)
    ? 'page'
    : (Number.isFinite(x) && Number.isFinite(y) ? `coords(${x}, ${y})` : 'page');

  let desc;
  switch (verb) {
    case 'NAVIGATE': desc = 'direct navigation to the destination page'; break;
    case 'CLICK': desc = label ? `click ${label}` : 'click the target element'; break;
    case 'TYPE': desc = `enter ${clean(a.text, 60) ? `"${clean(a.text, 60)}"` : 'text'}${label ? ` into ${label}` : ''}`; break;
    case 'SELECT': desc = `select ${clean(a.value, 40) || 'an option'}${label ? ` from ${label}` : ''}`; break;
    case 'SCROLL': desc = `scroll ${clean(a.direction, 20) || 'down'} on the page`; break;
    case 'PRESS_KEY': desc = `press ${clean(a.key, 20) || 'a key'}`; break;
    case 'GO_BACK': desc = 'return to the previous page'; break;
    case 'GO_FORWARD': desc = 'go forward to the next page'; break;
    case 'REFRESH': desc = 'reload the current page'; break;
    default: desc = label ? `observe ${label}` : 'observe the page'; break;
  }

  // The schema's own shape: page verbs read "page -> VERB -> desc", element
  // verbs read "VERB target -> desc".
  const head = PAGE_VERBS.has(verb) ? `page -> ${verb} -> ${desc}` : `${verb} ${target} -> ${desc}`;

  // WAIT is a pure observation and takes no status.
  if (verb === 'WAIT') return head;
  const status = step.status === 'SUCCESS' || step.status === 'FAILED' ? step.status : 'FAILED';
  return `${head} | ${status}`;
}

/**
 * Build the v2 submission object for one task attempt.
 *
 * `reference_length` is required by the schema and is a property of the
 * benchmark task, never of the attempt — the scorer does not read it, but
 * substituting the submitted step count would be a quiet lie in a published
 * format, so a missing value falls back to 1 (the schema minimum) rather than
 * to something that looks meaningful.
 */
export function buildSubmission(result, { referenceLength = null } = {}) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];

  // Only steps with a real screenshot can go in: the schema requires the file
  // to exist and to sort into step order, and a judge shown a step with no
  // evidence is being invited to score on the narrative alone.
  const usable = steps.filter((s) => s && typeof s.screenshot === 'string' && s.screenshot);

  const answer = clean(result?.answer, 2000);
  const actionHistory = usable.map((s, i) => ({
    step: i,
    screenshot: s.screenshot,
    url: s.url ?? null,
    action: renderAction(s),
    action_status: (() => {
      const rendered = renderAction(s);
      if (!/\| (SUCCESS|FAILED)$/.test(rendered)) return null;
      return rendered.endsWith('| SUCCESS') ? 'SUCCESS' : 'FAILED';
    })(),
    thought: s.thought ? clean(s.thought, 500) : null,
  }));

  // The terminal step carries the answer, and the schema wants the same text in
  // agent_final_answer. Appended only when the run actually produced one.
  if (answer && actionHistory.length) {
    const last = actionHistory[actionHistory.length - 1];
    last.action = `TASK_COMPLETE -> ANSWER: ${answer}`;
    last.action_status = null;
  }

  return {
    schema_version: 'online-mind2web-v2',
    task: String(result?.goal ?? ''),
    task_id: String(result?.taskId ?? ''),
    agent_final_answer: answer || null,
    reference_length: Number.isInteger(referenceLength) && referenceLength >= 1 ? referenceLength : 1,
    action_history: actionHistory,
  };
}

/** Identifiers that must never appear in anything the judge reads. */
export function blindingTerms({ arms = [], models = [] } = {}) {
  return [
    ...arms,
    ...models,
    'groundingMode', 'grounding_mode',
    'luna', 'gemini', 'opus', 'holo', 'claude', 'gpt-',
    'click_coord', 'type_coord',
    'refs mode', 'holo mode',
  ].filter(Boolean).map((t) => String(t).toLowerCase());
}

/**
 * Find arm-identifying text in an assembled submission.
 *
 * Returns the offending terms rather than a boolean so a failure says what
 * leaked and from where. Run against every payload before it is judged: a
 * blinding scheme nobody tested is a blinding scheme that does not work.
 */
export function findLeaks(submission, terms) {
  const hay = JSON.stringify(submission).toLowerCase();
  const found = new Set();
  for (const t of terms) {
    if (!t) continue;
    if (hay.includes(t)) found.add(t);
  }
  return [...found];
}

/**
 * Schema conformance checks the scorer will otherwise fail on silently.
 *
 * Returns a list of problems; empty means the submission is well-formed.
 */
export function validateSubmission(sub) {
  const errs = [];
  if (sub?.schema_version !== 'online-mind2web-v2') errs.push('schema_version must be online-mind2web-v2');
  if (!sub?.task) errs.push('task is empty');
  if (!sub?.task_id) errs.push('task_id is empty');
  if (!/^[A-Za-z0-9_-]+$/.test(String(sub?.task_id ?? ''))) errs.push('task_id has characters the schema forbids');
  if (!Number.isInteger(sub?.reference_length) || sub.reference_length < 1) errs.push('reference_length must be an integer >= 1');

  const hist = sub?.action_history;
  if (!Array.isArray(hist) || hist.length < 1) {
    errs.push('action_history must have at least one step');
    return errs;
  }
  const names = [];
  hist.forEach((s, i) => {
    if (s.step !== i) errs.push(`step ${i}: step index must equal its position`);
    if (!s.action) errs.push(`step ${i}: action is empty`);
    if (!('thought' in s)) errs.push(`step ${i}: thought must be present (may be null)`);
    if (!/^(\d{4}|\d+_full_screenshot_\d+)\.(png|jpg|jpeg|webp)$/.test(String(s.screenshot ?? ''))) {
      errs.push(`step ${i}: screenshot "${s.screenshot}" does not match the schema pattern`);
    } else {
      names.push(s.screenshot);
    }
    if (s.action_status != null && !/\| SUCCESS$|\| FAILED$/.test(s.action)) {
      errs.push(`step ${i}: action_status set but the action string has no matching suffix`);
    }
  });

  // The schema's own $comment: filenames must sort lexicographically into step
  // order. Zero-padding gives us that, and this asserts it rather than trusting
  // it — an off-by-one in padding silently reorders the evidence.
  const sorted = [...names].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(names)) {
    errs.push('screenshot filenames do not sort lexicographically into step order');
  }
  return errs;
}
