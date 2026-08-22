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
const { formatSnapshotForModel } = require("../browser/snapshot.cjs");
const batchPolicy = require("./batch.cjs");

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
  // The sweeper will only ever click a control that dismisses — anything that
  // signs in, spends, subscribes, sends or deletes is refused in
  // browserOverlays.cjs, so there is nothing here for the gate to judge.
  "dismiss_overlay",
]);

// Three outcomes are irreversible enough to be worth interrupting the user
// for: spending their money, destroying their data, and delivering something
// to an audience they did not ask for. Everything else — Confirm, Save,
// Continue, Connect, Link, Allow, Next, Finish, Done — is ordinary progress
// through a flow the user already requested, and pausing on it strands the
// task half-finished.
//
// These patterns are matched against a SHORT control label, not against prose,
// so they can afford to be generous: an unnecessary pause costs one question,
// while a miss spends the user's money. The earlier versions were written as
// exact phrases ("place your order", "confirm and pay") and missed the labels
// products actually ship — "Order now", "Confirm & pay", "Submit order",
// "Buy with 1-Click" all sailed through unattended.
const SPENDS_MONEY_RE = new RegExp(
  [
    // Committing verbs. "Checkout" is deliberately absent: reaching checkout is
    // encouraged, and only the button on that page that actually charges is
    // consequential.
    "\\bbuy\\b",
    "\\bpurchase\\b",
    "\\bpre-?order\\b",
    "\\border\\s+now\\b",
    "\\b(?:place|submit|confirm|complete)\\s+(?:your\\s+|the\\s+|my\\s+)?(?:order|bid|purchase|payment|booking|reservation)\\b",
    "\\bplace\\s+bid\\b|\\bbid\\s+now\\b",
    // pay / money movement
    "\\bpay\\b",
    "\\bconfirm\\s+(?:and\\s+|&\\s*)?pay\\b",
    "\\b(?:add|withdraw|transfer|send)\\s+(?:funds|money|cash)\\b",
    "\\bdonate\\b",
    "\\btip\\b",
    // commitments that bill later
    "\\b(?:subscribe|resubscribe)\\b",
    "\\b(?:upgrade|renew)\\b",
    "\\bstart\\s+(?:free\\s+|paid\\s+)?trial\\b",
    // reserving commits money on most sites
    "\\b(?:book|reserve|rent)\\s+(?:now|it|this|table|room|flight)\\b",
    "\\bconfirm\\s+(?:booking|reservation)\\b",
    // a currency amount on a button is a commitment tell
    "[$£€¥]\\s?\\d",
  ].join("|"),
  "i",
);

const DESTROYS_DATA_RE = new RegExp(
  [
    // Bare forms that essentially always destroy.
    "\\b(?:delete|erase|wipe|shred|purge)\\b",
    "\\bdiscard\\b",
    "\\b(?:move\\s+to\\s+)?(?:trash|bin)\\b",
    "\\b(?:revoke|deactivate|terminate|overwrite|unshare|unsubscribe)\\b",
    "\\b(?:disconnect|unlink)\\b",
    "\\bdrop\\s+(?:table|database)\\b",
    // "Remove" needs an object: "Remove member" destroys, "Remove filter" does
    // not, and pausing on the second strands ordinary shopping and search.
    "\\bremove\\s+(?:member|user|person|collaborator|access|permission|account|device|card|payment\\s+method|file|files|record|records|photo|photos|everyone|all\\b)",
    "\\breplace\\s+file\\b",
    "\\bclear\\s+(?:all|everything|history|data)\\b",
    "\\breset\\s+(?:to\\s+)?(?:defaults?|settings|everything|all)\\b",
    "\\bclose\\s+account\\b",
    "\\bleave\\s+(?:workspace|organization|organisation|team|group|channel|server)\\b",
    "\\bcancel\\s+(?:my\\s+)?(?:order|subscription|plan|membership|reservation|booking)\\b",
  ].join("|"),
  "i",
);

/**
 * Labels that carry a committing word but only ever show you something:
 * "Order history", "Purchase details", "Payment methods". Without this the
 * broadened patterns above would pause the agent on a navigation link.
 */
const INFORMATIONAL_LABEL_RE =
  /\b(?:history|details?|summary|status|settings|preferences|methods?|options?|list|log|receipts?|invoices?|track(?:ing)?|view|see|show|manage|learn more|terms|policy|faq|help|about)\b/i;

/**
 * A label that OPENS with a committing verb is an action, whatever noun
 * follows it. Without this the exemption above reads "Delete history" and
 * "Remove payment method" as navigation, which is the exact inversion of what
 * it is for.
 */
// Only verbs that cannot also head a noun phrase. "Order history" and
// "Purchase details" are listings; "Delete history" and "Remove payment
// method" are not, and the difference is whether the first word can be a noun.
const LEADING_ACTION_VERB_RE =
  /^\W*(?:delete|remove|clear|reset|revoke|discard|cancel|erase|wipe|destroy|terminate|deactivate|disconnect|unlink|overwrite|trash|leave|drop|buy|pay|subscribe|upgrade|renew|donate|send|publish|invite)\b/i;

// Outbound = delivering content to other people. Judged on the control's own
// label, which is short and verb-led. NOT start-anchored: the button that
// actually commits a send is usually the second one, inside a confirmation
// dialog, and it is labelled "Confirm and send" or "Yes, send it" — anchoring
// to the start let exactly those through.
const OUTBOUND_LABEL_RE =
  /\b(send|sends|sending|share|shares|sharing|publish|publishes|post|posts|posting|invite|invites|reply|replies|forward|forwards|blast|broadcast|deliver|delivers|announce)\b/i;

// Keyboard-shortcut sends have no button label at all — the expected outcome
// is the only evidence ("the message is sent").
const OUTBOUND_OUTCOME_RE =
  /\b(?:message|email|e-mail|mail|reply|invite|invitation|post|campaign|newsletter|announcement|design|document|doc|file|folder|photo|video|album|link|report|draft)\s+(?:\w+\s+){0,3}(?:is|was|has been|will be|gets?)\s+(?:sent|delivered|published|posted|shared|emailed|broadcast|invited)\b/i;

/**
 * Labels that read as outbound but only open the composer or the dialog. The
 * un-anchored OUTBOUND_LABEL_RE above is deliberately broad, and without this
 * the agent would stop to ask before it had written anything.
 */
const OUTBOUND_LABEL_EXEMPT_RE =
  /^\W*(new|compose|write|create|draft|start)\b|\b(settings|options|preferences|history|log|list|report|analytics|template|draft(?:s)?)\s*$/i;

/**
 * A target described as somewhere you PUT something, not something that sends
 * it: "the Add people field in the FINAL sharing dialog", "the recipient input
 * at the top of the Share dialog".
 *
 * These arrive when a target is aimed by description rather than by element
 * reference — the description names the surrounding dialog, and the dialog is
 * often called Share. Judged by the short label of a button, "sharing" means
 * this click sends something; inside a sentence describing a text box it means
 * nothing of the kind. Without this the agent asked "want me to perform
 * click_coord?" before clicking into an empty text field, once per attempt.
 */
const TARGET_IS_A_FIELD_RE =
  /\b(field|input|textbox|text box|search ?box|combobox|entry box|address bar)\b/i;

/**
 * The label patterns above are broad because a button label is short. Prose is
 * not: an expected outcome like "the booking form opens" would trip a bare
 * /book/ and strand the task. So outcomes get their own patterns, shaped like
 * the passive completions a model actually writes.
 */
const MONEY_OUTCOME_RE =
  /\b(?:order|purchase|payment|booking|reservation|subscription|transfer|donation|trial|charge)\s+(?:\w+\s+){0,3}(?:is|was|has been|will be|gets?)\s+(?:placed|completed|confirmed|submitted|processed|charged|made|paid|started|activated)\b|\b(?:card|account|balance)\s+(?:is|was|will be|gets?)\s+(?:charged|debited|billed)\b/i;

const DESTRUCTIVE_OUTCOME_RE =
  /\b(?:item|items|file|files|folder|folders|document|documents|doc|docs|email|emails|message|messages|record|records|row|rows|photo|photos|video|videos|album|event|account|subscription|order|member|access|draft|page|post|campaign|list)\s+(?:\w+\s+){0,3}(?:is|are|was|were|has been|have been|will be|gets?)\s+(?:deleted|removed|erased|revoked|cancell?ed|trashed|wiped|destroyed|overwritten|discarded)\b/i;

/**
 * Enter inside a composer sends the thing; there is no button label to read.
 * Matched against the FIELD's label, so it is the field's own purpose talking.
 */
const SUBMITS_ON_ENTER_RE =
  /\b(message|chat|reply|comment|post|tweet|to|cc|bcc|recipient|recipients|send)\b/i;

// An audience the user has to have named explicitly for a send to be in scope.
const MASS_AUDIENCE_RE =
  /\b(all (?:subscribers|contacts|clients|customers|members|users|recipients|leads)|entire (?:list|audience|database|contact list)|every(?:one|body)|whole list|full (?:list|audience)|\d{3,}\s*(?:recipients|contacts|subscribers))\b/i;

/**
 * Does the user's own request ask for something to be delivered?
 *
 * The words below double as nouns, and reading a noun as intent is how a pure
 * lookup — "find Bob's email address" — came to pre-authorize a real Send
 * click. So noun usages are masked out of the text first (see
 * asksForDelivery); this pattern only ever sees what is left.
 */
const DELIVERY_INTENT_RE =
  /\b(send|sends|sending|share|shares|sharing|publish|publishes|publishing|post|posts|posting|invite|invites|inviting|forward|forwards|deliver|delivers|blast|announce|reply|replies|respond|responds|email|e-mail|mail|message|messages|dm|text)\b/i;

/** "my email", "Bob's message", "the post", "an e-mail address" — noun, not verb. */
const DELIVERY_NOUN_RE =
  /\b(?:my|your|their|his|her|our|its|the|a|an|this|that|these|those|each|any|some|no|another|\w+'s)\s+(?:\w+\s+){0,2}(?:e-?mails?|messages?|mail|posts?|texts?|dms?|invitations?|replies|reply)\b|\b(?:e-?mail|message|mail)\s+(?:address(?:es)?|account|inbox|thread|threads|history|id|client|app|folder|list)\b/i;

/** Strip noun usages so DELIVERY_INTENT_RE only ever judges verbs. */
function asksForDelivery(text) {
  const masked = String(text || "").replace(new RegExp(DELIVERY_NOUN_RE.source, "gi"), " ");
  return DELIVERY_INTENT_RE.test(masked);
}

/** An explicit "prepare it but don't deliver it" instruction always wins. */
const DELIVERY_PROHIBITED_RE =
  /\b(?:do ?n[o']?t|do not|never|without|avoid|hold off on|no need to)\b[^.!?]{0,40}\b(send|sending|share|sharing|publish|publishing|post|posting|deliver|delivering)\b/i;

/**
 * Does a user's REQUEST, in prose, ask for money to be committed?
 *
 * Separate from SPENDS_MONEY_RE because that one reads short control labels and
 * is generous by design — on a button, "$49.00" is a commitment tell. In a
 * sentence it is a filter: "search for boys' pajamas below $40" spends nothing.
 * Applying the label pattern to prose excluded 31 of 300 benchmark tasks that
 * were pure browsing. A goal commits money when it says so with a verb.
 */
const GOAL_SPENDS_MONEY_RE =
  /\b(?:(?<!\bbest\s)buy|buying|purchase|purchasing|pay for|paying for|check ?out|place (?:an|the|my) order|complete (?:the|my) (?:purchase|order|booking)|subscribe to|sign up for .{0,30}(?:plan|subscription)|donate|bid on|place a bid|pre-?order|order (?:me |us )?(?:a|an|the|some|\d)|book (?:a|an|the|my|us|me)|reserve (?:a|an|the|my|us|me)|rent (?:a|an|the)|top up|add funds|(?:buy|purchase|book|reserve|rent|order|pay for)\s+(?:it|them|this|that|one))\b/i;

/**
 * A goal whose verb is observational. It can mention a price, a booking or an
 * order and still commit nothing, so it overrides the pattern above.
 */
const GOAL_BROWSE_ONLY_RE =
  /^\W*(?:find|search|look (?:for|up)|browse|show|list|compare|filter|view|check|see|identify|locate|return|calculate|estimate|get (?:me )?(?:the|a) (?:price|quote|list|info)|read|summari[sz]e|what|which|how much|when|where|who)\b/i;

/** Filling a cart is preparation, whatever it costs. */
const GOAL_CART_ONLY_RE = /\badd\b[^.!?]{0,80}\bto (?:the |my |our )?(?:cart|basket|bag|wishlist|list)\b/i;

/** Would running this request, as written, commit the user's money? */
function goalCommitsMoney(goal) {
  const text = String(goal || "");
  if (!GOAL_SPENDS_MONEY_RE.test(text)) return false;
  if (GOAL_CART_ONLY_RE.test(text)) return false;
  // "Find a flight ... and book it" still commits; a leading search verb only
  // wins when nothing after it asks for the commitment.
  if (GOAL_BROWSE_ONLY_RE.test(text) && !/\b(?:and|then|,)\s+(?:buy|purchase|book|reserve|order|pay|check ?out|rent)\b/i.test(text)) {
    return false;
  }
  return true;
}

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
  // "refs" (default): targets are element references validated against the
  // snapshot. "holo": targets are natural-language descriptions that a
  // grounding stage resolves to coordinates after this call returns, so ref
  // validation here would reject every one of them as an unknown reference.
  // "assist": refs as normal, but this round may also describe its target.
  groundingMode = "refs",
  // This round only: the recovery ladder has escalated to pixels, so the model
  // may hand back a described target for the grounder to locate. Off by
  // default — describing a target that a reference already names is a paid
  // round-trip for a worse aim.
  assistGrounding = false,
  signal = null,
}) {
  // The system prompt is byte-stable across the task so providers can serve
  // it from prompt cache; everything that varies — memory included — goes in
  // the user message, which changes every round regardless.
  const system = contextRouter.buildDecisionSystem({
    task,
    skills: task.skills,
  });

  const memoryBlock = contextRouter.buildMemoryContext(memoryContext);
  const userParts = [
    ...(memoryBlock ? [memoryBlock] : []),
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
  if (assistGrounding) {
    userParts.push(
      [
        "TARGETING RESCUE (this round only): element references have failed repeatedly on this step.",
        "If what you need is visible in the screenshot but you cannot name it with a reference from the",
        "element list, put a description of it in `targetDescription` instead of `target` — what it looks",
        'like and where it sits ("the blue Publish button in the top-right of the toolbar") — and it will be',
        "located on the image for you. Keep using `target` whenever a reference genuinely matches; describe",
        "only what the element list cannot express. `select`, `replace_text` and `extract` still need a real",
        "reference and cannot be described.",
      ].join(" "),
    );
  }
  userParts.push("Decide the next structured step now.");

  const decision = await model.decide({
    system,
    user: userParts.join("\n\n"),
    imageUrl: screenshotDataUrl || undefined,
    signal,
  });

  return normalizeDecision(decision, snapshot, { groundingMode, assistGrounding });
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

function normalizeDecision(decision, snapshot, { groundingMode = "refs", assistGrounding = false } = {}) {
  // Screen any proposed batch before anything else, so every exit below —
  // including the invalid ones — carries a decision whose `steps` is either
  // admitted or absent. An inadmissible batch is never a failed round: it
  // degrades to its first action, which is the one the safety gate judges.
  let batchRejected = "";
  if (Array.isArray(decision.steps) && decision.steps.length) {
    const first = decision.steps[0];
    if (decision.kind !== "act") {
      batchRejected = "only an act decision may carry steps";
      decision = { ...decision, steps: null };
    } else if (String(first?.type || "") !== String(decision.action?.type || "")) {
      batchRejected = "the first step must be the same action as `action`";
      decision = { ...decision, steps: null };
    } else {
      const admitted = batchPolicy.admitBatch(decision.steps);
      if (admitted.admitted) {
        decision = { ...decision, steps: admitted.steps };
      } else {
        batchRejected = admitted.reason;
        decision = { ...decision, steps: null };
      }
    }
  } else if (decision.steps !== null && decision.steps !== undefined) {
    decision = { ...decision, steps: null };
  }
  if (batchRejected) decision = { ...decision, batchRejected };
  const describesTarget = groundingMode === "holo";
  if (decision.kind === "act") {
    let action = decision.action || {};
    const type = String(action.type || "").trim();
    if (!type) {
      return { ...decision, kind: "invalid", invalidReason: "action missing type" };
    }
    // A described target is only meaningful on a round that invited one. The
    // field lives in the schema permanently, so a model that reaches for it
    // unprompted would otherwise route an ordinary action through a grounding
    // call nobody asked for — and skip reference validation on the way.
    let described = String(action.targetDescription || "").trim();
    if (described && !assistGrounding) {
      const { targetDescription: _ignored, ...rest } = action;
      action = rest;
      described = "";
      decision = { ...decision, action };
    }
    if (ACTIONS_NEEDING_TARGET.has(type)) {
      const ref = String(action.target || "").trim();
      if (!ref && !described) {
        return {
          ...decision,
          kind: "invalid",
          invalidReason: describesTarget
            ? `${type} requires a description of the target`
            : `${type} requires a target reference`,
        };
      }
      // In holo mode the grounding stage decides whether the described target
      // exists; it can see the screen and this function cannot. The same is
      // true of an assist round's description — but a reference it supplies
      // alongside one is still a reference, and still has to be real.
      if (!describesTarget && !described && snapshot && !snapshot.byRef.has(ref)) {
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
      const hasSource = describesTarget
        ? !!String(action.target || "").trim()
        : validEndpoint(snapshot, action.target, action.x, action.y);
      const hasTarget = describesTarget
        ? !!String(action.to || "").trim()
        : validEndpoint(snapshot, action.to, action.toX, action.toY);
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
/**
 * What the action is aimed at, in words.
 *
 * A ref-based click gets its label from the snapshot. A coordinate click has no
 * ref at all, so the label regexes below had nothing to read and every
 * `click_coord` scored as harmless — on exactly the canvas and builder surfaces
 * where coordinate clicking is the only method available. The decision contract
 * now asks the model to name what it is clicking in `action.label`, and the
 * grounder writes the same field, so both paths have a description.
 */
function targetLabel(decision, snapshot) {
  const action = decision.action || {};
  const el = snapshot?.byRef?.get(String(action.target || ""));
  return String(el?.label || action.label || "").trim();
}

/** Roles that hold other controls. Their label is everyone else's text. */
const CONTAINER_ROLE_RE =
  /^(menu|menubar|listbox|list|group|region|toolbar|tablist|tree|grid|table|form|navigation|document|main|dialog)$/i;

/**
 * Verbs that name an action a control might commit. Counted, not matched: one
 * of them is a button, several of them is a menu.
 */
const ACTION_WORD_RE =
  /\b(download|rename|share|shared|sharing|delete|remove|move|trash|organize|automation|information|copy|duplicate|print|open|edit|star|send|publish|post|invite|buy|purchase|pay|subscribe|cancel|export|manage)\b/gi;

/**
 * Is this label the name of ONE control, or the contents of a container?
 *
 * A container's accessible name is the text of everything inside it, so a
 * right-click menu came through as "Download Rename ⌥⌘E Set up an automation
 * Share Organize Folder information Move to trash Delete" — which contains
 * Share, Move to trash and Delete, and so read as a click that shares and
 * deletes at once. The agent asked permission to open a menu, quoting the menu
 * back at the user, who has no idea which of those words the gate reacted to.
 *
 * Counting distinct action words separates the two cleanly: a button says one
 * thing ("Send", "Move to trash"), a menu lists many. Deliberately not a
 * length test — a described target ("the blue Send button at the bottom of the
 * compose window") is long and is exactly the click that must still be caught.
 */
function isSingleControlLabel(label, role) {
  const text = String(label || "").trim();
  if (!text) return false;
  if (CONTAINER_ROLE_RE.test(String(role || ""))) return false;
  const found = text.match(ACTION_WORD_RE) || [];
  const distinct = new Set(found.map((w) => w.toLowerCase()));
  return distinct.size <= 2;
}

/**
 * The action opens the UI for something rather than doing it: the Share menu
 * item that raises the share dialog, "Invite people" that opens the invite
 * panel, the compose button.
 *
 * Judged on the agent's own account of what it expects, which is the one
 * reliable statement of intent available before the click. Opening a share
 * dialog commits nothing — the control INSIDE it does — and asking the user to
 * approve reaching a dialog spends their attention on a step that changes
 * nothing, so that when a real send arrives they are already used to saying
 * yes. Anything that mentions delivering as well ("the invite is sent") does
 * not qualify, so a control that opens and sends in one go is still caught.
 */
const OPENS_UI_OUTCOME_RE =
  /\b(?:dialog|modal|panel|menu|window|sheet|drawer|popup|pop-up|composer|editor|form|screen|options|settings|sidebar)\b[^.]{0,40}\b(?:opens?|opened|appears?|appeared|shows?|shown|is displayed|becomes visible|expands?)\b|\b(?:opens?|opening|shows?|displays?|reveals?|brings? up|launch(?:es)?)\b[^.]{0,40}\b(?:dialog|modal|panel|menu|window|sheet|drawer|popup|pop-up|composer|editor|form|options|settings)\b/i;

/** Words that mean something actually went out or was destroyed. */
const COMMITS_ANYWAY_RE =
  /\b(?:sent|sends|sending|delivered|shared with|published|posted|invited|emailed|deleted|removed|charged|paid|placed|purchased|submitted)\b/i;

/**
 * Controls whose name leaves no room for interpretation. "Share" opens a
 * dialog in one product and posts to the world in another, so what the agent
 * expects to happen decides it — but nothing called Send or Delete gets to be
 * excused as merely opening something. If such a button really does raise a
 * confirmation step, one extra question is the correct price.
 */
const STRONG_COMMIT_LABEL_RE =
  /^\W*(?:send|delete|remove|erase|wipe|trash|discard|destroy|pay|buy|purchase|order now|place (?:your |the |my )?order|confirm (?:and |& )?pay|unsubscribe|revoke|deactivate)\b/i;

function consequenceKind(decision, snapshot) {
  const action = decision.action || {};
  const type = String(action.type || "");
  if (!type || NON_COMMITTING_ACTIONS.has(type)) return "";
  // Reaching a dialog is not doing the thing the dialog is for.
  const expected = String(decision.expectedOutcome || "");
  const openerLabel = targetLabel(decision, snapshot);
  if (
    OPENS_UI_OUTCOME_RE.test(expected) &&
    !COMMITS_ANYWAY_RE.test(expected) &&
    !STRONG_COMMIT_LABEL_RE.test(openerLabel)
  ) {
    return "";
  }
  const el = snapshot?.byRef?.get(String(action.target || ""));
  const rawLabel = targetLabel(decision, snapshot);
  // A container's name is a list of what it holds, and judging a click by it
  // asks about actions this click does not take. What the action is EXPECTED
  // to do still counts — that is the agent's own account of the consequence,
  // and it stays trustworthy whatever was clicked.
  const label = isSingleControlLabel(rawLabel, el?.role) ? rawLabel : "";
  const outcome = String(decision.expectedOutcome || "");

  // "Order history", "Purchase details", "Payment methods" carry a committing
  // word and commit nothing.
  const informational =
    !!label && INFORMATIONAL_LABEL_RE.test(label) && !LEADING_ACTION_VERB_RE.test(label);
  if ((!informational && SPENDS_MONEY_RE.test(label)) || MONEY_OUTCOME_RE.test(outcome)) return "money";
  if ((!informational && DESTROYS_DATA_RE.test(label)) || DESTRUCTIVE_OUTCOME_RE.test(outcome)) {
    return "destructive";
  }
  if (OUTBOUND_OUTCOME_RE.test(outcome)) return "outbound";
  // Putting text somewhere delivers nothing. Only committing it does — which
  // is the Enter case handled below, or a separate click on a Send control.
  const typing = type === "type" || type === "type_coord";
  if (!typing && label && OUTBOUND_LABEL_RE.test(label) && !OUTBOUND_LABEL_EXEMPT_RE.test(label)) {
    // …unless what is being aimed at is a place to type, described in prose.
    if (!TARGET_IS_A_FIELD_RE.test(label)) return "outbound";
  }
  // Pressing Enter in a composer commits the send with no button involved.
  if (typing && action.pressEnter === true && SUBMITS_ON_ENTER_RE.test(label)) {
    return "outbound";
  }
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
  if (!asksForDelivery(text)) return false;

  // The audience can be named by the control, by the stated outcome, or by the
  // value the action is carrying — picking "All subscribers" out of a dropdown
  // says as much as a button labelled "Send to everyone".
  const action = decision.action || {};
  const audience = [
    targetLabel(decision, snapshot),
    decision.expectedOutcome,
    action.value,
    action.text,
  ]
    .filter(Boolean)
    .join(" ");
  if (MASS_AUDIENCE_RE.test(audience) && !EXPLICIT_SEND_VERB_RE.test(text)) return false;
  return true;
}

module.exports = {
  decideNext,
  normalizeDecision,
  classifyActionRisk,
  goalAuthorizesAction,
  consequenceKind,
  // Exported for the eval manifest builder, which screens benchmark tasks with
  // the same patterns that gate production actions — so the eval subset and the
  // shipping safety gate can never drift apart. Not used by the agent loop.
  SPENDS_MONEY_RE,
  DESTROYS_DATA_RE,
  DELIVERY_INTENT_RE,
  asksForDelivery,
  targetLabel,
  // The eval manifest screens benchmark GOALS, which are prose. It must not use
  // the label patterns above — see goalCommitsMoney.
  goalCommitsMoney,
  GOAL_SPENDS_MONEY_RE,
};
