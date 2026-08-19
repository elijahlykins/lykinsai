/**
 * Context router — assembles the prompt for each stage of the loop.
 *
 * Operating rules (core, browser, safety) are always loaded; only skills and
 * website memory are selected per task. See instructions.cjs for why the
 * per-round routing of browser and safety rules was removed.
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

/**
 * Assemble the system prompt for a decision cycle: operating rules + relevant
 * skills + memory + the output contract.
 */
function buildDecisionSystem({ task, skills = [], userMemory = "", websiteMemory = "" }) {
  const parts = [
    instructions.loadAgentsMd(),
    instructions.loadCoreInstructions(),
    instructions.loadBrowserRules(),
  ];
  for (const name of skills) {
    const text = instructions.loadSkill(name);
    if (text) parts.push(text);
  }
  parts.push(instructions.loadSafetyRules());
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
    '  - `click_coord`: click a point you can see in an attached screenshot but cannot find in the element list (x and y in 0-1000 of the image). For drawn interfaces and unlabeled icons. Always prefer an element ref when one exists. Set `label` to what you are clicking ("Send", "Delete") — it is the only description of the target anything downstream gets.',
    '  - `scroll` with a `target`: scroll INSIDE that element. Editor palettes, block lists and side panels scroll internally and do not respond to page scrolling.',
    '  - `press_key` with `modifiers`: keyboard shortcuts, e.g. key "b" modifiers ["meta"]. Design and text tools are built around these and they are often faster and more reliable than hunting for a toolbar button.',
    '  - `screenshot`: look at the page when the element list plainly does not describe what you are working on. The image comes back attached to your next decision.',
    '- kind "finish": every part of the goal is done with evidence, or it is genuinely impossible; `answer` is the final user-facing report. Do NOT finish with plan steps still outstanding unless you say in `answer` why each one no longer applies.',
    '- kind "ask_user": the task cannot continue without something only the user has — a credential, a verification code, payment details, or a fact that exists nowhere on screen. `question` names ONE concrete thing for them to do in the browser ("sign in to Meta with your password"), because they act in the live tab and you resume automatically once they have. This is a handover, not the end of the task.',
    "  Never use ask_user to request permission to continue, to confirm a step you can take yourself, or to ask the user to click something. Clicking Confirm / Save / Continue / Allow / Connect / Link is your job.",
    '- kind "replan": the current plan no longer fits reality; `replanReason` explains why. If a recorded constraint is what no longer fits, list the ones that still apply in `constraints` — an empty `constraints` array means "none of them still apply", and is how you drop a constraint the page has overtaken.',
    'Set `risk`: "consequential" ONLY when the action spends money, destroys data, or delivers to an audience the request did not name. Confirmations, saves, account links and settings changes inside the requested task are "low".',
    "Record new discoveries in `factsLearned` / `candidateResults` so they persist in working memory.",
    "Set `planStepCompleted` true when the current plan step is finished — including when you have established it does not need doing.",
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
      "Plan the task all the way to its finished outcome, including the confirmation or review screens at the end. Do not plan a step that hands work back to the user.",
      "",
      "Constraints are the things that would make the finished work WRONG if violated: a budget, a date, a recipient, a quantity, a required product for the deliverable. Record those, and only those.",
      "A named app or website is a constraint on where the deliverable ends up — \"the email is sent from Gmail\", \"the design is saved in Canva\" — not a restriction on which pages may be visited along the way. Never write a constraint that forbids visiting other sites; the agent must stay free to follow an outbound link, check a fact elsewhere, or use a search engine, and it will come back.",
      "If you do not know the named product's URL, plan to find it.",
      "",
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
    "",
    "Separately, `userNotes` is for durable facts about the PERSON, not the site — what they call things,",
    "a preference they stated, a detail about their work that would help on an unrelated task months from now.",
    "Not what they asked for this time, not who they wrote to, not anything resembling a secret.",
    "This is almost always empty. Leave it empty unless the fact would still be useful on a different site.",
  ].join("\n");
}

/** System prompt for verification. */
function buildVerificationSystem() {
  return [
    "You verify whether a browser action achieved its expected outcome.",
    "You are given the action, the expected outcome, a deterministic diff of the page before/after, and the current page state.",
    "Judge ONLY from this evidence. A tool returning without error is not evidence.",
    "Answer success=true only when the browser state shows the expected change (cite it in `evidence`).",
    "Read the page for what it actually says. A page that reports an error, a rejection, a validation failure or a required extra step is evidence the action did NOT succeed, even when it repeats the words of the expected outcome back at you.",
    'When success=false: next="recover" if the same approach could work on the live page, next="replan" if the approach itself is invalid.',
  ].join("\n");
}

module.exports = {
  routeSkills,
  buildDecisionSystem,
  buildPlanningSystem,
  buildVerificationSystem,
  buildLearningSystem,
  // Exported for the eval harness, which must drive the exact contract
  // production sends rather than an approximation of it.
  decisionOutputContract,
};
