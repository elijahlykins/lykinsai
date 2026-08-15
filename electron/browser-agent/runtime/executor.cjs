/**
 * Executor — takes the current goal, plan, snapshot, history and relevant
 * instructions, and decides the single next action as structured output.
 *
 * Also classifies action risk, entirely from the page rather than the model's
 * own `risk` field. The model labels ordinary mid-flow buttons ("Confirm",
 * "Save", "Link account") as consequential, and trusting that meant tasks were
 * abandoned one click from done.
 */

const contextRouter = require("./contextRouter.cjs");
const taskState = require("./taskState.cjs");
const visionPolicy = require("./visionPolicy.cjs");
const { formatSnapshotForModel } = require("../browser/snapshot.cjs");

const ACTIONS_NEEDING_TARGET = new Set(["click", "type", "replace_text", "select", "extract"]);

/** Action types that cannot commit anything the user would want to undo. */
const NON_COMMITTING_ACTIONS = new Set([
  "navigate",
  "scroll",
  "go_back",
  "go_forward",
  "extract",
  "wait",
  "screenshot",
  "open_tab",
  "switch_tab",
  "close_tab",
  // Dragging rearranges a document being composed; it delivers nothing.
  "drag",
]);

// Three outcomes are irreversible enough to be worth interrupting the user
// for: spending their money, destroying their data, and delivering something
// to an audience they did not ask for. Everything else — Confirm, Save,
// Continue, Connect, Link, Allow, Next, Finish, Done — is ordinary progress
// through a flow the user already requested, and pausing on it strands the
// task half-finished.
const SPENDS_MONEY_RE =
  /\b(place (?:your )?order|buy(?: it)? now|complete (?:purchase|order|booking)|confirm (?:and )?(?:pay|purchase|booking|order|reservation)|pay now|pay \$|checkout now|start (?:free |paid )?trial|subscribe now|upgrade plan|add funds|withdraw|transfer (?:money|funds)|donate|purchase)\b/i;

const DESTROYS_DATA_RE =
  /\b(delete|remove account|close account|deactivate|erase|wipe|empty (?:trash|bin)|permanently remove|cancel (?:my )?(?:order|subscription|plan|membership|reservation)|unsubscribe|revoke access)\b/i;

// Outbound = delivering content to other people. Judged on the control's own
// label, which is short and verb-led, so a stray "share" elsewhere in a long
// expected-outcome sentence cannot trip the gate.
const OUTBOUND_LABEL_RE =
  /^\W*(send|share|publish|post|invite|reply|forward|submit for review|blast)\b/i;

// Keyboard-shortcut sends have no button label at all — the expected outcome
// is the only evidence ("the message is sent").
const OUTBOUND_OUTCOME_RE =
  /\b(?:message|email|e-mail|reply|invite|invitation|post|campaign|newsletter)\s+(?:\w+\s+){0,2}(?:is|was|has been|gets?)\s+(?:sent|delivered|published|posted|shared)\b/i;

// An audience the user has to have named explicitly for a send to be in scope.
const MASS_AUDIENCE_RE =
  /\b(all (?:subscribers|contacts|clients|customers|members|users|recipients|leads)|entire (?:list|audience|database|contact list)|every(?:one|body)|whole list|full (?:list|audience)|\d{3,}\s*(?:recipients|contacts|subscribers))\b/i;

/** Does the user's own request ask for something to be delivered? */
const DELIVERY_INTENT_RE =
  /\b(send|sends|sending|share|shares|sharing|publish|publishes|publishing|post|posts|posting|invite|invites|inviting|forward|forwards|deliver|delivers|blast|announce|reply|replies|respond|responds|email|e-mail|mail|message|messages|dm|text)\b/i;

/** An explicit "prepare it but don't deliver it" instruction always wins. */
const DELIVERY_PROHIBITED_RE =
  /\b(?:do ?n[o']?t|do not|never|without|avoid|hold off on|no need to)\b[^.!?]{0,40}\b(send|sending|share|sharing|publish|publishing|post|posting|deliver|delivering)\b/i;

/** An unambiguous imperative to deliver — required for mass-audience sends. */
const EXPLICIT_SEND_VERB_RE =
  /\b(send|sends|sending|blast|deliver|delivers|publish|publishes|schedule (?:the )?(?:send|campaign)|fire off|shoot (?:it |them )?(?:out|off))\b/i;

/**
 * "prep an email", "draft a post", "set up the campaign" — the request is for
 * the artifact, not its delivery. Without this, the noun ("an email") reads as
 * delivery intent and a prepared campaign would go out to the whole list.
 */
const PREPARE_ONLY_RE =
  /\b(prep|prepare|prepping|draft|drafts|drafting|compose|composes|composing|write up|set ?up|setting up|stage|queue|mock up|put together|get (?:it |them |this )?ready)\b/i;

async function decideNext({
  model,
  task,
  snapshot,
  memoryContext = {},
  recovering = false,
  recoveryHint = "",
  lastVerification = null,
  screenshotDataUrl = "",
  visionHint = "",
}) {
  const lastAction = task.recentActions[task.recentActions.length - 1]?.action || {};
  const system = contextRouter.buildDecisionSystem({
    task,
    skills: task.skills,
    browserModules: contextRouter.routeBrowserModules({
      lastActionType: lastAction.type || "",
      recovering,
      tabCount: snapshot?.tabs?.length || 1,
      formsLikely: snapshot?.elements?.some((e) => ["textbox", "combobox", "searchbox"].includes(e.role)),
      goal: task.goal,
      url: snapshot?.url || "",
      hasDrawnSurface: visionPolicy.countDrawnSurfaces(snapshot) > 0,
      hasEmbeddedFrame: snapshot?.elements?.some((e) => !!e.frameHost),
    }),
    safetyModules: contextRouter.routeSafetyModules(task.goal),
    userMemory: memoryContext.userMemory || "",
    websiteMemory: memoryContext.websiteMemory || "",
  });

  const userParts = [
    `TASK STATE:\n${taskState.formatTaskForModel(task)}`,
    `RECENT ACTIONS:\n${taskState.formatHistoryForModel(task)}`,
  ];
  if (lastVerification) {
    userParts.push(
      `LAST VERIFICATION: ${lastVerification.success ? "success" : "FAILED"} — ${
        lastVerification.evidence || lastVerification.reason || ""
      }`,
    );
  }
  if (recovering) {
    userParts.push(
      `RECOVERY MODE: the previous approach failed. ${recoveryHint || "Find another way to make progress; do not repeat the failed action unchanged."}`,
    );
  }
  userParts.push(`CURRENT BROWSER STATE:\n${formatSnapshotForModel(snapshot)}`);
  if (screenshotDataUrl) {
    userParts.push(
      [
        "A screenshot of the current page is attached." +
          (visionHint ? ` It is attached because ${visionHint}.` : ""),
        "Read it as the authoritative view of what is on screen. When something " +
          "you need is visible in the image but absent from the element list, act " +
          "on it with click_coord or drag using x/y in 0-1000 of the image " +
          "(0,0 top-left; 1000,1000 bottom-right). Prefer an element reference " +
          "whenever one exists — coordinates are for what the DOM cannot describe.",
      ].join(" "),
    );
  }
  userParts.push("Decide the next structured step now.");

  const decision = await model.decide({
    system,
    user: userParts.join("\n\n"),
    imageUrl: screenshotDataUrl || undefined,
  });

  return normalizeDecision(decision, snapshot);
}

function coordPairValid(x, y) {
  const nx = Number(x);
  const ny = Number(y);
  return (
    Number.isFinite(nx) && Number.isFinite(ny) && nx >= 0 && nx <= 1000 && ny >= 0 && ny <= 1000
  );
}

/** A drag end is valid as a known element ref or as screenshot coordinates. */
function validEndpoint(snapshot, ref, x, y) {
  const wanted = String(ref || "").trim();
  if (wanted && (!snapshot || snapshot.byRef.has(wanted))) return true;
  return coordPairValid(x, y);
}

function normalizeDecision(decision, snapshot) {
  if (decision.kind === "act") {
    const action = decision.action || {};
    const type = String(action.type || "").trim();
    if (!type) {
      return { ...decision, kind: "invalid", invalidReason: "action missing type" };
    }
    if (ACTIONS_NEEDING_TARGET.has(type)) {
      const ref = String(action.target || "").trim();
      if (!ref) {
        return { ...decision, kind: "invalid", invalidReason: `${type} requires a target reference` };
      }
      if (snapshot && !snapshot.byRef.has(ref)) {
        return { ...decision, kind: "invalid", invalidReason: `unknown element reference ${ref}` };
      }
    }
    if (type === "navigate" && !String(action.url || "").trim()) {
      return { ...decision, kind: "invalid", invalidReason: "navigate requires url" };
    }
    if (type === "replace_text" && !String(action.find || "").trim()) {
      return { ...decision, kind: "invalid", invalidReason: "replace_text requires `find` (the exact existing snippet)" };
    }
    if (type === "click_coord" && !coordPairValid(action.x, action.y)) {
      return {
        ...decision,
        kind: "invalid",
        invalidReason: "click_coord requires x and y between 0 and 1000 (read off the screenshot)",
      };
    }
    if (type === "drag") {
      const hasSource = validEndpoint(snapshot, action.target, action.x, action.y);
      const hasTarget = validEndpoint(snapshot, action.to, action.toX, action.toY);
      if (!hasSource) {
        return {
          ...decision,
          kind: "invalid",
          invalidReason: "drag requires a source: either target (an element ref) or x/y screenshot coords",
        };
      }
      if (!hasTarget) {
        return {
          ...decision,
          kind: "invalid",
          invalidReason: "drag requires a destination: either `to` (an element ref) or toX/toY screenshot coords",
        };
      }
    }
  }
  if (decision.kind === "finish" && !decision.answer) {
    return { ...decision, kind: "invalid", invalidReason: "finish requires answer" };
  }
  if (decision.kind === "ask_user" && !decision.question) {
    return { ...decision, kind: "invalid", invalidReason: "ask_user requires question" };
  }
  return decision;
}

/**
 * Which irreversible outcome, if any, this action would commit — determined
 * from the page itself, not from the model's self-report. The model routinely
 * labels ordinary mid-flow buttons ("Confirm", "Save", "Link account") as
 * consequential; honoring that would abandon the task at the last step.
 *
 * @returns {"money"|"destructive"|"outbound"|""}
 */
function consequenceKind(decision, snapshot) {
  const action = decision.action || {};
  const type = String(action.type || "");
  if (!type || NON_COMMITTING_ACTIONS.has(type)) return "";
  const el = snapshot?.byRef?.get(String(action.target || ""));
  const label = String(el?.label || "").trim();
  const outcome = String(decision.expectedOutcome || "");

  if (SPENDS_MONEY_RE.test(label) || SPENDS_MONEY_RE.test(outcome)) return "money";
  if (DESTROYS_DATA_RE.test(label) || DESTROYS_DATA_RE.test(outcome)) return "destructive";
  if (OUTBOUND_LABEL_RE.test(label) || OUTBOUND_OUTCOME_RE.test(outcome)) return "outbound";
  return "";
}

/**
 * Read/navigation actions and ordinary writes run autonomously. Only an
 * action carrying a real irreversible consequence is "consequential".
 */
function classifyActionRisk(decision, snapshot) {
  const type = String(decision.action?.type || "");
  if (NON_COMMITTING_ACTIONS.has(type)) return "read";
  return consequenceKind(decision, snapshot) ? "consequential" : "low";
}

/**
 * Whether the user's own request authorizes this irreversible action.
 *
 * Money and data destruction always need an interactive yes. Delivering
 * content is authorized when the request asked for delivery — except to a
 * mass audience, which needs an unmistakable send instruction, so "prep a
 * campaign to all our clients" stops at the draft instead of mailing the list.
 */
function goalAuthorizesAction(goal, decision, snapshot) {
  const kind = consequenceKind(decision, snapshot);
  if (!kind) return true;
  if (kind === "money" || kind === "destructive") return false;

  const text = String(goal || "");
  if (DELIVERY_PROHIBITED_RE.test(text)) return false;
  // A prepare-shaped ask with no send verb wants the artifact, not the send.
  if (PREPARE_ONLY_RE.test(text) && !EXPLICIT_SEND_VERB_RE.test(text)) return false;
  if (!DELIVERY_INTENT_RE.test(text)) return false;

  const el = snapshot?.byRef?.get(String(decision.action?.target || ""));
  const audience = `${el?.label || ""} ${decision.expectedOutcome || ""}`;
  if (MASS_AUDIENCE_RE.test(audience) && !EXPLICIT_SEND_VERB_RE.test(text)) return false;
  return true;
}

module.exports = {
  decideNext,
  normalizeDecision,
  classifyActionRisk,
  goalAuthorizesAction,
  consequenceKind,
};
