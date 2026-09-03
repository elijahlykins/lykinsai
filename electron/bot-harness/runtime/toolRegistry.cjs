/**
 * The Bot's tool registry - the heart of the harness's progressive
 * disclosure.
 *
 * The system prompt carries only this index: one name and one line per tool.
 * The model chooses from the index; the FIRST time it selects a tool in a
 * task, the loop does not execute - it loads the tool's full markdown doc
 * into the task context and asks for the decision again, now with the real
 * contract in view. From then on the doc stays loaded for the rest of the
 * task. Reading before using is what keeps instructions to tools complete
 * and honest; an index line cannot teach a model how to brief a builder.
 *
 * `risk` is the tool's floor, not its ceiling: the decision's own risk field
 * can raise a call to consequential, never lower one below the registry.
 */

const instructions = require("./instructions.cjs");

const TOOLS = [
  {
    name: "reply",
    summary:
      "Answer the user directly in chat - explanations, opinions, writing and editing text, drafts, math, advice, summaries.",
    risk: "read",
    verify: false,
    // A successful reply already reached the user in full; the loop may end
    // the task on it without a separate delivery round.
    terminal: true,
  },
  {
    name: "write_document",
    summary:
      "Write a letter, memo, notes, or simple document as an HTML file, save it to Downloads and AI Drive, and open it.",
    risk: "low",
    verify: false,
    terminal: true,
  },
  {
    name: "research_report",
    summary:
      "Produce a deep, sourced research report on a topic (delivered to the user as a document card).",
    risk: "low",
    verify: true,
    // The report becomes a document card the user keeps, so the loop can
    // continue when the task has more parts (email the highlights, save it
    // somewhere). Deliver closes with a short note. Artifact conversions
    // ("report → presentation") skip this tool entirely — see the tool docs.
    terminal: false,
  },
  {
    name: "edit_report",
    summary: "Revise the research report already produced in this task or conversation.",
    risk: "low",
    verify: true,
    // Same shape as research_report: the updated document card is the work,
    // the deliver answer is a short close.
    terminal: false,
  },
  {
    name: "build_artifact",
    summary:
      "Build a working app, website, page, presentation, game, or interactive tool (opens live). Researches its own content - one call covers \"research X and turn it into a deck\".",
    risk: "low",
    verify: true,
    terminal: false,
  },
  {
    name: "generate_image",
    summary: "Generate a picture: art, a logo, a photo, a visual design (opens for the user).",
    risk: "low",
    verify: true,
    terminal: false,
  },
  {
    name: "local_computer",
    summary:
      "Work on the user's own computer: read and edit their files and documents (PDF, Word, Excel), " +
      "run terminal commands, and open apps or files on their screen. Cannot delete files. " +
      "AI Drive (things LYKN built) is a different tool: ai_drive.",
    risk: "low", // the local runner holds its own per-action approvals
    verify: true,
    terminal: false,
    requiresLocalMode: true,
  },
  {
    name: "ai_drive",
    summary:
      "Open and scan AI Drive - artifacts and generated images LYKN has built. Not the Mac disk.",
    risk: "read",
    verify: false,
    terminal: false,
  },
  {
    name: "create_routine",
    summary:
      "Set up a recurring or triggered routine this bot will run on its own - a schedule (\"every minute\", \"every weekday at 8\"), an inbox watch (\"monitor my email\"), or a file/page watch. Creating it runs nothing yet.",
    // Creating a routine is reversible (pause/delete one click away) and the
    // user asked for it in the same breath - the consequential surface is the
    // work each occurrence does, which the routine's own capability envelope
    // and the runtime's approval tiers govern.
    risk: "low",
    verify: false,
    terminal: false,
  },
  {
    name: "connected_apps",
    summary:
      "Act in the user's connected apps (Gmail, Slack, Notion, GitHub…) through their secure LYKN connection - search mail, send messages, create pages. Prefer this over the browser when the app is connected.",
    // Consequential calls (send, post, delete) pause for user approval
    // inside the MCP execution stack; reads run without ceremony.
    risk: "low",
    verify: true,
    terminal: false,
  },
  {
    name: "browser",
    summary:
      "Open the real browser and operate a live website or the user's own online account - send, buy, book, post, submit, check their mail. If the account's app is connected, use connected_apps instead.",
    // Selecting this tool starts the browse run. Consequential acts (send,
    // buy, post) are confirmed inside the browse pipeline's own safety, so
    // a "consequential" floor here would make the user approve opening the
    // tab before any of those acts are even proposed.
    risk: "low",
    verify: false, // the browser agent verifies its own rounds
    // The browser's finish answer is the report the user reads. A second
    // harness delivery used to overwrite it with a 1-4 sentence teaser.
    terminal: true,
  },
];

function listTools({ localMode = false } = {}) {
  return TOOLS.filter((t) => !t.requiresLocalMode || localMode);
}

function getTool(name, { localMode = false } = {}) {
  return listTools({ localMode }).find((t) => t.name === String(name || "")) || null;
}

/** The index block the system prompt carries - names + one line each. */
function toolIndexBlock({ localMode = false } = {}) {
  const lines = listTools({ localMode }).map((t) => `- \`${t.name}\` - ${t.summary}`);
  return ["# Tool Index", "", ...lines, "", "Full instructions for a tool are provided the first time you select it."].join(
    "\n",
  );
}

/** Full doc for one tool, wrapped with its heading so it reads in context. */
function toolDocBlock(name) {
  const doc = instructions.loadToolDoc(name);
  return doc || "";
}

module.exports = { TOOLS, listTools, getTool, toolIndexBlock, toolDocBlock };
