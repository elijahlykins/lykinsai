/**
 * Which action sequences may run inside one model round.
 *
 * The agent decides one action per round and re-reads the page after each one.
 * That is correct when the result could change what to do next, and pure
 * overhead when it cannot: reading a long list costs one model round-trip per
 * scroll, and a 10-screen list burns half the round budget on scrolling.
 *
 * A batch is admissible only when every step in it is BOTH ref-free and
 * non-committing.
 *
 * The ref-free half is the load-bearing one. Element references are minted by
 * the snapshot taken before the round and resolve against that snapshot only;
 * after step 1 has run, every ref in the batch describes a page that no longer
 * exists. Refusing refs is therefore not a conservative nicety — it is the
 * property that makes a batch safe to plan in advance at all.
 *
 * The non-committing half keeps the safety gate honest. The gate judges
 * `decision.action`; if a later step could spend money, destroy data or deliver
 * something, it would run without ever being judged. So the batchable set holds
 * nothing that commits — `press_key` is excluded despite being ref-free,
 * because Enter submits forms.
 *
 * `extract` is excluded for a third reason: it is ref-free only in the sense
 * that a batch could omit the ref, and `controller.extract` has nothing to read
 * without one — `executeAction` dispatches `controller.extract(action.target)`,
 * which resolves an empty ref to `missing_target`. Reading a named field is
 * inherently a targeted act, so it stays its own round. Scrolling to make
 * content load still batches, and the observe that follows the batch reads the
 * whole document anyway.
 */

/** Most steps a batch may hold. Past this the page has usually moved on. */
const MAX_BATCH_STEPS = 6;

/**
 * Action types that may appear in a batch: ref-free, non-committing, and
 * meaningful when planned in advance.
 */
const BATCHABLE_ACTIONS = new Set([
  "scroll",
  "wait",
  "screenshot",
  "navigate",
  "go_back",
  "go_forward",
  "open_tab",
  "switch_tab",
  // Sweeping what a page put over itself names no element and commits nothing,
  // and the step it most often belongs after is `navigate`.
  "dismiss_overlay",
]);

/**
 * Fields that carry a target resolved against the pre-batch snapshot. Any of
 * them present makes the step unplannable, whatever its type.
 */
const TARGET_FIELDS = ["target", "to", "targetDescription", "x", "y", "toX", "toY"];

function hasTarget(step) {
  return TARGET_FIELDS.some((f) => {
    const v = step[f];
    return v !== undefined && v !== null && v !== "";
  });
}

/**
 * Decide whether a proposed sequence may run as one round.
 *
 * @param {object[]} steps
 * @returns {{steps: object[], admitted: boolean, reason: string}}
 */
function admitBatch(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { steps: [], admitted: false, reason: "no steps" };
  }
  if (steps.length === 1) {
    return { steps: [], admitted: false, reason: "a single step is not a batch" };
  }
  if (steps.length > MAX_BATCH_STEPS) {
    return {
      steps: [],
      admitted: false,
      reason: `${steps.length} steps exceeds the cap of ${MAX_BATCH_STEPS}`,
    };
  }
  for (const step of steps) {
    if (!step || typeof step !== "object") {
      return { steps: [], admitted: false, reason: "a step is not an object" };
    }
    const type = String(step.type || "").trim();
    if (!type) return { steps: [], admitted: false, reason: "a step is missing its type" };
    if (!BATCHABLE_ACTIONS.has(type)) {
      return {
        steps: [],
        admitted: false,
        reason: `${type} cannot be planned in advance — it must be its own round`,
      };
    }
    if (hasTarget(step)) {
      return {
        steps: [],
        admitted: false,
        reason: `${type} carries an element reference, which is meaningless after the first step runs`,
      };
    }
  }
  return { steps: [...steps], admitted: true, reason: "" };
}

/** One history/progress line for a whole batch. */
function describeBatch(steps) {
  const list = Array.isArray(steps) ? steps : [];
  return list
    .map((s) => {
      const type = String(s?.type || "?");
      if (type === "navigate" && s.url) return `navigate ${String(s.url).slice(0, 60)}`;
      if (type === "scroll") return `scroll ${s.direction === "up" ? "up" : "down"}`;
      if (type === "wait") return `wait ${Number(s.ms) || 800}ms`;
      return type;
    })
    .join(" → ");
}

module.exports = { MAX_BATCH_STEPS, BATCHABLE_ACTIONS, admitBatch, describeBatch };
