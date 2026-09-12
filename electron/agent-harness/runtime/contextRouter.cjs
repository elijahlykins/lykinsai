/**
 * Prompt assembly for the Agent harness.
 *
 * The system prompt is byte-stable for the life of a task (and across tasks):
 * runtime identity + core + safety + the tool index + the output contract.
 * Providers cache prompt prefixes, and every decide call this task starts
 * with the same rules - so nothing volatile (task state, tool docs, history)
 * is spliced in here. All of that travels in the user message, which changes
 * every round anyway.
 */

const instructions = require("./instructions.cjs");
const registry = require("./toolRegistry.cjs");
const { formatEventsForModel } = require("./taskState.cjs");

/** The decision every round is one JSON object against this schema. */
const AGENT_DECISION_SCHEMA = {
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

/**
 * The step schema: everything a "what do I do next" round needs, and nothing
 * a final answer needs.
 *
 * Every decide round used to run against AGENT_DECISION_SCHEMA with a 4,000
 * token ceiling, because the final `answer` was written inside the same JSON
 * as the tool choice. A round that only picks a tool emits a few hundred
 * tokens — it was being asked for a decision by a model told it may write an
 * essay. `answer` is dropped here and `deliver` becomes its own call against
 * AGENT_DELIVER_SCHEMA, which is the only one that needs the room.
 *
 * `kind` keeps "deliver" so the model can still SAY it is finished; the loop
 * then makes the deliver call to get the words.
 */
const AGENT_STEP_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    Object.entries(AGENT_DECISION_SCHEMA.properties).filter(([k]) => k !== "answer"),
  ),
  required: ["kind"],
  additionalProperties: false,
};

/** The final message, written on its own with the whole budget. */
const AGENT_DELIVER_SCHEMA = {
  type: "object",
  properties: {
    answer: AGENT_DECISION_SCHEMA.properties.answer,
  },
  required: ["answer"],
  additionalProperties: false,
};

/** Output budget per call. The step decision is small on purpose. */
const STEP_MAX_TOKENS = 900;
const DELIVER_MAX_TOKENS = 4000;

/**
 * The deliver-only user turn: the same task record, plus an explicit brief to
 * write the answer. No tool index, no "decide the next step" — the choice has
 * already been made.
 */
function buildDeliverUser(args = {}) {
  return [
    buildTaskUser({ ...args, extraNote: "" }).replace(
      /\n\nDecide the next structured step now\.$/,
      "",
    ),
    "You have decided the task is finished. Write the final message the user reads now.",
    "After an action, or after a report/artifact that already reached them as a card: a short confirmation of what they now have - never a re-write of it.",
    "After findings you gathered yourself (inbox, listing, comparison, a web lookup): a real markdown write-up - title, summary, sections, lists or a table, sources where you have them.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function decisionOutputContract() {
  return [
    "# Output Contract",
    "",
    "Respond with a single structured decision:",
    '- kind "use_tool": run one tool from the Tool Index. Set `tool` to its exact name and `instruction` to a complete, self-contained brief. The first time you select a tool this task, its full instructions are returned to you instead of running - read them, then issue the call again properly (or pick differently). Once its docs are in your context the call runs.',
    '- kind "deliver": the task is done (or genuinely cannot proceed) and `answer` is the final message. After an action, confirm what they now have. After findings, write a real markdown report they can keep - not a 1-4 sentence teaser. Deliver only when the work has actually run THIS task; the record below is what happened, and an empty record delivers nothing. A result sitting in the recent conversation is from an earlier turn - restating it is not delivery. Do not deliver a short wrap-up after reply or write_document: those tools already are the delivery. The browser\'s write-up also already reached the user - after it, finish any remaining parts of the task, then close in one line rather than repeating it. After research_report or edit_report the user has the document as a card - finish any remaining parts of the task, then deliver a short close instead of repeating it.',
    '- kind "ask_user": the task cannot continue without something only the user has. One question per task, everything bundled; put 2-4 complete tappable answers in `questionOptions` when you can genuinely propose them. Never ask permission to do the work itself - consequential actions get their own approval pause automatically. After they asked what is in a folder and you have the listing, deliver the summary. Do not ask which part they want.',
    'Set `risk`: "consequential" when the round\'s action spends money, destroys data, or delivers anything to another person (send, post, publish, share, submit). Working inside drafts and unshared deliverables is "low"; reading is "read".',
    "The TASK / SUCCESS CONDITION / DO NOT brief in the user message is authoritative. Never broaden or replace it. `successCondition` and `doNot` are optional planning suggestions for legacy callers only; TaskRuntime ignores them when a canonical Task is present.",
    "Always write `narration` - the user reads it live while you work.",
  ].join("\n");
}

/**
 * The byte-stable system prompt: rules + tool index + the contract. The
 * prompt is identical across tasks, so the cache prefix survives every run.
 */
function buildDecisionSystem({ localMode = false } = {}) {
  return [
    instructions.loadIdentityPrompt(),
    instructions.loadCoreRules(),
    registry.toolIndexBlock({ localMode }),
    instructions.loadSafetyRules(),
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
  connectedApps = [],
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
  // Which of the user's apps are already connected. The tool index tells the
  // model to prefer connected_apps over the browser "when the app is
  // connected" — without this list it had no way to know, so it defaulted to
  // opening a browser and logging in by hand. Lives in the per-round user
  // message, not the system prompt: the system prompt is byte-stable so its
  // cache prefix survives, and this list is per-user and changes.
  const connected = (Array.isArray(connectedApps) ? connectedApps : [])
    .map((a) => String(a?.name || a || "").trim())
    .filter(Boolean);
  const connectedBlock = connected.length
    ? `CONNECTED APPS (reachable right now via \`connected_apps\`, no login needed):\n${connected.join(", ")}\n` +
      `For anything in these apps use \`connected_apps\`, not the browser. Use the browser only for accounts NOT in this list.`
    : "";

  return [
    convo
      ? `RECENT CONVERSATION (references only - not this task's work):\n${convo}`
      : "",
    brief,
    attachmentsNote ? `ATTACHED BY THE USER:\n${attachmentsNote}` : "",
    connectedBlock,
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
    "You verify whether one tool run genuinely advanced an agent's task.",
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
  AGENT_DECISION_SCHEMA,
  AGENT_STEP_SCHEMA,
  AGENT_DELIVER_SCHEMA,
  STEP_MAX_TOKENS,
  DELIVER_MAX_TOKENS,
  buildDeliverUser,
  buildDecisionSystem,
  buildTaskUser,
  buildVerificationSystem,
  buildVerificationUser,
  decisionOutputContract,
};
