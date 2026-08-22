/**
 * Turning a browse run's action history into something a user can read.
 *
 * This is the "## What I did" list under a finished browser task, and the one
 * rule it has is that nothing internal may appear in it. Element references
 * ("e4", "e11") are the agent's own addressing scheme for a page — minted per
 * snapshot, meaningless to anyone reading the summary, and a direct window into
 * how the agent sees a page. They were reaching users, because the adapter that
 * maps the modular runtime's history onto the legacy shape put the reference
 * into the `label` field and this formatter renders `${verb}: ${label}`:
 *
 *     - Clicked: e4
 *     - Opened
 *     - Clicked: e11
 *
 * Both halves of that are wrong. The clicks named an internal reference, and the
 * navigation named nothing at all, because the fallback chain never looked at
 * the action's URL even though the adapter carries it.
 *
 * So labels come from `humanLabel`, which reads only fields that hold words a
 * person wrote or a page displayed, and refuses anything shaped like a
 * reference. A line with no human label degrades to the bare verb ("Opened a
 * page") rather than inventing one — being vague is a much smaller failure than
 * leaking internals.
 *
 * The legacy loop has always put real labels in this field ("Cancel", "Document
 * body", a CTA's text), so this module is a no-op for that history and a repair
 * for the modular runtime's.
 */

/**
 * An element reference as the snapshot builder mints them: `e` plus digits.
 * Anchored — a real label that merely starts with "e" ("email", "e2e tests")
 * must survive.
 */
const ELEMENT_REF_RE = /^e\d+$/i;

/** Verb for a line, from the action type. */
function verbFor(rawType) {
  const type = String(rawType || "act").toLowerCase();
  if (/click_coord|tap_coord|press_click|click|tap/.test(type)) return "Clicked";
  // Before the typing group: `replace_text` is an edit of existing content, and
  // "Typed: <the whole field>" misdescribes it.
  if (/replace_text/.test(type)) return "Edited";
  if (/os_write|write|type|fill|paste|click_type/.test(type)) return "Typed";
  if (/navigate|open|goto/.test(type)) return "Opened";
  if (/scroll/.test(type)) return "Scrolled";
  if (/select/.test(type)) return "Chose";
  if (/press_key|key/.test(type)) return "Pressed a key";
  if (/extract|read/.test(type)) return "Read the page";
  return String(rawType || "Act").replace(/_/g, " ");
}

/** Hostname of a URL, without www, or "" if it isn't one. */
function hostOf(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/**
 * What this action touched, in words a user can read.
 *
 * Order matters. `action.label` is the only field that is *meant* to hold a
 * human description — the decision schema requires the model to fill it for
 * coordinate clicks and drags, since a coordinate has no element to name, and
 * the legacy loop fills it from the control it matched. `result.label` is what
 * the actuator reports it actually hit. `action.value` is a typed or selected
 * value, which is the user's own words. A URL host is the last resort and the
 * only sensible description of a navigation.
 *
 * Anything that comes back looking like an element reference is discarded
 * rather than shown.
 *
 * @returns {string} a display label, or "" when nothing safe describes it
 */
function humanLabel(entry) {
  const action = entry?.action || {};
  const candidates = [action.label, entry?.result?.label, action.value];
  for (const candidate of candidates) {
    const text = String(candidate ?? "").replace(/\s+/g, " ").trim();
    if (!text || ELEMENT_REF_RE.test(text)) continue;
    return text.slice(0, 72);
  }
  return hostOf(action.url);
}

/**
 * The "## What I did" list.
 *
 * Only successful actions appear: a failed click that the agent recovered from
 * is noise in a summary of what got done. Consecutive duplicates collapse, and
 * the list is capped so a 30-round run does not bury its own answer.
 *
 * @param {Array} history legacy-shape entries: {action:{type,label,value,url}, result:{ok}}
 * @param {{max?: number}} [opts]
 * @returns {string} markdown bullets, or "" when there is nothing to show
 */
function formatBrowseWorkLog(history, { max = 8 } = {}) {
  const acts = (Array.isArray(history) ? history : []).filter((h) => h?.result?.ok);
  const lines = [];
  const seen = new Set();
  for (const entry of acts) {
    const verb = verbFor(entry?.action?.type);
    const label = humanLabel(entry);
    // "Opened" alone reads as an unfinished sentence; the others stand up as
    // bare verbs because the verb IS the whole fact ("Scrolled").
    const line = label ? `${verb}: ${label}` : verb === "Opened" ? "Opened a page" : verb;
    const key = line.toLowerCase();
    if (!line || seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${line}`);
    if (lines.length >= max) break;
  }
  return lines.join("\n");
}

module.exports = {
  formatBrowseWorkLog,
  humanLabel,
  hostOf,
  verbFor,
  ELEMENT_REF_RE,
};
