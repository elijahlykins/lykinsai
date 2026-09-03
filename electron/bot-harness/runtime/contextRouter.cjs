/**
 * Prompt assembly for the Bot harness.
 *
 * The system prompt is byte-stable for the life of a task (and across tasks
 * for the same bot): runtime identity + core + safety + the tool index + the bot's
 * own identity block + the output contract. Providers cache prompt prefixes,
 * and every decide call this task starts with the same rules - so nothing
 * volatile (task state, tool docs, history) is spliced in here. All of that
 * travels in the user message, which changes every round anyway.
 */

const instructions = require("./instructions.cjs");
const registry = require("./toolRegistry.cjs");
const { formatEventsForModel } = require("./taskState.cjs");

/** The decision every round is one JSON object against this schema. */
const BOT_DECISION_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["use_tool", "deliver", "ask_user"] },
    tool: { type: "string", description: "use_tool: a tool name from the Tool Index, exactly as written" },
    instruction: {
      type: "string",
      description:
        "use_tool: the complete, self-contained brief for the tool - subject, constraints, tone, content, and every fact from the conversation the work depends on. The tool sees only this.",
    },
    reason: { type: "string", description: "Short internal justification, for the trace" },
    successCondition: {
      type: "string",
      description:
        "FIRST decision of a task only: one sentence naming the observable outcome that means this task is done - specific and checkable, no vague words like \"successfully\".",
    },
    doNot: {
      type: "array",
      items: { type: "string" },
      description:
        "FIRST decision of a task only: 2-5 adjacent actions the user's literal request does NOT license - the tempting extras next to this task. Short imperative phrases.",
    },
    narration: {
      type: "string",
      description:
        "1-2 sentences the user reads live: what you are doing and why, first person, present tense, plain language. No tool names, no schema fields.",
    },
    risk: {
      type: "string",
      enum: ["read", "low", "consequential"],
      description:
        "consequential = spends money, destroys data, or delivers anything to another person or audience",
    },
    answer: {
      type: "string",
      description:
        "deliver: the final message the user reads. After an action (sent, built, generated) or a research_report/edit_report run (the document reaches them as a card): a short confirmation of what they now have. After findings you gathered yourself (inbox, listing, comparison): a full markdown report - title, summary, sections, lists or a table, sources when you have them. Never paste a report the user already received as a document card.",
    },
    question: { type: "string", description: "ask_user: the one bundled question the task cannot continue without" },
    questionOptions: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional, ask_user only. 2-4 complete answers the user could tap, each written in their voice - never Yes/No, never a restatement of the question.",
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

function sanitizeBotSkills(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.id || "").trim().slice(0, 80);
    const name = String(raw.name || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const instructions = String(raw.instructions || "").trim().slice(0, 2000);
    if (!id || !name || !instructions || seen.has(id)) continue;
    seen.add(id);
    out.push({ name, instructions });
    if (out.length >= 12) break;
  }
  return out;
}

function identityBlock(bot) {
  const name = String(bot?.name || "").trim();
  const role = String(bot?.role || "").trim();
  const persona = String(bot?.persona || "").trim().slice(0, 1200);
  const skills = sanitizeBotSkills(bot?.skills);
  if (!name && !persona && !skills.length) return "";
  const skillLines = skills.length
    ? [
        "Custom skills the user taught you - follow one when the work matches:",
        ...skills.map((skill) => `- ${skill.name}: ${skill.instructions}`),
      ].join("\n")
    : "";
  return [
    "# Who You Are",
    "",
    `Your name is ${name || "the user's Bot"}${role ? `, and you work as their ${role}` : ""}.`,
    persona ? `Working style the user gave you:\n${persona}` : "",
    skillLines,
    "Stay in this identity in every narration, question, and delivery - warm and direct, a teammate rather than a formal assistant. The identity shapes tone and judgement; the safety rules always outrank it.",
  ]
    .filter(Boolean)
    .join("\n");
}

function decisionOutputContract() {
  return [
    "# Output Contract",
    "",
    "Respond with a single structured decision:",
    '- kind "use_tool": run one tool from the Tool Index. Set `tool` to its exact name and `instruction` to a complete, self-contained brief. The first time you select a tool this task, its full instructions are returned to you instead of running - read them, then issue the call again properly (or pick differently). Once its docs are in your context the call runs.',
    '- kind "deliver": the task is done (or genuinely cannot proceed) and `answer` is the final message. After an action, confirm what they now have. After findings, write a real markdown report they can keep - not a 1-4 sentence teaser. Deliver only when the work has actually run THIS task; the record below is what happened, and an empty record delivers nothing. A result sitting in the recent conversation is from an earlier turn - restating it is not delivery. Do not deliver a short wrap-up after reply, write_document, or browser: those tools already are the delivery. After research_report or edit_report the user has the document as a card - finish any remaining parts of the task, then deliver a short close instead of repeating it.',
    '- kind "ask_user": the task cannot continue without something only the user has. One question per task, everything bundled; put 2-4 complete tappable answers in `questionOptions` when you can genuinely propose them. Never ask permission to do the work itself - consequential actions get their own approval pause automatically. After they asked what is in a folder and you have the listing, deliver the summary. Do not ask which part they want.',
    'Set `risk`: "consequential" when the round\'s action spends money, destroys data, or delivers anything to another person (send, post, publish, share, submit). Working inside drafts and unshared deliverables is "low"; reading is "read".',
    "The TASK / SUCCESS CONDITION / DO NOT brief in the user message is authoritative. Never broaden or replace it. `successCondition` and `doNot` are optional planning suggestions for legacy callers only; TaskRuntime ignores them when a canonical Task is present.",
    "Always write `narration` - the user reads it live while you work.",
  ].join("\n");
}

/**
 * The byte-stable system prompt: rules + tool index + this bot's identity +
 * the contract. Identity is stable per bot, so the cache prefix survives
 * across every task the bot runs.
 */
function buildDecisionSystem({ bot = null, localMode = false } = {}) {
  return [
    instructions.loadIdentityPrompt(),
    instructions.loadCoreRules(),
    registry.toolIndexBlock({ localMode }),
    instructions.loadSafetyRules(),
    identityBlock(bot),
    decisionOutputContract(),
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

/**
 * The per-round user message: conversation, goal, attachments, everything
 * that has run, the docs of every tool selected so far, standing guidance
 * from failures, and the ask to decide.
 */
function buildTaskUser({
  state,
  conversationHistory = [],
  attachmentsNote = "",
  extraNote = "",
} = {}) {
  const convo = (conversationHistory || [])
    .slice(-8)
    .map((m) => `${m?.role === "assistant" ? "You" : "User"}: ${String(m?.content || "").slice(0, 400)}`)
    .join("\n");

  const docs = [...state.docsLoaded]
    .map((name) => registry.toolDocBlock(name))
    .filter(Boolean)
    .join("\n\n");

  // The full brief, not a bare goal line: what done looks like, the scope
  // wall, the licensed-work boundary, and the order to stop the moment the
  // success condition holds. Canonical Task constraints are supplied before
  // the executor starts; model-authored planning fields cannot replace them.
  const doNot = [...new Set([...state.doNot, "Continue looking for additional useful work."])];
  const brief = [
    "TASK:",
    state.goal,
    "",
    "SUCCESS CONDITION:",
    state.successCondition ||
      "The user's literal request has been satisfied and the record below shows the work.",
    "",
    "SCOPE:",
    "Perform only actions strictly necessary to satisfy the user's literal request.",
    "",
    "DO NOT:",
    ...doNot.map((d) => `- ${d}`),
    "",
    "STOP RULE:",
    "As soon as the success condition is satisfied, deliver and stop. Do not perform optional follow-up work.",
  ].join("\n");
  const collaborators = (Array.isArray(state.collaborators) ? state.collaborators : [])
    .map((bot) => `${bot.name}${bot.role ? ` (${bot.role})` : ""}`)
    .filter(Boolean);
  const collaborationBlock = collaborators.length
    ? [
        `AVAILABLE TEAMMATES:\n${collaborators.join(", ")}`,
        "These teammates were named in THIS ask. If their part is necessary, deliver only [[ask Name: the question]] using that teammate's name so the runtime can relay it. Do not consult someone the user did not name. A prior conversation is not a request to hand off.",
      ].join("\n")
    : "";

  return [
    convo
      ? `RECENT CONVERSATION (references only - not this task's work):\n${convo}`
      : "",
    brief,
    attachmentsNote ? `ATTACHED BY THE USER:\n${attachmentsNote}` : "",
    collaborationBlock,
    docs ? `TOOL INSTRUCTIONS YOU HAVE READ:\n\n${docs}` : "",
    `WHAT HAS HAPPENED THIS TASK:\n${formatEventsForModel(state)}`,
    state.guidance ? `GUIDANCE FROM THE LAST FAILURE:\n${state.guidance}` : "",
    extraNote,
    "Decide the next structured step now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** System prompt for verifying one tool's output against the goal. */
function buildVerificationSystem() {
  return [
    "You verify whether one tool run genuinely advanced a Bot's task.",
    "You are given the task goal, the instruction the tool was given, and the tool's output.",
    "Judge ONLY whether this tool run accomplished its INSTRUCTION. Later steps of the task - another tool, a teammate consult - are not this tool's job. A complete research report is success even if the broader goal also asks to talk to someone next.",
    "Judge ONLY from the output. A tool returning without error is not evidence - the output has to actually contain or accomplish what the instruction asked for.",
    "Long outputs are clipped for this check: you see the start and the end with an omission marker between them. The omitted middle is NOT missing work - judge structure and completeness from what is shown, especially how the output ends.",
    "Answer success=true only when the output shows the work (cite it in `evidence`).",
    "An output that is an apology, a refusal, a plan instead of the work, empty, or off-topic is a failure even when it is politely written.",
    'When success=false: next="recover" if a better instruction to the same tool could work, next="replan" if a different tool or approach is needed.',
  ].join("\n");
}

/**
 * A long output is shown to the verifier as head + tail, never head-only.
 * A 15k-character report cut off at 3000 characters mid-sentence used to
 * read as incomplete work - the verifier failed it, the harness re-ran the
 * whole research, and the user watched a finished report get "rewritten".
 * The ending is the completeness signal (a Sources section, a closing
 * summary), so it must survive the clip.
 */
const VERIFY_OUTPUT_HEAD = 2100;
const VERIFY_OUTPUT_TAIL = 900;
function clipOutputForVerification(output) {
  const raw = String(output || "(empty)");
  if (raw.length <= VERIFY_OUTPUT_HEAD + VERIFY_OUTPUT_TAIL + 200) return raw;
  const omitted = raw.length - VERIFY_OUTPUT_HEAD - VERIFY_OUTPUT_TAIL;
  return (
    `${raw.slice(0, VERIFY_OUTPUT_HEAD)}\n\n` +
    `[... ${omitted} characters omitted - the output continues and ends as shown below ...]\n\n` +
    raw.slice(-VERIFY_OUTPUT_TAIL)
  );
}

function buildVerificationUser({ goal, successCondition = "", tool, instruction, output }) {
  return [
    `TASK GOAL:\n${String(goal || "").slice(0, 800)}`,
    successCondition ? `SUCCESS CONDITION:\n${String(successCondition).slice(0, 300)}` : "",
    `TOOL: ${tool}`,
    `INSTRUCTION GIVEN:\n${String(instruction || "").slice(0, 800)}`,
    `TOOL OUTPUT:\n${clipOutputForVerification(output)}`,
    "Did this output genuinely accomplish what the instruction asked for?",
  ]
    .filter(Boolean)
    .join("\n\n");
}

module.exports = {
  BOT_DECISION_SCHEMA,
  buildDecisionSystem,
  buildTaskUser,
  buildVerificationSystem,
  buildVerificationUser,
  identityBlock,
  decisionOutputContract,
};
