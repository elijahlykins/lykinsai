/**
 * Context router — decides what information the agent needs before each
 * reasoning cycle, and keeps everything else out of the context window.
 *
 * Progressive disclosure: core instructions always; skills, browser rules,
 * safety rules and website memory only when relevant.
 */

const instructions = require("./instructions.cjs");

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

/** Browser rule modules relevant to the current situation. */
function routeBrowserModules({ lastActionType = "", recovering = false, tabCount = 1, formsLikely = false, goal = "" } = {}) {
  const modules = new Set(["observation", "interaction"]);
  if (!lastActionType || ["navigate", "go_back", "go_forward", "open_tab"].includes(lastActionType)) {
    modules.add("navigation");
  }
  if (formsLikely || ["type", "replace_text", "select"].includes(lastActionType)) modules.add("forms");
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
  if (websiteMemory) parts.push(websiteMemory.slice(0, 1200));
  parts.push(decisionOutputContract());
  return parts.filter(Boolean).join("\n\n---\n\n");
}

function decisionOutputContract() {
  return [
    "# Output Contract",
    "",
    "Respond with a single structured decision:",
    '- kind "act": one action with `expectedOutcome` describing what the page should show if it works. Use element references (e.g. "e12") from the CURRENT snapshot only.',
    '- kind "finish": the goal is achieved with evidence, or genuinely impossible; `answer` is the final user-facing report.',
    '- kind "ask_user": only the user can provide what is needed (information, sign-in, or approval for a consequential action); `question` states exactly what you need.',
    '- kind "replan": the current plan no longer fits reality; `replanReason` explains why.',
    "Set `risk` honestly: consequential = sending, submitting, purchasing, booking, deleting, publishing, paying.",
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
      "Extract hard constraints separately from preferences.",
      "Record facts already known from the request in knownFacts.",
      "Pick relevant skills from the provided list only.",
      "Ask a clarification question ONLY if the task cannot even be started without it.",
    ].join("\n"),
  ].join("\n\n---\n\n");
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
};
