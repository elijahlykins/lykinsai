// ============================================================================
// lib/eval/runPlan.js — unit ordering, resume, and chunking for the harness
// ============================================================================
// Pure logic, no I/O, so the ordering guarantees can be tested. They are not
// cosmetic: the order units run in decides whether the four arms are comparable
// at all.
// ============================================================================

/** Stable identity of one (task, arm) unit. */
export function unitKey(u) {
  return `${u.taskId}::${u.arm}`;
}

/** Registrable-ish host, used only to space same-site visits apart. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Expand tasks × arms into units, INTERLEAVED — every arm sees a task before
 * any arm moves on to the next one.
 *
 * Running one arm to completion and then the next is the obvious ordering and
 * the wrong one: live sites change, so arm 1 on Monday versus arm 4 on Thursday
 * bakes three days of the internet moving into what is supposed to be a model
 * comparison. Interleaving spreads that drift evenly across all arms, where it
 * becomes noise instead of bias. Execution is still strictly serial — one task
 * in flight — only the order changes.
 */
export function buildUnits(tasks, arms) {
  const units = [];
  for (const t of tasks) {
    for (const a of arms) {
      units.push({
        taskId: t.taskId,
        goal: t.goal,
        startUrl: t.startUrl,
        level: t.level ?? null,
        referenceLength: t.referenceLength ?? null,
        arm: a.id,
        grounding: a.grounding,
      });
    }
  }
  return units;
}

/**
 * Units still to run.
 *
 * `done` is derived from results.jsonl, which is the only resume state — there
 * is no second ledger that can disagree with what actually happened.
 */
export function pendingUnits(units, done) {
  const has = done instanceof Set
    ? (k) => done.has(k)
    : (k) => done.has?.(k) ?? false;
  return units.filter((u) => !has(unitKey(u)));
}

/** Split into fixed-size chunks; each becomes one fresh Electron process. */
export function chunkUnits(units, size) {
  const n = Math.max(1, Number(size) || 1);
  const out = [];
  for (let i = 0; i < units.length; i += n) out.push(units.slice(i, i + n));
  return out;
}

/**
 * Parse results.jsonl into a map of completed units.
 *
 * Tolerates a torn final line, which is the normal state of a file that was
 * being appended to when a process was killed.
 */
export function parseResults(text) {
  const done = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r?.type === 'result' && r.taskId && r.arm) done.set(unitKey(r), r);
  }
  return done;
}
