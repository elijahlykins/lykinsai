/**
 * Page/screen change detection for the ⌘L browser agent. Given two snapshots
 * (text + interactable items + a perceptual screen fingerprint), describe what
 * changed so the planner can verify its last action and decide what to do next.
 */

const CHECK_BUTTON_RE = /^check(\s|$|\b)/i;
const ADVANCE_BUTTON_RE =
  /next question|next in course|^next$|continue|finish|done|got it|see results|keep going|start over|next exercise|go to dashboard|^go on$/i;

function pageSignature(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function questionSignature(text) {
  return pageSignature(
    String(text || "")
      .replace(/\b(choice|check|next|correct|incorrect|try again|don'?t worry|got it)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function pageShowsWrongFeedback(text) {
  return /try again|not quite|incorrect|that'?s not right|wrong answer|hmm,? not|not the best choice|the correct answer was|that is not correct|give it another|nice try,? but|almost!?|missed this one|review (the|this)|reread the/i.test(
    String(text || ""),
  );
}

function pageShowsCorrectFeedback(text) {
  return /correct!?|nice!?|great job|well done|that'?s right|you got it|awesome|good work|on a roll|way to go|keep it up|nice work|you'?re on a roll|that'?s correct|perfect!?|exactly right/i.test(
    String(text || ""),
  );
}

function pageShowsEncouragementOverlay(text) {
  return /don'?t worry|you can do this|let'?s (try|keep)|not to worry|getting there|keep practicing|we'?ll get there|everyone makes mistakes|take your time|you'?ve got this|learning takes time|mistakes help us learn/i.test(
    String(text || ""),
  );
}

function itemHasLabel(items, re) {
  return (Array.isArray(items) ? items : []).some((it) => re.test(String(it?.label || "").trim()));
}

function snapshotFlags(items, pageText) {
  const text = String(pageText || "");
  return {
    hasCheck: itemHasLabel(items, CHECK_BUTTON_RE),
    hasNext: itemHasLabel(items, ADVANCE_BUTTON_RE),
    hasOverlay: pageShowsEncouragementOverlay(text),
    hasCorrect: pageShowsCorrectFeedback(text),
    hasWrong: pageShowsWrongFeedback(text),
  };
}

/**
 * Fraction of grid cells (0–1) that differ between two perceptual screen
 * fingerprints. The fingerprint is a comma-joined list of quantized grayscale
 * values (see screenFingerprint in browserAct). This is robust to JPEG noise /
 * cursor blink, unlike comparing a raw byte hash for equality.
 */
function screenDiffRatio(a, b) {
  if (!a || !b) return a === b ? 0 : 1;
  if (a === b) return 0;
  const pa = String(a).split(",");
  const pb = String(b).split(",");
  if (pa.length !== pb.length || pa.length < 16) return 1;
  let diff = 0;
  for (let i = 0; i < pa.length; i += 1) {
    if (Math.abs(Number(pa[i]) - Number(pb[i])) > 1) diff += 1;
  }
  return diff / pa.length;
}

/** Word-set Jaccard similarity (0–1) — how much two page texts overlap. */
function textSimilarity(a, b) {
  const words = (s) =>
    new Set(
      String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3),
    );
  const sa = words(a);
  const sb = words(b);
  if (!sa.size && !sb.size) return 1;
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union ? inter / union : 1;
}

/**
 * Classify a transition so the planner can be "intuitive" about it:
 *   none      — nothing changed (last action had no effect)
 *   modal     — a popup/overlay appeared on top of the same screen
 *   navigated — a substantially different screen (new page / new content)
 *   updated   — same screen, meaningful in-place change (feedback, new buttons)
 *   minor     — tiny change (a class toggled, selection highlighted)
 */
function classifyTransition(before, after, diff) {
  if (diff.gainedOverlay) return "modal";
  const anyChange = diff.textChanged || diff.screenChanged || diff.itemsChanged;
  if (!anyChange) return "none";
  // In-place feedback (new buttons appearing, a primary button consumed) means the
  // SAME screen changed state — check before the similarity heuristic.
  if (
    diff.gainedCorrectFeedback ||
    diff.gainedWrongFeedback ||
    diff.nextButtonAppeared ||
    diff.checkButtonGone
  ) {
    return "updated";
  }
  const sim = textSimilarity(before?.pageText, after?.pageText);
  if (diff.questionChanged || sim < 0.5) return "navigated";
  if (sim < 0.85) return "updated";
  return "minor";
}

function comparePageSnapshots(before, after) {
  const bText = String(before?.pageText || "");
  const aText = String(after?.pageText || "");
  const bFlags = before?.flags || snapshotFlags(before?.items, bText);
  const aFlags = after?.flags || snapshotFlags(after?.items, aText);
  const screenDiff = screenDiffRatio(before?.screenHash, after?.screenHash);
  const diff = {
    textChanged: (before?.pageSig || "") !== (after?.pageSig || ""),
    questionChanged: (before?.questionSig || "") !== (after?.questionSig || ""),
    // Perceptual: only count it as a real visual change if >2% of the grid cells
    // moved — ignores cursor blink, clock ticks, and JPEG noise.
    screenDiff,
    screenChanged: screenDiff > 0.02,
    itemsChanged: (before?.itemCount || 0) !== (after?.itemCount || 0),
    similarity: textSimilarity(bText, aText),
    gainedCorrectFeedback: !bFlags.hasCorrect && aFlags.hasCorrect,
    gainedWrongFeedback: !bFlags.hasWrong && aFlags.hasWrong,
    gainedOverlay: !bFlags.hasOverlay && aFlags.hasOverlay,
    checkButtonGone: bFlags.hasCheck && !aFlags.hasCheck,
    nextButtonAppeared: !bFlags.hasNext && aFlags.hasNext,
    overlayDismissed: bFlags.hasOverlay && !aFlags.hasOverlay,
  };
  diff.transition = classifyTransition(before, after, diff);
  return diff;
}

function formatPageDiff(diff) {
  if (!diff) return "";
  const parts = [];
  if (diff.transition === "navigated") parts.push("NEW SCREEN loaded — re-read everything");
  else if (diff.transition === "none") parts.push("nothing changed — last action had no effect");
  if (diff.gainedCorrectFeedback) parts.push("positive feedback appeared");
  if (diff.gainedWrongFeedback) parts.push("error/retry feedback appeared");
  if (diff.gainedOverlay) parts.push("popup appeared");
  if (diff.overlayDismissed) parts.push("popup dismissed");
  if (diff.nextButtonAppeared) parts.push("a continue/next button now visible");
  if (diff.checkButtonGone) parts.push("primary button consumed (submitted)");
  if (diff.questionChanged && diff.transition !== "navigated") parts.push("content changed");
  else if (diff.textChanged && !parts.length) parts.push("page text updated");
  if (diff.screenChanged && !parts.length) parts.push("screen visuals updated");
  if (!parts.length) parts.push("page looks unchanged — re-read carefully");
  return parts.join("; ");
}

module.exports = {
  pageSignature,
  questionSignature,
  snapshotFlags,
  comparePageSnapshots,
  formatPageDiff,
  screenDiffRatio,
  textSimilarity,
  classifyTransition,
};
