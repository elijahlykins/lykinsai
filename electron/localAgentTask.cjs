/**
 * Local Mode task runner for the Glass/Studio agent.
 *
 * Mirrors the browser agent's decide → act → observe loop, but the environment
 * is the user's machine (files + terminal) via electron/localSystem.cjs instead
 * of a web page. Reasoning goes through the same server structured endpoint
 * (POST /api/desktop/agent-model) so the Electron process holds no API keys.
 *
 * This module is the local brain behind LocalExecutor. It does not own a Task
 * lifecycle: TaskRuntime supplies the objective, signal, parent budget, and
 * approval/wait contract. Reads may run after a one-time grant; writes/deletes
 * and risky commands go through the same approval callback the browser agent
 * uses for consequential actions.
 */

const localSystem = require("./localSystem.cjs");
const {
  ALL_LOCAL_TOOLS,
  allowedToolNames,
  commandPermitted,
} = require("./task-runtime/executors/localCapabilities.cjs");

const DEFAULT_MAX_ROUNDS = 20;
const LOCAL_SAFETY_CEILING = 20;

const TOOL_ENUM = [...ALL_LOCAL_TOOLS];

function decisionSchemaFor(allowedTools) {
  const tools = TOOL_ENUM.filter((name) => !allowedTools || allowedTools.has(name));
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["act", "finish", "ask_user"] },
      tool: {
        type: "string",
        enum: tools.length ? tools : TOOL_ENUM,
      },
      args: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          replaceAll: { type: "boolean" },
          overwrite: {
            type: "boolean",
            description:
              "local_edit_file on a document (pdf/docx/rtf/odt/xlsx) only: replace the original file instead of writing a sibling '(edited)' copy",
          },
          command: { type: "string" },
          cwd: { type: "string" },
          namePattern: { type: "string" },
          query: { type: "string" },
          app: { type: "string" },
        },
        additionalProperties: false,
      },
      reason: { type: "string", description: "Human-readable next step, one short sentence" },
      answer: { type: "string", description: "Final user-facing answer when kind=finish" },
      question: { type: "string", description: "Question for the user when kind=ask_user" },
    },
    required: ["kind"],
    additionalProperties: false,
  };
}

const DECISION_SCHEMA = decisionSchemaFor(null);

const TOOL_LINES = {
  local_list_dir: "- local_list_dir { path } — list a folder (read-only).",
  local_read_file:
    "- local_read_file { path } — read a file (read-only). Text files return as-is; documents — PDF, Word (docx/doc/rtf/odt), Excel (xlsx), PowerPoint (pptx) — are extracted to text, page by page or sheet by sheet.",
  local_search_files:
    "- local_search_files { path, namePattern, query } — find files or folders by name, or files by text (read-only).",
  local_write_file: "- local_write_file { path, content } — create/overwrite a file (asks the user first).",
  local_edit_file:
    "- local_edit_file { path, oldText, newText, replaceAll?, overwrite? } — replace an exact snippet inside an existing file (asks the user first). Read the file first; oldText must match verbatim and be unique unless replaceAll. Text files edit in place. Documents work too: xlsx edits the matching cells and keeps formulas/formatting; PDF and Word/RTF/ODT are regenerated from their text, so styling is flattened. Document edits write a sibling 'name (edited).ext' by default and leave the original alone — pass overwrite: true only if the user asked to replace the original.",
  local_run_command:
    "- local_run_command { command, cwd } — run a shell command (safe ones run immediately; risky ones ask first).",
  local_synced_folders:
    "- local_synced_folders {} — list the folders the user synced with LYKN (your filesystem scope).",
  local_running_apps: "- local_running_apps {} — see which apps are open and which is frontmost.",
  local_read_app:
    "- local_read_app { app } — read what's showing inside an app (Spotify: current track; browsers: active tab; others: on-screen text via Accessibility). Omit app for the frontmost one.",
  local_open_app:
    "- local_open_app { app } — open a Mac app and bring it into view on the user's desktop, like clicking it in the dock (runs immediately).",
  local_open_path:
    "- local_open_path { path } — open a file in LYKN's preview pop, or a folder in the Vault Finder.",
};

function buildSystemPrompt(allowedTools) {
  const tools = TOOL_ENUM.filter((name) => !allowedTools || allowedTools.has(name));
  const lines = [
    "You are LYKN operating directly on the user's Mac in Local Mode.",
    "You can only use the tools listed below. Work one step at a time, deciding from the results you observe.",
    "",
    "Tools:",
    ...tools.map((name) => TOOL_LINES[name]).filter(Boolean),
    "",
    "Rules:",
    "- Explore with reads before writing or running mutating commands.",
    "- Paths may be absolute, start with ~, or be relative to the home folder.",
    "- File access is limited to the user's synced folders — check local_synced_folders if a path is refused.",
    "- Use local_open_path for files and folders. Never open Finder as a substitute for opening a path.",
    "- When the goal is done, return kind=finish with a concise summary of what you did.",
    "- If you truly cannot proceed without the user, return kind=ask_user with a specific question.",
    "- Do not keep looking for extra work after the requested result is in hand.",
  ];
  return lines.join("\n");
}

const SYSTEM_PROMPT = buildSystemPrompt(null);

function summariseResult(result) {
  if (!result || typeof result !== "object") return String(result || "");
  const clone = { ...result };
  // Trim large fields so the running history stays small.
  if (typeof clone.content === "string" && clone.content.length > 1500) {
    clone.content = clone.content.slice(0, 1500) + "\n…[truncated]";
  }
  if (typeof clone.output === "string" && clone.output.length > 1500) {
    clone.output = clone.output.slice(0, 1500) + "\n…[truncated]";
  }
  if (Array.isArray(clone.entries) && clone.entries.length > 60) {
    clone.entries = clone.entries.slice(0, 60);
  }
  if (Array.isArray(clone.results) && clone.results.length > 60) {
    clone.results = clone.results.slice(0, 60);
  }
  try {
    return JSON.stringify(clone).slice(0, 4000);
  } catch {
    return String(clone.error || clone.output || "done");
  }
}

function collectChangedFiles(history) {
  const files = [];
  for (const h of history || []) {
    if (!h || h.approved === false) continue;
    if (h.tool === "local_write_file" || h.tool === "local_edit_file") {
      const p = String(h.args?.path || "").trim();
      if (p) files.push(p);
    }
  }
  return files;
}

function progressEventForTool(tool, args = {}, result = null) {
  if (tool === "local_read_file" || tool === "local_list_dir" || tool === "local_search_files") {
    return { event: "local.file_read", path: String(args.path || "") };
  }
  if (tool === "local_write_file" || tool === "local_edit_file") {
    return { event: "local.file_changed", path: String(args.path || "") };
  }
  if (tool === "local_run_command") {
    return result
      ? {
          event: "local.command_completed",
          command: String(args.command || "").slice(0, 200),
          ok: result.ok !== false,
        }
      : { event: "local.command_started", command: String(args.command || "").slice(0, 200) };
  }
  return { event: "local.progress", tool };
}

/**
 * An explicit path plus a read-only ask can skip the planner loop.
 * Returns null when the work is not obviously a single read/list.
 */
function tryDeterministicLocalAction(goal, allowedTools) {
  const text = String(goal || "").trim();
  if (!text) return null;
  const writeish =
    /\b(write|edit|create|save|overwrite|move|copy|rename|delete|remove|run|install|fix|replace)\b/i.test(
      text,
    );
  if (writeish) return null;
  const pathMatch = text.match(/(~\/[^\s"'`]+|\/(?:Users|users|home)\/[^\s"'`]+)/);
  if (!pathMatch) return null;
  const target = pathMatch[1].replace(/[.,;:]+$/, "");
  const looksLikeList =
    /\b(list|ls|what's in|whats in|show (me )?the (folder|directory|contents))\b/i.test(text);
  if (looksLikeList && allowedTools.has("local_list_dir")) {
    return { tool: "local_list_dir", args: { path: target } };
  }
  if (allowedTools.has("local_read_file")) {
    return { tool: "local_read_file", args: { path: target } };
  }
  return null;
}

async function callModel({ apiBase, getAuthToken, fetchImpl, onUsage }, { system, user, schema, signal }) {
  const doFetch = fetchImpl || fetch;
  const token = await getAuthToken?.().catch(() => null);
  if (!token) throw new Error("not signed in");
  const started = Date.now();
  const res = await doFetch(`${apiBase}/api/desktop/agent-model`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      stage: "decide",
      system,
      user,
      schema: schema || DECISION_SCHEMA,
      maxTokens: 900,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`agent model call failed (${res.status}): ${text.slice(0, 160)}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!data || data.ok === false || data.json == null) {
    throw new Error(`agent model returned no result: ${String(data?.error || "").slice(0, 160)}`);
  }
  try {
    onUsage?.({
      stage: "local_decide",
      model: data.model || "",
      provider: data.provider || "",
      inputTokens: Number(data.usage?.inputTokens) || 0,
      outputTokens: Number(data.usage?.outputTokens) || 0,
      upstreamMs: Number(data.upstreamMs) || Date.now() - started,
    });
  } catch {
    /* accounting must never break a run */
  }
  return data.json;
}

function emptyUsage() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, upstreamMs: 0, byStage: {} };
}

function addUsage(usage, entry) {
  if (!usage || !entry) return;
  usage.calls += 1;
  usage.inputTokens += entry.inputTokens || 0;
  usage.outputTokens += entry.outputTokens || 0;
  usage.upstreamMs += entry.upstreamMs || 0;
  const stage = String(entry.stage || "other");
  const bucket =
    usage.byStage[stage] ||
    (usage.byStage[stage] = { calls: 0, inputTokens: 0, outputTokens: 0, upstreamMs: 0 });
  bucket.calls += 1;
  bucket.inputTokens += entry.inputTokens || 0;
  bucket.outputTokens += entry.outputTokens || 0;
  bucket.upstreamMs += entry.upstreamMs || 0;
}

function declineKey(tool, args) {
  try {
    return `${tool}:${JSON.stringify(args || {})}`;
  } catch {
    return String(tool);
  }
}

/**
 * Run one local task to completion (or until user input / approval is needed).
 *
 * @returns {Promise<{ok:boolean, status:string, answer:string, history:Array, usage?:object}>}
 */
async function runLocalAgentTask({
  goal,
  apiBase,
  getAuthToken,
  fetchImpl,
  conversationHistory = [],
  signal = null,
  maxRounds = DEFAULT_MAX_ROUNDS,
  capabilities = null,
  allowedTools = null,
  onProgress = () => {},
  onApprovalNeeded = null,
  onUsage = null,
  runTool = null,
  // Standing authorization (Task approval.policy "standing_authorization",
  // carried by Bot Routines): ordinary work inside the task's explicit
  // capability envelope — reads, writes to working files, routine shell
  // commands — runs without per-action approval, because nobody is at the
  // keyboard to click Approve at 8 AM. CONSEQUENTIAL actions (destructive
  // commands, credentials, external pushes — classifyRisk's risky tier for
  // commands) still pause for live approval regardless of this flag.
  standingAuthorization = false,
}) {
  const history = [];
  const usage = emptyUsage();
  const aborted = () => signal?.aborted === true;
  const tools =
    allowedTools instanceof Set
      ? allowedTools
      : allowedToolNames(capabilities) || new Set(ALL_LOCAL_TOOLS);
  const schema = decisionSchemaFor(tools);
  const system = buildSystemPrompt(tools);
  const executeTool = typeof runTool === "function" ? runTool : localSystem.run;
  const rounds = Math.max(1, Math.min(LOCAL_SAFETY_CEILING, Number(maxRounds) || DEFAULT_MAX_ROUNDS));
  // Read-class tools ask once per task before the first file access; the
  // grant then covers the rest of this task. Writes/commands ask per action.
  const READ_TOOLS = new Set([
    "local_list_dir",
    "local_read_file",
    "local_search_files",
    "local_pull_file",
  ]);
  let readAccessGranted = false;
  const declined = new Set();

  const recordUsage = (entry) => {
    addUsage(usage, entry);
    try {
      onUsage?.(entry);
    } catch {
      /* ignore */
    }
  };

  const convo = (conversationHistory || [])
    .slice(-6)
    .map((m) => `${m?.role === "assistant" ? "LYKN" : "User"}: ${String(m?.content || "").slice(0, 400)}`)
    .join("\n");

  const cancelled = (answer = "Task cancelled.") => ({
    ok: false,
    status: "cancelled",
    answer,
    history,
    usage,
  });

  const finishWith = (status, answer, extra = {}) => ({
    ok: status !== "failed" && status !== "cancelled",
    status,
    answer: String(answer || "").trim() || (status === "completed" ? "Done." : ""),
    history,
    usage,
    changedFiles: collectChangedFiles(history),
    ...extra,
  });

  async function maybeApproveAndRun(tool, args) {
    if (!localSystem.isLocalToolName(tool) || !tools.has(tool)) {
      return { blocked: true, summary: "tool not permitted for this task" };
    }
    if (tool === "local_run_command") {
      const risk = localSystem.classifyRisk(tool, args);
      if (!commandPermitted(args.command, capabilities || ["local"], risk)) {
        return { blocked: true, summary: "shell command not permitted for this task" };
      }
    }
    const key = declineKey(tool, args);
    if (declined.has(key)) {
      return { blocked: true, summary: "previously declined — not retried" };
    }

    if (READ_TOOLS.has(tool) && !readAccessGranted && standingAuthorization) {
      // files.read inside the routine's envelope IS the standing grant.
      readAccessGranted = true;
    }
    if (READ_TOOLS.has(tool) && !readAccessGranted) {
      onProgress({ phase: "awaiting_approval", tool, summary: "Look through your files" });
      let allowed = false;
      if (typeof onApprovalNeeded === "function") {
        const where = String(args.path || "").trim();
        allowed = await onApprovalNeeded({
          question: `Allow LYKN to look through your files${where ? ` (starting with ${where})` : ""} for this task?`,
          summary: `Browse your files${where ? `: ${where}` : ""}`,
          tool,
          args,
        }).catch(() => false);
      }
      if (aborted()) return { cancelled: true };
      if (!allowed) {
        declined.add(key);
        return {
          waiting: true,
          needsApproval: true,
          answer: "I need your permission to look through your files before I can do this.",
          historyItem: { tool, args, approved: false, summary: "file access declined" },
        };
      }
      readAccessGranted = true;
    }

    const risk = localSystem.classifyRisk(tool, args);
    let approved = true;
    // Standing authorization auto-approves ordinary FILE writes/edits inside
    // the capability envelope. Shell commands never ride this branch: a
    // command classifyRisk marks risky is consequential-tier by definition
    // now, and consequential actions always take the live-approval path
    // below, standing authorization or not.
    const standingCovers =
      standingAuthorization &&
      risk.risky &&
      (tool === "local_write_file" || tool === "local_edit_file");
    if (risk.risky && !standingCovers) {
      onProgress({ phase: "awaiting_approval", tool, summary: risk.summary, event: "local.approval_required" });
      if (typeof onApprovalNeeded === "function") {
        approved = await onApprovalNeeded({
          question: `Approve before I ${risk.summary}?`,
          summary: risk.summary,
          tool,
          args,
        }).catch(() => false);
      } else {
        approved = false;
      }
      if (aborted()) return { cancelled: true };
      if (!approved) {
        declined.add(key);
        return {
          waiting: true,
          needsApproval: true,
          answer: `I've prepared the next step but need your approval first: ${risk.summary}.`,
          historyItem: { tool, args, approved: false, summary: "awaiting approval" },
        };
      }
    }

    if (tool === "local_run_command") {
      onProgress(progressEventForTool(tool, args, null));
    }
    let result;
    try {
      result = await executeTool(tool, args, { approved, signal });
    } catch (e) {
      result = { ok: false, error: e?.message || String(e) };
    }
    if (aborted()) return { cancelled: true };
    onProgress(progressEventForTool(tool, args, result));
    return { result, approved };
  }

  onProgress({ phase: "planning", event: "local.progress" });

  const deterministic = tryDeterministicLocalAction(goal, tools);
  if (deterministic) {
    if (aborted()) return cancelled();
    const ran = await maybeApproveAndRun(deterministic.tool, deterministic.args);
    if (ran.cancelled) return cancelled();
    if (ran.waiting) {
      return finishWith("waiting_for_user", ran.answer, {
        needsUser: true,
        needsApproval: ran.needsApproval === true,
        history: [...history, ran.historyItem],
      });
    }
    if (!ran.blocked) {
      history.push({
        tool: deterministic.tool,
        args: deterministic.args,
        approved: ran.approved,
        summary: summariseResult(ran.result),
      });
      const wantsSummary = /\b(summar(y|ise|ize)|explain|what does|tell me about)\b/i.test(
        String(goal || ""),
      );
      if (!wantsSummary) {
        const raw = ran.result?.content || ran.result?.output || summariseResult(ran.result);
        return finishWith("completed", String(raw || "Done.").trim() || "Done.");
      }
      // One finish-oriented call to phrase the already-fetched content. Not a planner loop.
      try {
        const decision = await callModel(
          { apiBase, getAuthToken, fetchImpl, onUsage: recordUsage },
          {
            system:
              "Summarize the local file result for the user. Return kind=finish with a concise answer. Do not call tools.",
            user: `Goal: ${goal}\n\nResult:\n${summariseResult(ran.result)}`,
            schema,
            signal,
          },
        );
        if (aborted()) return cancelled();
        if (decision?.kind === "ask_user") {
          return finishWith(
            "waiting_for_user",
            String(decision.question || "I need your input to continue.").trim(),
            { needsUser: true },
          );
        }
        return finishWith(
          "completed",
          String(decision?.answer || summariseResult(ran.result) || "Done.").trim() || "Done.",
        );
      } catch (e) {
        if (aborted()) return cancelled();
        return finishWith("completed", summariseResult(ran.result) || String(e?.message || "Done."));
      }
    }
  }

  for (let round = 1; round <= rounds; round += 1) {
    if (aborted()) return cancelled();

    const historyText = history.length
      ? history
          .map(
            (h, i) =>
              `${i + 1}. ${h.tool}(${JSON.stringify(h.args)}) → ${h.approved === false ? "DECLINED by user" : h.summary}`,
          )
          .join("\n")
      : "(nothing done yet)";

    const user = [
      convo ? `Recent conversation:\n${convo}\n` : "",
      `Goal: ${goal}`,
      "",
      `Steps so far:\n${historyText}`,
      "",
      "Decide the single next action (act / finish / ask_user).",
      "Stop when the requested result is in hand. Remaining rounds are not a reason to continue.",
    ]
      .filter(Boolean)
      .join("\n");

    let decision;
    try {
      decision = await callModel(
        { apiBase, getAuthToken, fetchImpl, onUsage: recordUsage },
        { system, user, schema, signal },
      );
    } catch (e) {
      if (aborted()) return cancelled();
      return finishWith(
        "failed",
        `I couldn't reach the reasoning service: ${e?.message || e}`,
      );
    }

    if (aborted()) return cancelled();

    const kind = ["act", "finish", "ask_user"].includes(decision?.kind) ? decision.kind : "act";

    if (kind === "finish") {
      return finishWith(
        "completed",
        String(decision.answer || "Done.").trim() || "Done.",
      );
    }
    if (kind === "ask_user") {
      return finishWith(
        "waiting_for_user",
        String(decision.question || "I need your input to continue.").trim(),
        { needsUser: true },
      );
    }

    const tool = String(decision.tool || "");
    const args = decision.args && typeof decision.args === "object" ? decision.args : {};
    if (!localSystem.isLocalToolName(tool) || !tools.has(tool)) {
      history.push({
        tool: tool || "(none)",
        args,
        summary: "tool not permitted for this task — ignored",
      });
      continue;
    }

    onProgress({
      phase: "acting",
      tool,
      args,
      reason: String(decision.reason || "").slice(0, 160),
      event: "local.progress",
    });

    const ran = await maybeApproveAndRun(tool, args);
    if (ran.cancelled) return cancelled();
    if (ran.waiting) {
      return finishWith("waiting_for_user", ran.answer, {
        needsUser: true,
        needsApproval: ran.needsApproval === true,
        history: [...history, ran.historyItem],
      });
    }
    if (ran.blocked) {
      history.push({ tool, args, summary: ran.summary });
      continue;
    }
    history.push({
      tool,
      args,
      approved: ran.approved,
      summary: summariseResult(ran.result),
    });
  }

  return finishWith(
    "failed",
    "I ran out of steps before finishing. Here's what I got through: " +
      (history.slice(-3).map((h) => h.tool).join(", ") || "no completed steps") +
      ".",
    { reason: "round_budget_exhausted" },
  );
}

/**
 * Heuristic: does this ask want work on the user's local machine (files /
 * terminal)? Only consulted when Local Mode is enabled.
 */
function looksLikeLocalSystemAsk(text) {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return false;
  // Well-known local folders ("my downloads folder", "on my desktop").
  if (/\b(my\s+)?(downloads?|documents|desktop|home|applications|pictures|movies|music)\s+folder\b/.test(t)) {
    return true;
  }
  // Explicit "on my computer/mac/machine/laptop/disk" framing.
  if (/\b(on|from|in)\s+(my\s+)?(computer|mac|macbook|machine|laptop|desktop|downloads|hard\s*drive|disk|filesystem|file system)\b/.test(t)) {
    return true;
  }
  // App-content asks ("what song is this", "what's playing", "what's open in
  // Cursor") — answered by local_read_app / local_running_apps.
  if (/\b(what('| i)?s|whats)\s+(playing|open|on( the| my)? screen)\b/.test(t)) return true;
  if (/\b(current|this|that) (song|track|tab|app|window)\b/.test(t)) return true;
  if (/\b(now playing|what song|what track|which app)\b/.test(t)) return true;
  // App-launch asks ("open Spotify", "pull up Safari") — answered by
  // local_open_app. Require the word app/application or a well-known app name
  // so generic "open"s ("open an account") don't trip it.
  if (/\b(open|launch|start|pull up|bring up)\b.*\b(app|application)\b/.test(t)) return true;
  if (/\b(open|launch|start|pull up|bring up|switch to)\s+(the\s+)?(spotify|safari|chrome|firefox|arc|finder|notes|music|messages|imessage|mail|calendar|terminal|cursor|slack|discord|figma|photoshop|xcode|vs ?code|facetime|photos|reminders|preview|pages|numbers|keynote|obsidian|notion|zoom|whatsapp|telegram)\b/.test(t)) {
    return true;
  }
  // Terminal / shell commands.
  if (/\b(terminal|shell|command line|run\s+(the\s+)?command|zsh|bash|(npm|yarn|pnpm|pip3?|brew)\s+(run|install|uninstall|update|upgrade|list)|git\s+(status|commit|clone|pull|push)|chmod|mkdir|open\s+the\s+terminal)\b/.test(t)) {
    return true;
  }
  // Tidying the Home desktop ("organise my desktop", "clean up the desktop
  // into a grid") — answered by local_organize_desktop. "desktop" on its own
  // is too common to key on, so it has to be paired with a tidying verb.
  if (/\b(organi[sz]e|tidy|clean\s*up|arrange|straighten|line\s*up|sort)\b[^.?!]*\bdesktop\b/.test(t)) {
    return true;
  }
  if (/\bdesktop\b[^.?!]*\b(into|in|on)\s+(a\s+)?grid\b/.test(t)) return true;
  // Local file operations with a path-ish reference.
  if (
    /\b(read|open|edit|create|write|delete|rename|move|search|find|list)\b/.test(t) &&
    /\b(file|files|folder|folders|directory|directories|script|\.txt|\.md|\.js|\.ts|\.py|\.json|\.csv|~\/|\/users\/)\b/.test(t) &&
    // Don't hijack "create a document/deck/presentation" artifact builds.
    !/\b(document|doc|deck|slides?|presentation|spreadsheet|report|artifact|image|video|website|landing page)\b/.test(t)
  ) {
    return true;
  }
  // Path-like tokens are a strong local signal.
  if (/(^|\s)(~\/[\w./-]+|\/(users|applications|library|volumes)\/[\w./-]+)/.test(t)) {
    return true;
  }
  return false;
}

module.exports = {
  runLocalAgentTask,
  looksLikeLocalSystemAsk,
  DECISION_SCHEMA,
  tryDeterministicLocalAction,
  LOCAL_SAFETY_CEILING,
};
