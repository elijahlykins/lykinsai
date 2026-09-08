// ============================================================================
// agentStallPolicy.js — stall detection + continuation nudges for agent turns
// ============================================================================
// Owns the policy for "the model stopped but the work is not done": reading
// abandonment from tool-call shapes (workspace builds, desktop-MCP app
// driving), classifying the stall, and picking the corrective prompt that
// pushes the model back to work. Pure functions — no streaming, no provider
// awareness. chat-agent-loop.js consults this after each hop.
// Moved verbatim from chat-agent-loop.js when it outgrew its budget.

const MAX_WORKSPACE_CONTINUE_NUDGES = 2;
const WORKSPACE_CONTINUE_PROMPT =
  'Progress check — do not narrate your next step and stop. If the user asked a question ' +
  'and it is fully answered, give the final answer now. Otherwise keep working with tool ' +
  'calls: finish the remaining files, install what is missing, then RUN the build/tests/' +
  'dev server and fix what fails. A finished app must be left RUNNING via ' +
  'local_start_process with its URL in your summary. Only when a real check has passed ' +
  'this session may you write the final summary. Keep that summary short: what you did, ' +
  'where it is, and how to open it. Do not repeat the brief or a hop-by-hop recap.';
const WORKSPACE_CODE_DUMP_PROMPT =
  'You pasted the build as a code block in chat. The user cannot run chat text — this ' +
  'build happens in the Build workspace as a REAL project. Do it now with tool calls: ' +
  'local_build_workspace for the root, local_write_file for each file, install what is ' +
  'needed, then RUN it (local_run_command / local_start_process) and report the URL. ' +
  'Do not repeat the code in chat.';
const WORKSPACE_TOOLS_ARMED_PROMPT =
  'Check your tool list: your workspace tools ARE armed on this turn — local_read_file, ' +
  'local_edit_file, local_write_file, local_run_command, local_start_process, ' +
  'local_install_app and more. Do not tell the user you lack access or to resend. ' +
  'Open the project (local_build_workspace lists it), make the requested changes, ' +
  'validate them, and re-run the dev server so the user sees the update; if the app ' +
  'is installed in their dock, ask whether to install the update before reinstalling. ' +
  'If a tool call actually fails, report that exact error instead.';

const WORKSPACE_WRITE_TOOLS = new Set(['local_write_file', 'local_edit_file']);
const WORKSPACE_EXEC_TOOLS = new Set([
  'local_run_command',
  'local_start_process',
  'local_process_status',
  'local_stop_process',
  // Installing to the dock only succeeds against a real production build, so
  // it counts as validation, not as an unvalidated write.
  'local_install_app',
]);
const WORKSPACE_READ_TOOLS = new Set([
  'local_build_workspace',
  'local_list_dir',
  'local_read_file',
  'local_search_files',
]);

/**
 * A reply whose substance is a big fenced code block. Small snippets in an
 * answer ("run `npm start`", a config example) stay under the floor; a pasted
 * app, game, or page sails over it.
 */
const CODE_DUMP_MIN_BLOCK_CHARS = 800;
function looksLikeCodeDump(text) {
  const blocks = String(text || '').match(/```[\s\S]*?```/g);
  return !!blocks && blocks.some((b) => b.length >= CODE_DUMP_MIN_BLOCK_CHARS);
}

/**
 * A reply claiming the assistant cannot reach the user's machine/project —
 * on a workspace turn with local tools armed that is never true, just the
 * generic "AI can't touch your files" prior overriding the tool list.
 * Observed live: "this turn I don't have live access to your Mac's files …
 * send this same message again" and "The tools I have right now are web and
 * connected-app tools only, not the file-reading tools for your Mac, so I
 * can't open ~/LYKN/Builds/…". Deliberately narrow: an access/inventory
 * CLAIM plus a files/project/tools object, so ordinary answers never match.
 */
const NO_ACCESS_CLAIM_RE = new RegExp(
  [
    // "I don't have (live) access/reach ... to your files/Mac/project"
    /\b(?:don'?t|do not|can'?t|cannot|no longer)\s+(?:have\s+)?(?:live\s+|direct\s+)?(?:access|reach|touch|open|edit)[^.\n]{0,80}\b(?:files?|folders?|mac|machine|project|workspace|local tools?)\b/
      .source,
    // "once/when the local|file(-reading) tools are back/available"
    /\b(?:local|file(?:[- ]reading)?|workspace)\s+tools?\b[^.\n]{0,50}\b(?:are|come)\s+(?:back|available)\b/
      .source,
    // "the tools I have right now are web ... only" (inventory beg-off)
    /\btools?\s+i\s+have\b[^.\n]{0,60}\bonly\b/.source,
    // "not the file-reading/local tools (for your Mac)"
    /\bnot\s+the\s+(?:file(?:[- ](?:reading|editing))?|local)\s*tools?\b/.source,
    // "I can't (actually) open ~/LYKN/Builds/…/main.js" (path-anchored)
    /\bcan'?t\s+(?:actually\s+)?open\s+\S*\//.source,
  ].join('|'),
  'i',
);
function looksLikeNoAccessClaim(text) {
  return NO_ACCESS_CLAIM_RE.test(String(text || ''));
}

/**
 * How a workspace turn was abandoned, or null when its shape is consistent
 * with finished work. Behavioral first, one text check for the zero-tool case:
 *
 *   'unvalidated'   wrote project files with no execution afterwards — no
 *                   command, no test run, no server start. The signature of
 *                   "Scaffold is in place. Next I'll…" and stop; never of a
 *                   finished build, whose contract requires a validation run
 *                   after the last edit.
 *   'inspect-only'  read the project and then stopped without writing or
 *                   running anything. Either a resumed build that stalled
 *                   after inspection, or a plain question about the code —
 *                   the nudge prompt lets a genuine Q&A turn simply answer,
 *                   so this reason is only worth ONE nudge.
 *   'code-in-chat'  ZERO tool calls but the reply is dominated by a fenced
 *                   code block — the model wrote the deliverable as chat text
 *                   (the old artifact reflex) instead of building on disk.
 *   'claimed-no-access'  ZERO tool calls and the reply claims it cannot reach
 *                   the user's files/project — false by construction on a
 *                   workspace turn; the tools are in its list.
 *                   Other plain zero-tool answers stay un-nudged: with no
 *                   behavior to read, "chatting" and "stalling" look the same.
 */
function workspaceStallReason(toolCalls, finalText = '') {
  let lastWrite = -1;
  let lastExec = -1;
  let reads = 0;
  let total = 0;
  (Array.isArray(toolCalls) ? toolCalls : []).forEach((call, i) => {
    const name = String(call?.name || '');
    total += 1;
    if (WORKSPACE_WRITE_TOOLS.has(name)) lastWrite = i;
    else if (WORKSPACE_EXEC_TOOLS.has(name)) lastExec = i;
    else if (WORKSPACE_READ_TOOLS.has(name)) reads += 1;
  });
  if (lastWrite >= 0) return lastExec < lastWrite ? 'unvalidated' : null;
  if (lastExec >= 0) return null;
  if (reads > 0) return 'inspect-only';
  if (total === 0 && looksLikeCodeDump(finalText)) return 'code-in-chat';
  if (total === 0 && looksLikeNoAccessClaim(finalText)) return 'claimed-no-access';
  return null;
}

// ---------------------------------------------------------------------------
// Desktop MCP stalls — the "half-built Porsche" problem. Driving an app
// through local_mcp_call_tool is the same abandon-shaped risk as a workspace
// build: the model does a few actions, narrates the rest, and stops.
// ---------------------------------------------------------------------------

/** Creative work is allowed more pushes: early stopping is its failure mode. */
const MAX_DESKTOP_MCP_CONTINUE_NUDGES = 3;

const DESKTOP_MCP_CONTINUE_PROMPT =
  'Progress check — the user asked for a COMPLETE result, not a first pass. If the work ' +
  'is genuinely finished AND you have verified it (scene info, screenshot, status tools), ' +
  'give the final summary now. Otherwise keep going with local_mcp_call_tool: work through ' +
  'EVERY remaining part in detail, and after each meaningful change LOOK at the result — ' +
  'never act blind, never stop right after an action without observing what it produced. ' +
  'Do not narrate future steps ("next I\'ll add…") and end the turn; DO those steps now. ' +
  'A half-built model, scene, or track is not a deliverable. If a tool call truly fails ' +
  'in a way you cannot work around, report the exact error and exactly what remains.';

/**
 * Mirrors READ_TOOL_RE in electron/mcp/localMcpHost.cjs: read-shaped MCP
 * sub-tools observe the app, everything else mutates it. Keep in sync.
 */
const MCP_READ_SUBTOOL_RE =
  /^(get|list|read|search|find|show|describe|inspect|status|screenshot|capture|view|query|fetch|check|ping|info)([_\-.]|$)/i;

/**
 * Future-commitment narration: "next I'll add the wheels", "still need to
 * model the interior". Deliberately requires commitment phrasing so a
 * finished summary's OFFER ("want more? I can add spoilers") never matches.
 */
const MCP_MIDTASK_NARRATION_RE = new RegExp(
  [
    /\bnext,?\s+i(?:'ll| will)\b/.source,
    /\bi(?:'ll| will)\s+(?:now|then|continue|keep|proceed|move on)\b/.source,
    /\b(?:now|then)\s+i(?:'ll| will)\b/.source,
    /\bstill\s+(?:need|have)\s+to\s+(?:add|build|create|model|make|finish|do)\b/.source,
    /\b(?:the\s+)?remaining\s+(?:steps?|parts?|pieces?|work)\b/.source,
    /\babout\s+to\s+(?:add|build|create|model|start)\b/.source,
  ].join('|'),
  'i',
);

/**
 * How a desktop-MCP turn was abandoned, or null when it looks finished:
 *
 *   'unverified'  the LAST app-mutating call was never followed by a look
 *                 (scene info / screenshot / status). Acting blind and
 *                 stopping is the exact signature of a partial build — a
 *                 finished one ends on verification by contract.
 *   'mid-task'    it did observe, but the reply commits to future steps
 *                 ("next I'll add the wheels") instead of doing them.
 */
function desktopMcpStallReason(toolCalls, finalText = '') {
  let lastAct = -1;
  let lastLook = -1;
  let appCalls = 0;
  (Array.isArray(toolCalls) ? toolCalls : []).forEach((call, i) => {
    const name = String(call?.name || '');
    if (name === 'local_mcp_call_tool') {
      appCalls += 1;
      const sub = String(call?.args?.tool || '');
      if (MCP_READ_SUBTOOL_RE.test(sub)) lastLook = i;
      else lastAct = i;
    } else if (name === 'local_desktop_look') {
      lastLook = i;
    } else if (name === 'local_desktop_act') {
      appCalls += 1;
      lastAct = i;
    }
  });
  if (lastAct >= 0 && lastLook < lastAct) return 'unverified';
  if (appCalls > 0 && MCP_MIDTASK_NARRATION_RE.test(finalText)) return 'mid-task';
  return null;
}

/**
 * The one stall classifier the nudge sites consult. Workspace shapes win
 * (they carry more specific prompts); a workspace turn that is ALSO driving
 * Blender still gets the MCP check as its fallback.
 */
function agentStallReason({ workspaceMode, desktopMcpMode, toolCalls, finalText = '' }) {
  if (workspaceMode) {
    const reason = workspaceStallReason(toolCalls, finalText);
    if (reason) return reason;
  }
  if (desktopMcpMode) return desktopMcpStallReason(toolCalls, finalText);
  return null;
}

/** The corrective prompt for each stall shape. */
function workspaceNudgePrompt(reason) {
  if (reason === 'code-in-chat') return WORKSPACE_CODE_DUMP_PROMPT;
  if (reason === 'claimed-no-access') return WORKSPACE_TOOLS_ARMED_PROMPT;
  if (reason === 'unverified' || reason === 'mid-task') return DESKTOP_MCP_CONTINUE_PROMPT;
  return WORKSPACE_CONTINUE_PROMPT;
}

/**
 * After a hop on a workspace or desktop-MCP turn, decide whether to push the
 * model back to work instead of ending the turn.
 */
function shouldNudgeWorkspaceContinue({
  workspaceMode,
  desktopMcpMode,
  workspaceNudges,
  toolCalls,
  pendingToolCalls,
  finalText = '',
}) {
  if (pendingToolCalls) return false;
  const reason = agentStallReason({ workspaceMode, desktopMcpMode, toolCalls, finalText });
  if (!reason) return false;
  if (reason === 'unverified' || reason === 'mid-task') {
    return workspaceNudges < MAX_DESKTOP_MCP_CONTINUE_NUDGES;
  }
  if (workspaceNudges >= MAX_WORKSPACE_CONTINUE_NUDGES) return false;
  // A read-only stall gets one push; if the model answers with text again it
  // was a question, and a second identical nudge would only duplicate the
  // answer.
  if (reason === 'inspect-only') return workspaceNudges === 0;
  return true;
}

export {
  workspaceStallReason,
  desktopMcpStallReason,
  agentStallReason,
  workspaceNudgePrompt,
  shouldNudgeWorkspaceContinue,
};
