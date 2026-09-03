// ============================================================================
// mcp-tools/index.js — registry of LYKN in-app tools
// ============================================================================
// One source of truth for what LYKN's own AI can do for the user.
// These are consumed by two in-app surfaces:
//   • the text chat  — via the whitelist in chatTools.js
//   • the voice agent — via voice.routes.js aliases over the same handlers
//
// LYKN does NOT expose these tools to outside AI models. There is no MCP
// server, no REST mirror, and no bearer-token transport; every call runs
// under the signed-in user's own session.
//
// Tool shape:
//   {
//     name        : 'memory_list'
//     title       : 'List the user\'s memory documents'
//     description : Long, LLM-facing prose describing WHEN to call it.
//                  This is the single biggest determinant of whether the
//                  model uses the tool well. Spend tokens here, not in
//                  handler logs. chatTools.js clips it to DESCRIPTION_CAP
//                  before it ships in a turn's tool schemas.
//     scope       : 'read' | 'write'
//     inputSchema : JSON Schema describing args
//     async handler(args, ctx) → { content: [{ type: 'text', text: '...' }] }
//                  Returns "content" blocks; callers unwrap block[0].text
//                  and JSON.parse it.
//   }
//
// ctx fields (set by buildChatToolCtx in chatTools.js / buildToolCtx in
// server.js before calling):
//   ctx.supabaseAdmin   — service-role client
//   ctx.userId          — the signed-in user
//   ctx.attribSurface   — 'lykn-chat' for recordRuleApplication
//   ctx.clientLabel     — UA string for telemetry
//
// All tool files live in this directory and only re-export the tool object.
// Adding a new tool = drop a file in here, re-export it below, and add it
// to CHAT_TOOL_NAMES in chatTools.js.

import { searchVaultTool } from './searchVault.js';
import { setActiveProjectTool } from './setActiveProject.js';
import { pushProjectStateTool } from './pushProjectState.js';
import { getProjectStateTool } from './getProjectState.js';
import { listProjectsTool } from './listProjects.js';
import { resolveProjectTool } from './resolveProject.js';
import { updateProjectTool } from './updateProject.js';
import { deleteProjectTool } from './deleteProject.js';
import { mergeProjectsTool } from './mergeProjects.js';
import { createVaultNoteTool } from './createVaultNote.js';
import { getUserPreferencesTool } from './getUserPreferences.js';
import { updateUserPreferenceTool } from './updateUserPreference.js';
import { getRecentActivityTool } from './getRecentActivity.js';
import {
  memoryListTool,
  memoryReadTool,
  memoryPatchTool,
  memoryCreateTool,
  memoryForgetTool,
} from './memoryTools.js';
import { saveLinkToVaultTool } from './saveLinkToVault.js';
import { createReminderTool } from './createReminder.js';
import { listRemindersTool } from './listReminders.js';
import { updateReminderTool } from './updateReminder.js';
import { createEventTool } from './createEvent.js';
import { listEventsTool } from './listEvents.js';
import { updateEventTool } from './updateEvent.js';
import { deleteEventTool } from './deleteEvent.js';
import { createTodoTool } from './createTodo.js';
import { listTodosTool } from './listTodos.js';
import { updateTodoTool } from './updateTodo.js';
import { deleteTodoTool } from './deleteTodo.js';
import { createStewardItemTool } from './createStewardItem.js';
import { listStewardItemsTool } from './listStewardItems.js';
import { updateStewardItemTool } from './updateStewardItem.js';
import { listCustomModelsTool } from './listCustomModels.js';
import { buildWithCursorTool } from './buildWithCursor.js';
import { checkCursorBuildTool } from './checkCursorBuild.js';
import { listAppsTool } from './listApps.js';
import { callAppTool } from './callApp.js';

export const LYKN_TOOLS = [
  // Project state (product working context)
  listProjectsTool,
  resolveProjectTool,
  setActiveProjectTool,
  updateProjectTool,
  deleteProjectTool,
  mergeProjectsTool,
  pushProjectStateTool,
  getProjectStateTool,
  // Markdown memory (production personal-memory authority)
  memoryListTool,
  memoryReadTool,
  memoryPatchTool,
  memoryCreateTool,
  memoryForgetTool,
  // Cross-tier helpers
  searchVaultTool,
  createVaultNoteTool,
  // URL-specialised vault save — produces a rich link card with favicon
  // + platform tags, dedupes by URL. Pairs with the chat handler's
  // pasted-URL auto-scrape: the AI gets the page content in
  // [SCRAPED_WEB_PAGES] and can call this with a meaningful title.
  saveLinkToVaultTool,
  // Reminders — time-anchored prompts the AI sets in text or voice mode
  createReminderTool,
  listRemindersTool,
  updateReminderTool,
  // Calendar — native LYKN events the AI builds in text/voice + the user
  // edits in the calendar pop-up (lykn_events; sibling of reminders).
  createEventTool,
  listEventsTool,
  updateEventTool,
  deleteEventTool,
  // To-dos — native LYKN task list the AI manages in text/voice + the user
  // checks off in the to-do pop-up (lykn_todos; sibling of reminders/events).
  createTodoTool,
  listTodosTool,
  updateTodoTool,
  deleteTodoTool,
  // Night Shift steward queue — overnight project triage + research
  createStewardItemTool,
  listStewardItemsTool,
  updateStewardItemTool,
  // Custom models — read the user's Model Builder creations
  listCustomModelsTool,
  // Cursor cloud-agent builds — hand a coding task to Cursor (opens a PR) and
  // check on it. Async; the server poller surfaces completion to the user.
  buildWithCursorTool,
  checkCursorBuildTool,
  // Universal app access — call ANY app the user attached with their own API
  // key (Connections → Custom API). list_apps discovers them; call_app makes
  // the request with the credential injected server-side.
  listAppsTool,
  callAppTool,
  // Preferences & activity feed (server-honoured user policy + cross-store deltas)
  getUserPreferencesTool,
  updateUserPreferenceTool,
  getRecentActivityTool,
];

export const LYKN_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(LYKN_TOOLS.map((t) => [t.name, t])),
);

// ---------------------------------------------------------------------------
// Shared helpers used by tool handlers (re-exported from content.js)
// ---------------------------------------------------------------------------

export {
  jsonContent,
  textContent,
  errorContent,
} from './content.js';
