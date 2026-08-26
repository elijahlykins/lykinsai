/**
 * Context router — assembles the prompt for each stage of the loop.
 *
 * Operating rules are tiered by the task's capabilities (see
 * instructions.cjs); skills and website memory are selected per task. Nothing
 * is routed per round — the corpus a task starts with is the corpus it keeps,
 * so provider prompt caches stay warm for the whole run.
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
  // Surface-specific HOW knowledge for campaign builders, design tools, page
  // builders and slide editors — the former "Builders and visual editors"
  // section of browser.md, now selected only when the task is that shape.
  { skill: "builders", re: /\b(campaign|newsletter|mailchimp|klaviyo|canva|figma|design|slide|slides|presentation|deck|template|page builder|site builder|landing page|wix|squarespace|webflow|logo|flyer|poster|banner|mockup)\b/i },
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
 * skills + the output contract.
 *
 * Deliberately byte-stable for the life of a task. Providers cache prompt
 * prefixes, and the decide call is made every round with the same rules in
 * front — but only if nothing volatile is spliced into them. Memory used to
 * live here, and website memory changes whenever the task crosses to another
 * site, which invalidated the cached prefix exactly mid-task. Memory now
 * travels in the user message (buildMemoryContext), which is rebuilt every
 * round anyway.
 *
 * `allowedActions` (a Set from runtime/capabilities.cjs, or null for the
 * legacy full grant) tiers the corpus: a task whose schema contains no click
 * or type gets no interaction, form-filling or delivery-safety instructions,
 * because it cannot express the actions they govern. Capabilities are fixed
 * per task, so the tiering never breaks byte-stability mid-run.
 */
function buildDecisionSystem({ task, skills = [], allowedActions = null }) {
  const interactive = !allowedActions || allowedActions.has("click");
  const parts = [
    instructions.loadCoreInstructions(),
    instructions.loadBrowserReadRules(),
  ];
  if (interactive) parts.push(instructions.loadBrowserInteractRules());
  for (const name of skills) {
    const text = instructions.loadSkill(name);
    if (text) parts.push(text);
  }
  if (interactive) parts.push(instructions.loadSafetyActionRules());
  parts.push(instructions.loadSafetyCoreRules());
  // Constant per machine, so it never breaks the cached prefix. Without it
  // the model guessed at modifier keys — control+Enter to send in Gmail on
  // a Mac, where the send shortcut is meta(⌘)+Enter — and the miss was
  // invisible because shortcut effects rarely show in a page scrape.
  parts.push(platformNote());
  parts.push(decisionOutputContract(allowedActions));
  return parts.filter(Boolean).join("\n\n---\n\n");
}

/** Which OS this browser runs on — it decides every keyboard shortcut. */
function platformNote() {
  const mac = process.platform === "darwin";
  return [
    "# Platform",
    "",
    mac
      ? 'This browser runs on macOS. Keyboard shortcuts use the "meta" (⌘) modifier — send with '
        + 'press_key key "Enter" modifiers ["meta"], bold with key "b" modifiers ["meta"]. '
        + 'The "control" modifier is almost never what a mac app wants.'
      : 'This browser runs on ' + (process.platform === "win32" ? "Windows" : "Linux") + ". "
        + 'Keyboard shortcuts use the "control" modifier — send with press_key key "Enter" '
        + 'modifiers ["control"], bold with key "b" modifiers ["control"].',
  ].join("\n");
}

/**
 * What the agent remembers, formatted for the user message.
 *
 * Site knowledge is the highest-value context the agent gets — it is the
 * difference between knowing where a feature lives and hunting for it. A
 * 1200-character cap once cut real playbooks off mid-sentence; the caps here
 * are the budget, not a trim to the nearest sentence.
 */
function buildMemoryContext({ userMemory = "", websiteMemory = "" } = {}) {
  const parts = [];
  if (userMemory) parts.push(`# Remembered About the User\n\n${userMemory.slice(0, 1500)}`);
  if (websiteMemory) parts.push(websiteMemory.slice(0, 3500));
  return parts.join("\n\n");
}

function decisionOutputContract(allowedActions = null) {
  const has = (type) => !allowedActions || allowedActions.has(type);
  // Guidance for an action the schema does not contain is dead weight — the
  // model cannot express it, so it never needs to be told when to use it.
  const actionGuidance = [
    has("drag") &&
      '  - `drag`: move something onto something else — a content block into an email layout, an element onto a design, a card to another column. Give `target` + `to` as element refs, or x/y + toX/toY screenshot coordinates, or one of each. In builders this is often the ONLY way to add content; do not substitute clicks for it.',
    has("click_coord") &&
      '  - `click_coord`: click a point you can see in an attached screenshot but cannot find in the element list (x and y in 0-1000 of the image). For drawn interfaces and unlabeled icons. Always prefer an element ref when one exists. Set `label` to what you are clicking ("Send", "Delete") — it is the only description of the target anything downstream gets.',
    has("scroll") &&
      '  - `scroll` with a `target`: scroll INSIDE that element. Editor palettes, block lists and side panels scroll internally and do not respond to page scrolling.',
    has("press_key") &&
      '  - `press_key` with `modifiers`: keyboard shortcuts, e.g. key "b" modifiers ["meta"]. Design and text tools are built around these and they are often faster and more reliable than hunting for a toolbar button.',
    has("paste_text") &&
      '  - `paste_text`: put a WHOLE document body into the editor on this page, in one go — how you write a long piece into Notion, Docs or Slides. It finds and focuses the editor itself, so DO NOT hunt for the writing area first: paste, then read the page back to confirm. Typing a long document instead is slow and lets autocomplete and autosave interfere. Set `mode` to "replace" to overwrite what is there.',
    has("screenshot") &&
      '  - `screenshot`: look at the page when the element list plainly does not describe what you are working on. The image comes back attached to your next decision.',
    has("dismiss_overlay") &&
      '  - `dismiss_overlay`: clear whatever a page has put in front of itself — a cookie or consent wall, a newsletter modal, an "open in app" interstitial, a notification prompt. This already runs for you before most snapshots, so reach for it when a wall arrived mid-task, or when clicks are landing on nothing and something is covering the page. It only ever clicks controls that dismiss, so it cannot agree to anything that matters; if it reports nothing to dismiss, close the thing yourself from the element list.',
  ].filter(Boolean);
  return [
    "# Output Contract",
    "",
    "Respond with a single structured decision:",
    '- kind "act": one action with `expectedOutcome` describing what the page should show if it works. Use element references (e.g. "g7:12") from the CURRENT snapshot only — references embed the observation they came from, and one from an earlier snapshot is rejected as stale.',
    "",
    "  Actions beyond the obvious ones, and when they are the right choice:",
    ...actionGuidance,
    '- kind "finish": every part of the goal is done with evidence, or it is genuinely impossible; `answer` is the final user-facing report. Do NOT finish with plan steps still outstanding unless you say in `answer` why each one no longer applies. A goal that asks for several deliveries ("email Alice and text Bob") is finished only when every one of them has happened. If the page already shows the outcome — "Message sent", "Access updated", the compose window gone after a send — you are done: finish now. Do not compose again, do not click Send again, do not start the task over. And the moment the goal is met, finish — one more look around, one more page, one more check is browsing past the end of the task.',
    '- kind "ask_user": the task cannot continue without something only the user has. Two shapes: (a) something they do in the browser — a credential, a verification code, clearing a wall — where `question` names ONE concrete action ("sign in to Meta with your password") and you resume automatically once they have; (b) something they tell you — above all WHAT A MESSAGE SHOULD SAY when the request named a recipient but no content, or WHO IT GOES TO when the request named content but no recipient. Never invent the substance of anything you are going to send, and never guess an address or a recipient; ask ONCE, propose answers in `questionOptions`, and write it when they reply.',
    "  One question per task. Bundle everything you need (what to say, tone, subject) into that single ask. Do not follow up with tone, then subject, then timing — those are yours to pick after they answer. If they already told you what it should say, do not ask again.",
    "  Never use ask_user to request permission — not to continue, not to confirm a step you can take yourself, not to ask the user to click something, and above all not before a send, share or delete. Clicking Compose / Reply / Confirm / Save / Continue / Allow / Connect / Link is your job. So is clicking Send: the system pauses you only at a committing click (Send, Share, Publish, Delete, Pay) and asks the user with a yes/no button, automatically. Asking in words instead ends the task and gives them a text box where a button belongs.",
    '  When the answer is a choice you could sensibly propose — a subject line, a name, a date, which of several items on screen — put 2-4 concrete answers in `questionOptions`. Each must be a COMPLETE answer written the way the user would give it ("Quick favor — 2 mins?"), not a label, a restatement of the question, or Yes/No. They are offered as one-tap chips on the same glass card as the text box, so the user can always write their own. Omit them for a credential, a verification code, or anything you would only be guessing at.',
    '- kind "replan": the current plan no longer fits reality; `replanReason` explains why. If a recorded constraint is what no longer fits, list the ones that still apply in `constraints` — an empty `constraints` array means "none of them still apply", and is how you drop a constraint the page has overtaken.',
    'Set `risk`: "consequential" when the action spends money, destroys data, or delivers anything to another person (send, share, post, publish, invite) — including a delivery the request asked for, since the user has not seen what you wrote. Confirmations, saves, account links and settings changes inside the requested task are "low".',
    "Record new discoveries in `factsLearned` / `candidateResults` so they persist in working memory.",
    "Set `planStepCompleted` true when the current plan step is finished — including when you have established it does not need doing.",
    "",
    "## Narration",
    "",
    "Always write `narration`: 1-3 sentences addressed to the user, which they read as this step happens. Someone watching over your shoulder should be able to follow the whole task from the narration alone, without knowing anything about how you work.",
    "Say what you found on the page, what you are doing about it, and what you expect next. When the page was not what you expected, when you had to pick between options, when you are backtracking, or when something looks like it might go wrong, say so and say why — those are the moments the user most needs explained.",
    "Write it as plain running commentary, in the first person and the present tense. Never mention element references, coordinates, snapshots, rounds, plans, schemas, or field names. Do not repeat the task back at them, and do not narrate the obvious twice in a row — if this round is more of the same, say what is different about it.",
    "`reason` stays as your own short internal justification. `narration` is the part the user reads.",
  ].join("\n");
}

/** System prompt for planning. */
function buildPlanningSystem() {
  return [
    instructions.loadIdentity(),
    instructions.loadCoreInstructions(),
    [
      "# Planning Contract",
      "",
      "Convert the user's goal into a short high-level plan (3-8 steps).",
      "Steps are guidance, not click sequences — they must survive website changes.",
      "Plan the task all the way to its finished outcome, including the confirmation or review screens at the end. Do not plan a step that hands work back to the user.",
      "",
      "Write `successCondition`: ONE sentence naming the observable state that means this task is done — what the final page would show. It defines where the agent stops, so make it specific to this task and checkable against a page (\"the inbox is open and the unread messages have been read out\"), never vague (\"the task is completed successfully\").",
      "Write `doNot`: 2-5 adjacent actions the user's LITERAL request does not license — the tempting extras that sit next to this task. For \"check my email\" that is drafting replies, sending anything, organizing the inbox. These are scope walls, not route restrictions: never forbid navigation, searching, or steps the task itself needs.",
      "",
      "Constraints are the things that would make the finished work WRONG if violated: a budget, a date, a recipient, a quantity, a required product for the deliverable. Record those, and only those.",
      "A named app or website is a constraint on where the deliverable ends up — \"the email is sent from Gmail\", \"the design is saved in Canva\" — not a restriction on which pages may be visited along the way. Never write a constraint that forbids visiting other sites; the agent must stay free to follow an outbound link, check a fact elsewhere, or use a search engine, and it will come back.",
      "If you do not know the named product's URL, plan to find it.",
      "",
      "Record facts already known from the request in knownFacts.",
      "Pick relevant skills from the provided list only.",
      "",
      "Write `approach`: 2-4 sentences addressed to the user, which they read before anything happens. Tell them where you are going to start, how you mean to get to the finished outcome, and anything about their request worth raising up front — an assumption you are making, a detail you will have to go and find, a point where you will likely need them. Plain language, first person, no step numbering, no restating their request back at them.",
      "Ask a clarification question ONLY if the task cannot even be started without it. A vague reference you could resolve by looking (\"the usual format\", \"our template\") is not a blocker — plan to go find it. Neither is a detail you could reasonably choose yourself: write the subject line, pick the sensible default, and say what you chose.",
      "If the request named a recipient but never said what the message should say, ask that ONE question — \"What should this email say?\" — and stop. Do not also ask about tone, subject, or timing. If they already answered, do not ask again.",
      "If you do ask, put 2-4 concrete answers in `clarificationOptions` whenever you can propose good ones — each a COMPLETE answer in the user's voice, never Yes/No and never a restatement of the question. They become one-tap chips on the same glass card as the text box, so the user can still write their own.",
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
    "- when the task SUCCEEDED: one note that captures the whole route from entry to outcome as",
    "  a single line the next run can follow (\"To send a campaign: Create > Email > pick a",
    "  template > edit the blocks > Send\"), written from the steps that actually worked —",
    "  this is the most valuable note a run can leave, because the next run on the same kind of",
    "  task skips its discovery rounds entirely",
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
  buildMemoryContext,
  buildPlanningSystem,
  buildVerificationSystem,
  buildLearningSystem,
  // Exported for the eval harness, which must drive the exact contract
  // production sends rather than an approximation of it.
  decisionOutputContract,
};
