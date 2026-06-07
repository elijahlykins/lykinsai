// ============================================================================
// mcp-tools/index.js — registry of MCP tools that expose the synthesis layer
// ============================================================================
// One source of truth for "what can outside AI clients (Claude Desktop,
// Cursor, Claude Code, ChatGPT custom GPT, etc.) do with LYKN."
//
// Each tool follows the same shape so:
//   • mcp-server.js can register them all in a loop
//   • the REST mirror in server.js can wrap them in plain HTTP routes
//   • the admin panel can show per-tool usage without hardcoding names
//
// Tool shape:
//   {
//     name        : 'lykn_getBeliefs'              // namespaced (underscore — Claude Desktop rejects dots in tool names per `^[a-zA-Z0-9_-]{1,64}$`)
//     title       : 'Get the user\'s active beliefs'
//     description : Long, LLM-facing prose describing WHEN to call it.
//                  This shows up in Claude / Cursor / etc. and is the
//                  single biggest determinant of whether the model uses
//                  the tool well. Spend tokens here, not in handler logs.
//     scope       : 'read' | 'write'
//     inputSchema : JSON Schema describing args
//     async handler(args, ctx) → { content: [{ type: 'text', text: '...' }] }
//                  Returns MCP "content" blocks. The REST mirror unwraps
//                  these into plain JSON.
//   }
//
// ctx fields (set by mcp-server.js / the REST mirror before calling):
//   ctx.supabaseAdmin   — service-role client
//   ctx.userId          — resolved by requireAuthOrMcpToken
//   ctx.attribSurface   — e.g. 'mcp:claude-desktop' for recordRuleApplication
//   ctx.tokenId         — id of the lykn_mcp_tokens row (null on JWT)
//   ctx.clientLabel     — UA / mcp-client-info string for telemetry
//   ctx.log             — opaque logger; see mcp-server.js
//
// All tool files live in this directory and only re-export the tool object.
// Adding a new tool = drop a file in here and re-export it below.

import { getBeliefsTool } from './getBeliefs.js';
import { getRulesTool } from './getRules.js';
import { getFactsTool } from './getFacts.js';
import { searchVaultTool } from './searchVault.js';
import { getContextBlockTool } from './getContextBlock.js';
import { recordRuleApplicationTool } from './recordRuleApplication.js';
import { proposeFactTool } from './proposeFact.js';
import { setActiveProjectTool } from './setActiveProject.js';
import { pushProjectStateTool } from './pushProjectState.js';
import { getProjectStateTool } from './getProjectState.js';
import { listProjectsTool } from './listProjects.js';
import { resolveProjectTool } from './resolveProject.js';
import { updateProjectTool } from './updateProject.js';
import { addProjectNeuronsTool } from './addProjectNeurons.js';
import { removeProjectNeuronsTool } from './removeProjectNeurons.js';
import { deleteProjectTool } from './deleteProject.js';
import { mergeProjectsTool } from './mergeProjects.js';
import { findConnectionsTool } from './findConnections.js';
import { createVaultNoteTool } from './createVaultNote.js';
import { loadNeuronTool } from './loadNeuron.js';
import { loadNeuronsTool } from './loadNeurons.js';
import { getProjectNeuronsTool } from './getProjectNeurons.js';
import { createNeuronLinkTool } from './createNeuronLink.js';
import { getNeuronLinksTool } from './getNeuronLinks.js';
import { touchConceptTool } from './touchConcept.js';
import { getUserPreferencesTool } from './getUserPreferences.js';
import { updateUserPreferenceTool } from './updateUserPreference.js';
import { getRecentActivityTool } from './getRecentActivity.js';
import { recommendToolsTool } from './recommendTools.js';
import { saveLinkToVaultTool } from './saveLinkToVault.js';
import { createReminderTool } from './createReminder.js';
import { listRemindersTool } from './listReminders.js';
import { updateReminderTool } from './updateReminder.js';
import { listCustomModelsTool } from './listCustomModels.js';
import { buildWithCursorTool } from './buildWithCursor.js';
import { checkCursorBuildTool } from './checkCursorBuild.js';

export const MCP_TOOLS = [
  // Tier 1 — Core beliefs (governance, ratified)
  getBeliefsTool,
  getRulesTool,
  recordRuleApplicationTool,
  // Tier 2 — Project state (working memory, git-style)
  listProjectsTool,
  resolveProjectTool,
  setActiveProjectTool,
  updateProjectTool,
  deleteProjectTool,
  mergeProjectsTool,
  pushProjectStateTool,
  getProjectStateTool,
  addProjectNeuronsTool,
  removeProjectNeuronsTool,
  getProjectNeuronsTool,
  // Tier 3 — Identity facts (background, light-weight)
  getFactsTool,
  proposeFactTool,
  // Cross-tier helpers
  getContextBlockTool,
  searchVaultTool,
  findConnectionsTool,
  loadNeuronTool,
  loadNeuronsTool,
  createVaultNoteTool,
  // URL-specialised vault save — produces a rich link card with favicon
  // + platform tags, dedupes by URL. Pairs with the chat handler's
  // pasted-URL auto-scrape: the AI gets the page content in
  // [SCRAPED_WEB_PAGES] and can call this with a meaningful title.
  saveLinkToVaultTool,
  // Synthesis graph — user-authored cross-neuron edges
  createNeuronLinkTool,
  getNeuronLinksTool,
  touchConceptTool,
  // Reminders — time-anchored prompts the AI sets in text or voice mode
  createReminderTool,
  listRemindersTool,
  updateReminderTool,
  // Custom models — read the user's Model Builder creations
  listCustomModelsTool,
  // Cursor cloud-agent builds — hand a coding task to Cursor (opens a PR) and
  // check on it. Async; the server poller surfaces completion to the user.
  buildWithCursorTool,
  checkCursorBuildTool,
  // Preferences & activity feed (server-honoured user policy + cross-store deltas)
  getUserPreferencesTool,
  updateUserPreferenceTool,
  getRecentActivityTool,
  // Capability-aware routing — suggests OUTBOUND_TARGETS the user can
  // connect when LYKN cannot perform the requested action itself. Pure
  // catalog read; no auth, no side effects, no dispatch.
  recommendToolsTool,
];

export const MCP_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t])),
);

// ---------------------------------------------------------------------------
// Shared helpers used by tool handlers (re-exported from content.js)
// ---------------------------------------------------------------------------

export {
  jsonContent,
  textContent,
  errorContent,
  requireWrite,
} from './content.js';
