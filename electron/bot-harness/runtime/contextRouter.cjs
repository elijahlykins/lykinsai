/**
 * Prompt assembly for the Bot harness.
 *
 * The system prompt is byte-stable for the life of a task (and across tasks
 * for the same bot): runtime identity + core + safety + the tool index + the bot's
 * own identity block + the output contract. Providers cache prompt prefixes,
 * and every decide call this task starts with the same rules — so nothing
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
        "use_tool: the complete, self-contained brief for the tool — subject, constraints, tone, content, and every fact from the conversation the work depends on. The tool sees only this.",
    },
    reason: { type: "string", description: "Short internal justification, for the trace" },
    successCondition: {
      type: "string",
      description:
        "FIRST decision of a task only: one sentence naming the observable outcome that means this task is done — specific and checkable, no vague words like \"successfully\".",
    },
    doNot: {
      type: "array",
      items: { type: "string" },
      description:
        "FIRST decision of a task only: 2-5 adjacent actions the user's literal request does NOT license — the tempting extras next to this task. Short imperative phrases.",
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
        "deliver: the final message to the user — what you did, what they now have, anything you chose for them or could not finish. 1-4 sentences; never repeat a deliverable's full content.",
    },
    question: { type: "string", description: "ask_user: the one bundled question the task cannot continue without" },
    questionOptions: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional, ask_user only. 2-4 complete answers the user could tap, each written in their voice — never Yes/No, never a restatement of the question.",
    },
  },
  required: ["kind"],
  additionalProperties: false,
};

function identityBlock(bot) {
  const name = String(bot?.name || "").trim();
  const role = String(bot?.role || "").trim();
  const persona = String(bot?.persona || "").trim().slice(0, 1200);
  if (!name && !persona) return "";
  return [
    "# Who You Are",
    "",
    `Your name is ${name || "the user's Bot"}${role ? `, and you work as their ${role}` : ""}.`,
    persona ? `Working style the user gave you:\n${persona}` : "",
    "Stay in this identity in every narration, question, and delivery — warm and direct, a teammate rather than a formal assistant. The identity shapes tone and judgement; the safety rules always outrank it.",
  ]
    .filter(Boolean)
    .join("\n");
}

function decisionOutputContract() {
  return [
    "# Output Contract",
    "",
    "Respond with a single structured decision:",
    '- kind "use_tool": run one tool from the Tool Index. Set `tool` to its exact name and `instruction` to a complete, self-contained brief. The first time you select a tool this task, its full instructions are returned to you instead of running — read them, then issue the call again properly (or pick differently). Once its docs are in your context the call runs.',
    '- kind "deliver": the task is done (or genuinely cannot proceed) and `answer` is the final message — what you did, what the user now has, anything you decided for them or could not finish. Deliver only when the work has actually run; the record below is what happened, and an empty record delivers nothing.',
    '- kind "ask_user": the task cannot continue without something only the user has. One question per task, everything bundled; put 2-4 complete tappable answers in `questionOptions` when you can genuinely propose them. Never ask permission to do the work itself — consequential actions get their own approval pause automatically.',
    'Set `risk`: "consequential" when the round\'s action spends money, destroys data, or delivers anything to another person (send, post, publish, share, submit). Working inside drafts and unshared deliverables is "low"; reading is "read".',
    "The TASK / SUCCESS CONDITION / DO NOT brief in the user message is authoritative. Never broaden or replace it. `successCondition` and `doNot` are optional planning suggestions for legacy callers only; TaskRuntime ignores them when a canonical Task is present.",
    "Always write `narration` — the user reads it live while you work.",
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
        `If a necessary part clearly belongs to one of them, deliver only [[ask ${state.collaborators[0].name}: the question]] so the runtime can relay it. Do not hand off optional work.`,
      ].join("\n")
    : "";

  return [
    convo ? `RECENT CONVERSATION:\n${convo}` : "",
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
    "Judge ONLY from the output. A tool returning without error is not evidence — the output has to actually contain or accomplish what the instruction asked for.",
    "Answer success=true only when the output shows the work (cite it in `evidence`).",
    "An output that is an apology, a refusal, a plan instead of the work, empty, or off-topic is a failure even when it is politely written.",
    'When success=false: next="recover" if a better instruction to the same tool could work, next="replan" if a different tool or approach is needed.',
  ].join("\n");
}

function buildVerificationUser({ goal, successCondition = "", tool, instruction, output }) {
  return [
    `TASK GOAL:\n${String(goal || "").slice(0, 800)}`,
    successCondition ? `SUCCESS CONDITION:\n${String(successCondition).slice(0, 300)}` : "",
    `TOOL: ${tool}`,
    `INSTRUCTION GIVEN:\n${String(instruction || "").slice(0, 800)}`,
    `TOOL OUTPUT:\n${String(output || "(empty)").slice(0, 3000)}`,
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
