/**
 * Verifier — determines whether an action's expected outcome actually
 * happened. Deterministic evidence first (URL changes, form values, page
 * diffs); the model is consulted only when determinism is inconclusive.
 * The agent must never assume success because a tool returned ok.
 */

const contextRouter = require("./contextRouter.cjs");
const { formatSnapshotForModel } = require("../browser/snapshot.cjs");

/**
 * @returns {Promise<{success:boolean, evidence:string, reason:string, next:'continue'|'recover'|'replan', method:string}>}
 */
async function verifyOutcome({ model, decision, actionResult, before, after, diff, extracted = null }) {
  const action = decision.action || {};
  const type = String(action.type || "");

  // 1. The controller itself reported failure — no need to ask a model.
  if (actionResult && actionResult.ok === false) {
    return {
      success: false,
      evidence: "",
      reason:
        `browser action failed: ${actionResult.error || "unknown error"}` +
        (actionResult.hint ? ` — ${actionResult.hint}` : ""),
      next: actionResult.error === "stale_reference" || actionResult.error === "unknown_reference"
        ? "recover"
        : "recover",
      method: "deterministic",
    };
  }

  // 2. Deterministic successes for mechanical actions.
  if (["wait", "screenshot", "extract", "scroll"].includes(type)) {
    // Extracted content IS the point of the action — return it as evidence so
    // the model actually learns what the field contains.
    const evidence =
      type === "extract" && actionResult?.value != null
        ? `field "${actionResult.label || action.target}" contains: "${String(actionResult.value).slice(0, 400)}"`
        : `${type} completed`;
    return { success: true, evidence, reason: "", next: "continue", method: "deterministic" };
  }
  if (type === "replace_text") {
    // The controller's in-page script only reports ok when the replacement
    // actually landed in the DOM — that is the evidence.
    if (actionResult?.replaced) {
      return {
        success: true,
        evidence: `text replaced in place${actionResult.preview ? `: "…${String(actionResult.preview).slice(0, 120)}…"` : ""}`,
        reason: "",
        next: "continue",
        method: "deterministic",
      };
    }
    return {
      success: false,
      evidence: "",
      reason: "replacement not applied",
      next: "recover",
      method: "deterministic",
    };
  }
  if (type === "navigate") {
    const wantedHost = hostOf(action.url);
    const landedHost = hostOf(after?.url);
    if (landedHost && (!wantedHost || landedHost.includes(wantedHost) || wantedHost.includes(landedHost))) {
      return {
        success: true,
        evidence: `Browser is on ${after.url} ("${after.title}")`,
        reason: "",
        next: "continue",
        method: "deterministic",
      };
    }
    return {
      success: false,
      evidence: "",
      reason: `expected to land on ${action.url} but browser shows ${after?.url || "(blank)"}`,
      next: "recover",
      method: "deterministic",
    };
  }
  if (["go_back", "go_forward", "switch_tab", "open_tab", "close_tab"].includes(type)) {
    if (diff?.urlChanged || diff?.titleChanged || type === "close_tab") {
      return { success: true, evidence: diff.summary, reason: "", next: "continue", method: "deterministic" };
    }
  }
  if (type === "type" && extracted?.ok) {
    // Actual form value is the evidence — not the fact that a type action ran.
    // Compare with whitespace collapsed: rich-text editors (Gmail's body is
    // contenteditable divs) render "\n\n" back as "\n\n\n" etc., and a raw
    // substring check declared the typing failed when it had fully landed —
    // sending the agent into a retype loop that duplicated the content.
    const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const typed = String(action.text || "");
    const value = String(extracted.value || "");
    const needle = norm(typed.length <= 60 ? typed : typed.slice(0, 40));
    if (needle && norm(value).includes(needle)) {
      return {
        success: true,
        evidence: `field "${extracted.label}" now contains "${value.slice(0, 80)}"`,
        reason: "",
        next: "continue",
        method: "deterministic",
      };
    }
    // The re-read resolves the field by label in a fresh snapshot — on pages
    // with a hidden twin (same label, empty value) it reads the wrong node.
    // The actuator already did a strict named-field read at act time; when it
    // verified the text landed, trust it over a conflicting empty re-read.
    if (actionResult?.verified) {
      return {
        success: true,
        evidence: `typed text verified in "${extracted.label}" at act time (field re-read saw "${value.slice(0, 40)}")`,
        reason: "",
        next: "continue",
        method: "deterministic",
      };
    }
    if (!action.pressEnter) {
      return {
        success: false,
        evidence: "",
        reason: `field "${extracted.label}" contains "${value.slice(0, 60)}" — typed text not found`,
        next: "recover",
        method: "deterministic",
      };
    }
  }

  // 3. Clear page change matching a stated expectation → cheap keyword check.
  const expectation = String(decision.expectedOutcome || "").trim();
  if (expectation && diff && (diff.urlChanged || diff.newLabels.length || diff.textChanged)) {
    const hay = `${diff.summary} ${after?.title || ""} ${String(after?.visibleText || "").slice(0, 3000)}`.toLowerCase();
    const keywords = significantKeywords(expectation);
    if (keywords.length) {
      const hits = keywords.filter((k) => hay.includes(k));
      if (hits.length >= Math.max(1, Math.ceil(keywords.length / 2))) {
        return {
          success: true,
          evidence: `page changed as expected (${diff.summary}; matched: ${hits.join(", ")})`,
          reason: "",
          next: "continue",
          method: "deterministic",
        };
      }
    }
  }

  // 4. Nothing observable changed after an action that should change things.
  if (["click", "press_key"].includes(type) && diff && !diff.urlChanged && !diff.titleChanged && !diff.textChanged && !diff.newLabels.length) {
    // Clicking a text field to focus it legitimately changes nothing visible —
    // that is not a failure.
    const clicked = before?.byRef?.get?.(String(action.target || ""));
    if (type === "click" && clicked && /^(textbox|searchbox|combobox)$/.test(String(clicked.role || ""))) {
      return {
        success: true,
        evidence: `focused the "${clicked.label}" field`,
        reason: "",
        next: "continue",
        method: "deterministic",
      };
    }
    return {
      success: false,
      evidence: "",
      reason: "no observable page change after the action",
      next: "recover",
      method: "deterministic",
    };
  }

  // 5. Inconclusive — ask the model to judge from the evidence.
  const user = [
    `ACTION: ${JSON.stringify({ ...action, text: action.text ? String(action.text).slice(0, 120) : undefined })}`,
    `EXPECTED OUTCOME: ${expectation || "(none stated)"}`,
    `PAGE DIFF: ${diff?.summary || "(no diff)"}`,
    `CURRENT PAGE:\n${formatSnapshotForModel(after, { maxElements: 40, maxTextChars: 2500 })}`,
  ].join("\n\n");
  try {
    const verdict = await model.verify({
      system: contextRouter.buildVerificationSystem(),
      user,
    });
    return { ...verdict, method: "model" };
  } catch {
    // Verification call failed — be conservative: treat as unverified success
    // only when the page clearly changed, otherwise recover.
    const changed = diff && (diff.urlChanged || diff.textChanged || diff.newLabels.length);
    return {
      success: !!changed,
      evidence: changed ? diff.summary : "",
      reason: changed ? "" : "no evidence of change and verifier unavailable",
      next: changed ? "continue" : "recover",
      method: "fallback",
    };
  }
}

function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const STOPWORDS = new Set([
  "the", "a", "an", "should", "shows", "show", "page", "will", "would", "be", "is",
  "are", "with", "and", "or", "to", "of", "in", "on", "for", "open", "opens",
  "display", "displays", "displayed", "appear", "appears", "now", "contain", "contains",
]);

function significantKeywords(expectation) {
  return String(expectation)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .slice(0, 6);
}

module.exports = { verifyOutcome };
