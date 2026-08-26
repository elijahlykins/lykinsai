/**
 * Capability enforcement for browser tasks — in code, not in prompt.
 *
 * A canonical Task carries capability strings; this module turns them into the
 * set of action types the decision model is ALLOWED to produce. The set is
 * enforced three times, deliberately:
 *
 *   1. The decision schema's action enum is filtered to it, so a compliant
 *      model cannot even express a disallowed action.
 *   2. normalizeDecision rejects anything outside it, so a non-compliant
 *      output never reaches the safety gate or the actuator.
 *   3. The loop's executeAction refuses unknown types as it always has.
 *
 * Capability grammar:
 *   "browser"           — legacy blanket grant: read + navigate + interact.
 *   "browser.read"      — observation only: extract, wait, screenshot,
 *                          scroll, dismiss_overlay.
 *   "browser.navigate"  — moving between pages and tabs.
 *   "browser.interact"  — clicking, typing, editing, dragging, selecting.
 *   "browser.eval"      — reserved. No model-directed JS evaluation is exposed
 *                          today and none is granted by any other capability;
 *                          the name exists so that if an eval operation is
 *                          ever added, absence of this capability already
 *                          excludes it.
 */

const READ_ACTIONS = ["extract", "wait", "screenshot", "scroll", "dismiss_overlay"];
const NAVIGATE_ACTIONS = ["navigate", "go_back", "go_forward", "open_tab", "close_tab", "switch_tab"];
const INTERACT_ACTIONS = [
  "click",
  "click_coord",
  "type",
  "type_coord",
  "replace_text",
  "paste_text",
  "select",
  "drag",
  "press_key",
];

const CAPABILITY_ACTIONS = {
  "browser.read": READ_ACTIONS,
  "browser.navigate": NAVIGATE_ACTIONS,
  "browser.interact": INTERACT_ACTIONS,
};

/**
 * The action types a task's capabilities license.
 *
 * @param {string[]} capabilities capability strings from the canonical Task
 * @returns {Set<string>|null} allowed action types, or null when the task
 *   holds no browser capability at all (the executor must refuse to run it).
 */
function allowedActionTypes(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities.map(String) : [];
  const allowed = new Set();
  let any = false;
  for (const cap of caps) {
    if (cap === "browser") {
      any = true;
      for (const a of [...READ_ACTIONS, ...NAVIGATE_ACTIONS, ...INTERACT_ACTIONS]) allowed.add(a);
      continue;
    }
    const actions = CAPABILITY_ACTIONS[cap];
    if (actions) {
      any = true;
      for (const a of actions) allowed.add(a);
    }
  }
  return any ? allowed : null;
}

/** Does this capability set license element interaction (click/type/edit)? */
function allowsInteraction(allowedActions) {
  return !!allowedActions && allowedActions.has("click");
}

module.exports = {
  allowedActionTypes,
  allowsInteraction,
  READ_ACTIONS,
  NAVIGATE_ACTIONS,
  INTERACT_ACTIONS,
};
