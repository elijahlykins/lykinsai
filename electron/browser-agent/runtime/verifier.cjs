/**
 * Verifier — determines whether an action's expected outcome actually
 * happened. Deterministic evidence first (URL changes, form values, page
 * diffs); the model is consulted only when determinism is inconclusive.
 * The agent must never assume success because a tool returned ok.
 */

const contextRouter = require("./contextRouter.cjs");
const { formatSnapshotForModel } = require("../browser/snapshot.cjs");
const visionPolicy = require("./visionPolicy.cjs");

/**
 * Some surfaces genuinely cannot report back. A design tool's canvas, a code
 * editor, a rendered email preview — the action lands, the pixels change, and
 * the DOM says nothing. Scoring that as a failure is worse than useless: it
 * sends the agent back through retry, find-equivalent and replan, undoing real
 * progress and burning the round budget on work it already did. These actions
 * are reported as done-but-unconfirmed so the agent moves on and confirms by
 * looking at the page instead.
 */
function unconfirmed(evidence) {
  return {
    success: true,
    unverified: true,
    evidence,
    reason: "",
    next: "continue",
    method: "deterministic",
  };
}

/** Did this action operate on something that cannot describe its own state? */
function targetIsOpaque(before, action) {
  const el = before?.byRef?.get?.(String(action?.target || ""));
  if (!el) return false;
  const tag = String(el.raw?.tag || "").toLowerCase();
  return tag === "canvas" || tag === "svg" || String(el.role || "") === "img";
}

/**
 * Is this page one whose real work surface is drawn rather than marked up?
 *
 * The test used to be "does the catalog contain any canvas or svg", which is a
 * whole-page latch on a signal almost every modern site emits — one chart, one
 * map, one accessible `<svg role="img">` icon, and every dead click on that
 * page scored as an unconfirmed success for the rest of the run. Failure
 * detection switched itself off on ordinary pages.
 *
 * A drawn surface is now something the action actually touched, a URL known to
 * be a visual editor, or a page that is mostly canvas and has almost nothing to
 * target by name — which is what "the DOM cannot describe this" really means.
 */
function actedOnDrawnSurface(before, after, action) {
  if (targetIsOpaque(before, action)) return true;
  if (visionPolicy.VISUAL_EDITOR_URL_RE.test(String(after?.url || ""))) return true;
  if (!visionPolicy.countDrawnSurfaces(after)) return false;
  // A coordinate gesture is only ever chosen when the element list could not
  // describe the target — so on a page that draws anything, those are the
  // actions whose effects a scrape genuinely cannot see.
  if (["click_coord", "type_coord", "drag"].includes(String(action?.type || ""))) return true;
  // Otherwise the page itself has to be mostly drawn: something is rendered and
  // there is almost nothing to target by name.
  return visionPolicy.countNamedControls(after) < 8;
}

/**
 * @returns {Promise<{success:boolean, evidence:string, reason:string, next:'continue'|'recover'|'replan', method:string}>}
 */
async function verifyOutcome({ model, decision, actionResult, before, after, diff, extracted = null, signal = null }) {
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
    let evidence = `${type} completed`;
    if (type === "extract" && actionResult) {
      const name = actionResult.label || action.target;
      // A checkbox or radio has no text value; `checked` is its whole state,
      // and reading only `value` reported every one of them as empty.
      if (actionResult.checked !== undefined && !String(actionResult.value || "").trim()) {
        evidence = `"${name}" is ${actionResult.checked ? "checked" : "unchecked"}`;
      } else if (actionResult.value != null) {
        evidence = `field "${name}" contains: "${String(actionResult.value).slice(0, 400)}"`;
      }
    }
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
    // Host equality, not substring: "consent.example.com" contains
    // "example.com", and reading that as arrival waved every same-family
    // redirect through as a success.
    if (!landedHost || (wantedHost && landedHost !== wantedHost)) {
      return {
        success: false,
        evidence: "",
        reason: `expected to land on ${action.url} but browser shows ${after?.url || "(blank)"}`,
        next: "recover",
        method: "deterministic",
      };
    }
    // Right host, wrong page. Sign-in, consent and CAPTCHA walls live on the
    // host you asked for, and calling them arrival is how the agent walks into
    // one and carries on as though it were logged in.
    const wall = wallPath(after?.url);
    if (wall && !wallPath(action.url)) {
      return {
        success: false,
        evidence: "",
        reason: `reached ${landedHost} but it served a ${wall} page (${after.url}) rather than the requested page`,
        next: "recover",
        method: "deterministic",
      };
    }
    return {
      success: true,
      evidence: `Browser is on ${after.url} ("${after.title}")`,
      reason: "",
      next: "continue",
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
    //
    // The whole typed string is checked, not a 40-character prefix. A prefix
    // check passes on the opening clause, so an editor that silently truncates
    // a long body reported the write as complete and the agent went on to send
    // half a message.
    const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    // Fields that format as you type — phone, card, date, currency — return
    // something that never matches character for character but is the correct
    // value. Comparing on alphanumerics alone is what tells a reformat apart
    // from a failure, and it is the difference between moving on and retyping
    // into a field that already holds the text.
    const alnum = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const typed = String(action.text || "");
    const value = String(extracted.value || "");
    if (typed && norm(value).includes(norm(typed))) {
      return {
        success: true,
        evidence: `field "${extracted.label}" now contains "${value.slice(0, 80)}"`,
        reason: "",
        next: "continue",
        method: "deterministic",
      };
    }
    if (typed && alnum(typed) && alnum(value).includes(alnum(typed))) {
      return {
        success: true,
        evidence: `field "${extracted.label}" holds the value reformatted as "${value.slice(0, 80)}" — this is the text you typed, do not type it again`,
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
    // Editors that never expose their value (code mirrors, canvas text, some
    // embedded rich-text widgets) cannot confirm the text landed. The actuator
    // says the keystrokes went in; calling that a failure makes the agent
    // retype and duplicate content.
    if (actionResult?.unverified) {
      return unconfirmed(
        `typed ${String(action.text || "").length} characters into "${extracted.label || action.target}" — ` +
          "this editor does not report its contents back, so confirm it visually before relying on it",
      );
    }
    if (!action.pressEnter) {
      // Say which failure it is. "Not found" reads as "nothing landed" and
      // invites a retype; truncation needs a different fix entirely, and
      // retyping into the field would append to what is already there.
      const truncated =
        alnum(value) && alnum(typed).startsWith(alnum(value)) && alnum(value).length < alnum(typed).length;
      return {
        success: false,
        evidence: "",
        reason: truncated
          ? `field "${extracted.label}" holds only the first ${value.length} of ${typed.length} characters — the editor truncated the text. Do NOT retype (it appends); clear the field or write it in smaller pieces.`
          : `field "${extracted.label}" contains "${value.slice(0, 60)}" — typed text not found`,
        next: "recover",
        method: "deterministic",
      };
    }
  }
  if (type === "type" && !extracted?.ok && actionResult?.unverified) {
    return unconfirmed(
      `typed ${String(action.text || "").length} characters — the field's contents are not readable back from this editor`,
    );
  }

  // A drop that rearranged the document shows up as new or moved elements.
  if (type === "drag" && diff && (diff.newLabels.length || diff.textChanged)) {
    return {
      success: true,
      evidence: `the drop changed the layout (${diff.summary})`,
      reason: "",
      next: "continue",
      method: "deterministic",
    };
  }

  // 3. Clear page change matching a stated expectation → cheap keyword check.
  //
  // Two things make this check trustworthy, and it had neither.
  //
  // It searched the whole page, so it matched vocabulary that was on the page
  // before the action — and an expected outcome is written in the page's own
  // words, so that is most of them. Only text the action actually introduced
  // counts now.
  //
  // And it could not read a negation. "Your message to Bob could not be sent"
  // contains message, sent and Bob, so a site's own error notice confirmed the
  // thing it was refusing to do. A page that reports a problem is never
  // deterministic evidence of success; it goes to the model to judge.
  const expectation = String(decision.expectedOutcome || "").trim();
  const somethingChanged =
    diff && (diff.urlChanged || diff.newLabels.length || diff.textChanged || diff.removedLabels.length);
  if (expectation && somethingChanged) {
    const fresh = newlyVisibleText(before, after);
    const arrived = diff.summary.replace(/\bGone:.*$/, "");
    // When the expectation is that something goes AWAY, what went away is the
    // evidence — otherwise dismissing a banner or deleting a row can never be
    // confirmed from the diff that plainly shows it happening.
    const departed = EXPECTS_DISAPPEARANCE_RE.test(expectation) ? diff.removedLabels.join(" ") : "";
    const hay = `${arrived} ${departed} ${after?.title || ""} ${fresh}`.toLowerCase();
    const keywords = significantKeywords(expectation);
    if (keywords.length && !PAGE_REPORTS_A_PROBLEM_RE.test(fresh)) {
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
  // Elements disappearing IS a change — dismissing a dialog, closing a banner
  // and deleting a row all leave nothing new behind, and scoring those as
  // "nothing happened" sent the agent to redo work it had already done.
  const nothingChanged =
    diff &&
    !diff.urlChanged &&
    !diff.titleChanged &&
    !diff.textChanged &&
    !diff.newLabels.length &&
    !diff.removedLabels.length;
  if (["click", "click_coord", "drag", "press_key"].includes(type) && nothingChanged) {
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
    // On a page that draws itself, "no DOM change" is the normal result of a
    // correct action, not evidence against it.
    if (actedOnDrawnSurface(before, after, action)) {
      return unconfirmed(
        `${type.replace("_", " ")} executed on a rendered surface, which reports no DOM change — ` +
          "check the attached screenshot next round to see whether it had the intended effect",
      );
    }
    // A modifier shortcut (bold, group, duplicate, undo) usually alters state
    // that no text scrape can see.
    if (type === "press_key" && Array.isArray(action.modifiers) && action.modifiers.length) {
      return unconfirmed(
        `sent ${action.modifiers.join("+")}+${action.key || "Enter"} — shortcut effects are often invisible to a page scrape`,
      );
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
      signal,
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

/** Sign-in, consent, rate-limit and CAPTCHA interstitials, by path. */
const WALL_PATHS = [
  [/\/(?:login|log-in|signin|sign-in|sign_in|auth|authorize|oauth|sso)(?:[/?#]|$)/i, "sign-in"],
  [/\/(?:consent|cookie|privacy-wall|gdpr)(?:[/?#]|$)/i, "consent"],
  [/\/(?:sorry|challenge|captcha|validatecaptcha|blocked|denied|errors?)(?:[/?#]|$)/i, "block or CAPTCHA"],
  [/\/(?:subscribe|paywall|register|signup|sign-up)(?:[/?#]|$)/i, "registration"],
];

function wallPath(url) {
  let path = "";
  try {
    const u = new URL(String(url || ""));
    path = `${u.pathname}${u.search}`;
  } catch {
    return "";
  }
  for (const [re, name] of WALL_PATHS) if (re.test(path)) return name;
  return "";
}

/**
 * The text this action put on the page. Confirming an expectation against text
 * that was already there confirms nothing.
 */
function newlyVisibleText(before, after) {
  const seen = new Set(
    String(before?.visibleText || "")
      .split(/[\n.!?]+/)
      .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
      .filter(Boolean),
  );
  return String(after?.visibleText || "")
    .split(/[\n.!?]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s && !seen.has(s.toLowerCase()))
    .join(". ")
    .slice(0, 3000);
}

/** An expectation whose whole point is that something stops being there. */
const EXPECTS_DISAPPEARANCE_RE =
  /\b(dismiss(?:ed|es)?|close[sd]?|closing|remov(?:e|ed|es)|delet(?:e|ed|es)|hidden|hide[sd]?|gone|disappears?|cleared?|collapse[sd]?|no longer)\b/i;

/** A page saying it went wrong. Never deterministic evidence of success. */
const PAGE_REPORTS_A_PROBLEM_RE =
  /\b(?:could ?n[o']?t|cannot|can ?not|can't|was ?n[o']?t|were ?n[o']?t|did ?n[o']?t|failed to|unable to|not able to|no longer able)\b|\b(?:error|failed|failure|denied|rejected|declined|invalid|required field|try again|something went wrong|unsuccessful|not permitted|not allowed|timed out|expired)\b/i;

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
