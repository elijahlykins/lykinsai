/**
 * Google Docs / Slides title-field policy.
 *
 * Writing a document and renaming it are different jobs. The title widget
 * ("Rename", "Untitled document") sits above the canvas, so a body write that
 * lands there, or a rename that the loop treats as a miss, types the same
 * string over and over into the filename.
 */

const TITLE_TARGET_RE_SOURCE =
  "rename|document name|document title|document filename|untitled document|untitled presentation|docs-title";
const TITLE_TARGET_RE = new RegExp(`\\b(?:${TITLE_TARGET_RE_SOURCE})\\b`, "i");
const GENERIC_TYPE_HINT_RE = /^(type|write|os_write|fill|input|click_type)$/i;
const BODY_HINT_RE = /document body|docs_editor|essay|page body|editor/i;
const SHORT_TITLE_MAX = 80;

function joinedLabels(...labels) {
  return labels
    .map((s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

function looksLikeDocsTitleTarget(...labels) {
  const text = joinedLabels(...labels);
  return !!text && TITLE_TARGET_RE.test(text);
}

function normWs(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function valueHoldsTyped(value, typed) {
  const needle = normWs(typed);
  if (!needle) return false;
  return normWs(value).includes(needle);
}

function valueHoldsTypedTwice(value, typed) {
  const needle = normWs(typed);
  if (!needle) return false;
  return normWs(value).split(needle).length - 1 >= 2;
}

/**
 * Should this type action go into the document body, even if the snapshot
 * named the title widget?
 *
 * A long payload aimed at "Rename" is an essay that missed the page, not a
 * filename. The title field cannot hold it, and typing it there is the loop.
 */
function docsTypeShouldTargetBody({ fieldHint = "", text = "", onCanvasEditor = false } = {}) {
  const hint = String(fieldHint || "").trim();
  const long = String(text || "").length > SHORT_TITLE_MAX;
  if (long && looksLikeDocsTitleTarget(hint)) return true;
  if (BODY_HINT_RE.test(hint)) return true;
  if (
    onCanvasEditor &&
    long &&
    (!hint || GENERIC_TYPE_HINT_RE.test(hint))
  ) {
    return true;
  }
  return false;
}

/**
 * After keystrokes went in and the Docs title widget still has focus.
 *
 * - Intentional rename (or a short name that already landed): done. Retrying
 *   appends the same name.
 * - Body write / long paste: undo the filename, then type into the page.
 */
function docsTitleAfterTypeDecision({
  preferDocsBody = false,
  hint = "",
  label = "",
  text = "",
  titleStillFocused = false,
  titleValue = "",
} = {}) {
  if (!titleStillFocused) return { action: "verify" };
  const typed = String(text || "");
  const titleTarget = looksLikeDocsTitleTarget(hint, label);
  const landed = valueHoldsTyped(titleValue, typed);
  const short = typed.length > 0 && typed.length <= SHORT_TITLE_MAX;

  if (titleTarget) {
    return { action: "succeed", via: "title_rename", verified: landed };
  }
  if (!preferDocsBody && short && landed) {
    return { action: "succeed", via: "title_landed", verified: true };
  }
  return { action: "undo_and_retry_body" };
}

/**
 * Skip a second insert when the title already holds the name once.
 * A doubled value means a prior retry already appended - clear, then type.
 */
function looksLikeDocBodyPayload(text) {
  const t = String(text || "");
  if (t.length > SHORT_TITLE_MAX) return true;
  if (/\n/.test(t)) return true;
  return (t.match(/[.!?]\s+\S/g) || []).length >= 2;
}

function historyTargetLabel(entry) {
  const a = entry?.action || {};
  return joinedLabels(entry?.targetLabel, a.label, a.target);
}

function countDocsTitleWrites(history = []) {
  return (Array.isArray(history) ? history : []).filter((entry) => {
    const type = String(entry?.action?.type || "");
    if (!/^(type|type_coord|replace_text)$/i.test(type)) return false;
    return looksLikeDocsTitleTarget(historyTargetLabel(entry));
  }).length;
}

const TITLE_ALREADY_SET_FACT =
  "The Rename / filename field has already been typed. Do NOT type into it again. " +
  "Put the document body in with paste_text. To change a passage in a Google Doc, " +
  "paste_text the revised body with mode replace - replace_text cannot see canvas text.";

/**
 * The loop keeps choosing type → Rename because it is the only named textbox
 * on a Docs page. Body writes must never go there, and a second title type
 * is the append loop the user sees.
 */
function rewriteDocsWriteAction(action, { targetLabel = "", history = [] } = {}) {
  const type = String(action?.type || "");
  if (!/^(type|type_coord|replace_text)$/i.test(type)) return null;
  const label = joinedLabels(targetLabel, action.label);
  if (!looksLikeDocsTitleTarget(label)) return null;
  const text = action.text ?? action.value ?? "";
  const prior = countDocsTitleWrites(history);

  if (looksLikeDocBodyPayload(text)) {
    return {
      action: {
        type: "paste_text",
        text: String(text),
        mode: type === "replace_text" || action.mode === "replace" ? "replace" : undefined,
      },
      reason: "title_held_body",
      fact: TITLE_ALREADY_SET_FACT,
    };
  }

  if (prior >= 2) {
    return { skip: true, reason: "title_already_attempted", fact: TITLE_ALREADY_SET_FACT };
  }

  if (type === "replace_text") {
    return {
      action: { type: "type", target: action.target, text: String(text), mode: "replace", label },
      reason: "title_force_replace",
    };
  }

  if (action.mode !== "replace") {
    return {
      action: { ...action, mode: "replace" },
      reason: "title_force_replace",
    };
  }
  return null;
}

function docsTitleRetypeGuard({ hint = "", label = "", currentValue = "", typed = "" } = {}) {
  if (!looksLikeDocsTitleTarget(hint, label) && !TITLE_TARGET_RE.test(normWs(currentValue))) {
    return { skip: false, clear: false };
  }
  if (!String(typed || "").trim()) return { skip: false, clear: false };
  if (valueHoldsTypedTwice(currentValue, typed)) return { skip: false, clear: true };
  if (valueHoldsTyped(currentValue, typed)) return { skip: true, clear: false };
  return { skip: false, clear: false };
}

module.exports = {
  TITLE_TARGET_RE_SOURCE,
  TITLE_TARGET_RE,
  SHORT_TITLE_MAX,
  looksLikeDocsTitleTarget,
  valueHoldsTyped,
  valueHoldsTypedTwice,
  docsTypeShouldTargetBody,
  docsTitleAfterTypeDecision,
  docsTitleRetypeGuard,
  looksLikeDocBodyPayload,
  countDocsTitleWrites,
  rewriteDocsWriteAction,
  TITLE_ALREADY_SET_FACT,
};
