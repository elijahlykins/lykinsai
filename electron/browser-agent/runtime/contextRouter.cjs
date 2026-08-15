/**
 * Context router — decides what information the agent needs before each
 * reasoning cycle, and keeps everything else out of the context window.
 *
 * Progressive disclosure: core instructions always; skills, browser rules,
 * safety rules and website memory only when relevant.
 */

const instructions = require("./instructions.cjs");
const visionPolicy = require("./visionPolicy.cjs");

/** Keyword heuristic for candidate skills — cheap and deterministic. The
 * planner can confirm or extend this from the goal semantics. */
const SKILL_HINTS = [
  { skill: "shopping", re: /\b(buy|purchase|order|cart|price|cheapest|deal|shop|product|amazon|ebay|shoes|monitor|laptop|headphone|keyboard)\b/i },
  { skill: "communication", re: /\b(email|e-mail|gmail|message|reply|send|dm|slack|inbox|compose|forward)\b/i },
  { skill: "scheduling", re: /\b(calendar|meeting|schedule|book|booking|reservation|reserve|appointment|flight|hotel|restaurant|event|invite)\b/i },
  { skill: "data-entry", re: /\b(spreadsheet|sheet|fill (?:in|out)|enter (?:the|this|data)|data entry|(?:into|in) (?:the |our |my )?crm|update (?:the )?record|transcribe)\b/i },
  { skill: "research", re: /\b(research|find (?:out|me|the)|what|when|who|which|best|compare|top|look up|search for|release|history|review)\b/i },
];

function routeSkills(goal, { maxSkills = 2 } = {}) {
  const text = String(goal || "");
  const available = new Set(instructions.listSkills());
  const matched = [];
  for (const { skill, re } of SKILL_HINTS) {
    if (available.has(skill) && re.test(text) && !matched.includes(skill)) {
      matched.push(skill);
    }
  }
  return matched.slice(0, maxSkills);
}

const EDIT_GOAL_RE =
  /\b(edit|revise|reword|rewrite|re-?phrase|shorten|lengthen|expand|fix|correct|adjust|change|update|tweak|funnier|more formal|less formal|friendlier|different tone|draft revision)\b/i;

/** Asks that mean building something in a visual/drag-driven tool. */
const BUILDER_GOAL_RE =
  /\b(campaign|newsletter|mailchimp|klaviyo|canva|figma|design|graphic|poster|flyer|thumbnail|logo|banner|slide deck|presentation|landing page|template|mockup|brand kit)\b/i;

/** Browser rule modules relevant to the current situation. */
function routeBrowserModules({
  lastActionType = "",
  recovering = false,
  tabCount = 1,
  formsLikely = false,
  goal = "",
  url = "",
  hasDrawnSurface = false,
  hasEmbeddedFrame = false,
} = {}) {
  const modules = new Set(["observation", "interaction"]);
  if (!lastActionType || ["navigate", "go_back", "go_forward", "open_tab"].includes(lastActionType)) {
    modules.add("navigation");
  }
  if (formsLikely || ["type", "replace_text", "select"].includes(lastActionType)) modules.add("forms");
  // Builders and design tools need a different playbook than documents and
  // forms: the surface is nested or drawn, the gestures include dragging, and
  // most correct actions cannot be confirmed from the DOM.
  if (
    hasDrawnSurface ||
    hasEmbeddedFrame ||
    ["drag", "click_coord"].includes(lastActionType) ||
    visionPolicy.VISUAL_EDITOR_URL_RE.test(String(url || "")) ||
    visionPolicy.VISUAL_BUILDER_URL_RE.test(String(url || "")) ||
    BUILDER_GOAL_RE.test(String(goal || ""))
  ) {
    modules.add("builders");
  }
  // Editing rules whenever the task revises existing content or the agent is
  // already writing — this is what steers revisions to replace_text instead
  // of wholesale retyping.
  if (["type", "replace_text"].includes(lastActionType) || EDIT_GOAL_RE.test(String(goal || ""))) {
    modules.add("editing");
  }
  if (tabCount > 1 || ["open_tab", "close_tab", "switch_tab"].includes(lastActionType)) {
    modules.add("tabs");
  }
  if (recovering) modules.add("recovery");
  return [...modules];
}

/** Safety modules relevant to the goal (permissions always ride along). */
function routeSafetyModules(goal) {
  const text = String(goal || "");
  const modules = new Set(["permissions"]);
  if (/\b(buy|purchase|order|checkout|pay|book|subscribe)\b/i.test(text)) modules.add("purchases");
  if (/\b(delete|remove|cancel|unsubscribe|clear|erase|reset)\b/i.test(text)) modules.add("destructive-actions");
  if (/\b(login|log in|sign in|password|account|credential)\b/i.test(text)) modules.add("credentials");
  return [...modules];
}

/**
 * Assemble the system prompt for a decision cycle: core instructions +
 * relevant skills + relevant browser rules + safety rules + memory.
 */
function buildDecisionSystem({ task, skills = [], browserModules = [], safetyModules = [], userMemory = "", websiteMemory = "" }) {
  const parts = [instructions.loadAgentsMd(), instructions.loadCoreInstructions()];
  const browserText = instructions.loadBrowserModules(browserModules);
  if (browserText) parts.push(`# Browser Rules\n\n${browserText}`);
  for (const name of skills) {
    const text = instructions.loadSkill(name);
    if (text) parts.push(text);
  }
  const safetyText = instructions.loadSafetyModules(safetyModules);
  if (safetyText) parts.push(`# Safety Rules\n\n${safetyText}`);
  if (userMemory) parts.push(`# Remembered About the User\n\n${userMemory.slice(0, 1500)}`);
  // Site knowledge is the highest-value context the agent gets — it is the
  // difference between knowing where a feature lives and hunting for it. A
  // 1200-character cap cut real playbooks off mid-sentence.
  if (websiteMemory) parts.push(websiteMemory.slice(0, 3500));
  parts.push(decisionOutputContract());
  return parts.filter(Boolean).join("\n\n---\n\n");
}

function decisionOutputContract() {
  return [
    "# Output Contract",
    "",
    "Respond with a single structured decision:",
    '- kind "act": one action with `expectedOutcome` describing what the page should show if it works. Use element references (e.g. "e12") from the CURRENT snapshot only.',
    "",
    "  Actions beyond the obvious ones, and when they are the right choice:",
    '  - `drag`: move something onto something else — a content block into an email layout, an element onto a design, a card to another column. Give `target` + `to` as element refs, or x/y + toX/toY screenshot coordinates, or one of each. In builders this is often the ONLY way to add content; do not substitute clicks for it.',
    '  - `click_coord`: click a point you can see in an attached screenshot but cannot find in the element list (x and y in 0-1000 of the image). For drawn interfaces and unlabeled icons. Always prefer an element ref when one exists.',
    '  - `scroll` with a `target`: scroll INSIDE that element. Editor palettes, block lists and side panels scroll internally and do not respond to page scrolling.',
    '  - `press_key` with `modifiers`: keyboard shortcuts, e.g. key "b" modifiers ["meta"]. Design and text tools are built around these and they are often faster and more reliable than hunting for a toolbar button.',
    '  - `screenshot`: look at the page when the element list plainly does not describe what you are working on.',
    '- kind "finish": every part of the goal is done with evidence, or it is genuinely impossible; `answer` is the final user-facing report. Do NOT finish with plan steps still outstanding.',
    '- kind "ask_user": the task cannot continue without something only the user has — a credential, a verification code, payment details, or a fact that exists nowhere on screen. `question` names ONE concrete thing for them to do in the browser ("sign in to Meta with your password"), because they act in the live tab and you resume automatically once they have. This is a handover, not the end of the task.',
    '  Never use ask_user to request permission to continue, to confirm a step you can take yourself, or to ask the user to click something. Clicking Confirm / Save / Continue / Allow / Connect / Link is your job.',
    '- kind "replan": the current plan no longer fits reality; `replanReason` explains why.',
    'Set `risk`: "consequential" ONLY when the action spends money, destroys data, or delivers to an audience the request did not name. Confirmations, saves, account links and settings changes inside the requested task are "low".',
    "Record new discoveries in `factsLearned` / `candidateResults` so they persist in working memory.",
    "Set `planStepCompleted` true when the current plan step is finished.",
  ].join("\n");
}

/** System prompt for planning. */
function buildPlanningSystem() {
  return [
    instructions.loadAgentsMd(),
    instructions.loadCoreInstructions(),
    [
      "# Planning Contract",
      "",
      "Convert the user's goal into a short high-level plan (3-8 steps).",
      "Steps are guidance, not click sequences — they must survive website changes.",
      "If the request names a specific app, website or product, every step happens THERE. Record it as a hard constraint and never plan the work in a different tool, however similar. If you do not know its URL, plan to find it.",
      "Plan the task all the way to its finished outcome, including the confirmation or review screens at the end. Do not plan a step that hands work back to the user.",
      "Extract hard constraints separately from preferences.",
      "Record facts already known from the request in knownFacts.",
      "Pick relevant skills from the provided list only.",
      "Ask a clarification question ONLY if the task cannot even be started without it. A vague reference you could resolve by looking (\"the usual format\", \"our template\") is not a blocker — plan to go find it.",
    ].join("\n"),
  ].join("\n\n---\n\n");
}

/**
 * System prompt for post-run learning. The agent has just spent a lot of rounds
 * working out how one site behaves; without this, that understanding is thrown
 * away and the next run on the same site starts from nothing.
 */
function buildLearningSystem() {
  return [
    "You are distilling what was just learned about ONE website into notes for the next visit.",
    "",
    "Write only durable, reusable knowledge about how the site works:",
    "- where a feature lives, and how to reach it (\"campaign templates are under Create > Email\")",
    "- what a control is actually labeled, when the label is not what you would guess",
    "- which route through the product works, especially when an obvious one did not",
    "- quirks worth knowing next time: an editor that renders in an iframe, a canvas that",
    "  never reports its contents, a field that must be filled before a button enables,",
    "  a step that needs a drag rather than a click",
    "- what counts as evidence that something saved or sent",
    "",
    "Never write:",
    "- anything about this particular task, its content, recipients, or results",
    "- credentials, codes, card details, personal data, or anything resembling a secret",
    "- CSS selectors, element references, or coordinates — they are worthless next time",
    "- generic web advice that is true of every website",
    "",
    "One fact per note, phrased so it makes sense on its own months from now.",
    "Prefer 0 notes to speculation: return an empty array if nothing durable was learned.",
  ].join("\n");
}

/** System prompt for verification. */
function buildVerificationSystem() {
  return [
    "You verify whether a browser action achieved its expected outcome.",
    "You are given the action, the expected outcome, a deterministic diff of the page before/after, and the current page state.",
    "Judge ONLY from this evidence. A tool returning without error is not evidence.",
    'Answer success=true only when the browser state shows the expected change (cite it in `evidence`).',
    'When success=false: next="recover" if the same approach could work on the live page, next="replan" if the approach itself is invalid.',
  ].join("\n");
}

module.exports = {
  routeSkills,
  routeBrowserModules,
  routeSafetyModules,
  buildDecisionSystem,
  buildPlanningSystem,
  buildVerificationSystem,
  buildLearningSystem,
};
