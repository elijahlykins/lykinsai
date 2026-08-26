// ============================================================================
// mcp-tools/chatTools.js — tools the IN-APP LYKN chat can call
// ============================================================================
// mcp-tools/index.js is the full registry of synthesis-layer tools; the
// voice agent dispatches against all of them.
//
// This file is the text-chat equivalent: the subset of those tools that the
// LYKN chat itself (the one at /api/ai/stream) is allowed to function-call
// AND the per-provider schema translators so the same tool surface works
// across OpenAI / Anthropic / Gemini / Grok native function calling.
//
// Adding a tool to in-app chat = include it in CHAT_TOOL_NAMES below and
// teach the in-app system prompt when to call it. The when-to-call policy in
// server.js is split: an always-on core (LYKN_CHAT_TOOL_GUIDANCE, incl. the
// CAPABILITIES MENU so the model always KNOWS the tool exists) plus
// intent-gated detail blocks (TOOL_GUIDANCE_*) composed per-turn by
// buildChatToolGuidance(). Add the tool to the right block AND extend the menu
// + the block's intent regex so it isn't silently undocumented. The schema
// converters below pick the tool up automatically.
//
// We deliberately do NOT re-export the full SYNTHESIS_TOOLS list. The
// defaults for in-app chat should always be an explicit whitelist; broad
// write access via tool calls is exactly the failure mode that makes "the
// chat nuked my projects" stories. New tools opt in here explicitly.

import { SYNTHESIS_TOOLS_BY_NAME, errorContent } from './index.js';
import { EXTERIOR_TOOLS_BY_NAME } from './exterior/index.js';
import { delegateToSubModelTool } from './delegateToSubModel.js';
import { listSubModelTasksTool } from './listSubModelTasks.js';
import { getSubModelTaskTool } from './getSubModelTask.js';
import { communicateWithModelTool } from './communicateWithModel.js';
import { saveFileToVaultTool } from './saveFileToVault.js';
// In-app-only: deliberately NOT in mcp-tools/index.js so external MCP clients
// can't create projects (they keep the user-only restriction). The in-product
// assistant uses it only after the user agrees to its suggestion.
import { createProjectTool } from './createProject.js';
// In-app-only: acts on the CURRENT chat turn's dragged-in attachments (via
// ctx.turnAttachments), which external MCP clients never have. Saves the file
// to the vault and clusters it into a project in one step.
import { uploadToProjectTool } from './uploadToProject.js';
// In-app-only: lets the chat retune its OWN default behavior (tone / style),
// persisted client-side to the user's custom instructions. Voice parity for
// update_voice_instructions; external MCP clients have no settings store.
import { updateAssistantInstructionsTool } from './updateAssistantInstructions.js';
// In-app-only: opens the user's Settings window on the pane they asked about,
// for the changes LYKN can't make for them (wallpaper, plan, connected apps).
// External MCP clients have no LYKN window to open.
import { openSettingsTool } from './openSettings.js';
// In-app-only: opens a LYKN page (To-dos, Calendar, Projects…) or an app the
// user built in LYKN. Needs ctx.installedApps, which only the desktop client
// can supply, and a LYKN window to open into.
import { openAppTool } from './openApp.js';
// Schema-only "Local Mode" tools (file + terminal). The server NEVER runs
// these — they execute in the Electron main process. Included in the tool
// schemas only when the caller enables Local Mode for the turn.
import { LOCAL_CHAT_TOOLS_BY_NAME, LOCAL_TOOL_NAMES } from './localTools.js';

const ALL_CHAT_TOOLS_BY_NAME = Object.freeze({
  ...SYNTHESIS_TOOLS_BY_NAME,
  ...EXTERIOR_TOOLS_BY_NAME,
  [delegateToSubModelTool.name]: delegateToSubModelTool,
  [listSubModelTasksTool.name]: listSubModelTasksTool,
  [getSubModelTaskTool.name]: getSubModelTaskTool,
  [communicateWithModelTool.name]: communicateWithModelTool,
  [saveFileToVaultTool.name]: saveFileToVaultTool,
  [createProjectTool.name]: createProjectTool,
  [uploadToProjectTool.name]: uploadToProjectTool,
  [updateAssistantInstructionsTool.name]: updateAssistantInstructionsTool,
  [openSettingsTool.name]: openSettingsTool,
  [openAppTool.name]: openAppTool,
});

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------
// Order matters — the model gives the earlier-listed tools slightly more
// salience when picking between similarly-described options. Cluster by
// rough "this is how a single conversation flows":
//
//   discovery → read   → cluster → mutate → propose-new
//   listProjects → findConnections → addProjectNeurons /
//   removeProjectNeurons → updateProject / setActiveProject / deleteProject →
//   proposeFact
//
// Read tools first because the agent loop's first call on most turns is
// a read, and writes get more conservative when the model has already
// seen the world via reads.
export const CHAT_TOOL_NAMES = [
  // ── Personal memory (production authority as of Phase 2) ─────────
  'memory_list',
  'memory_read',
  'memory_patch',
  'memory_create',
  'memory_forget',
  // ── Identity reads (call early — these shape EVERY reply) ────────
  'lykn_getBeliefs',
  'lykn_getRules',
  'lykn_getFacts',
  'lykn_getUserPreferences',
  // ── Project / neuron reads ───────────────────────────────────────
  'lykn_listProjects',
  'lykn_resolveProject',
  'lykn_getProjectState',
  'lykn_getProjectNeurons',
  'lykn_findConnections',
  'lykn_loadNeuron',
  'lykn_loadNeurons',
  'lykn_getNeuronLinks',
  'lykn_getRecentActivity',
  // ── Project working-memory write (git-style, reversible) ─────────
  'lykn_pushProjectState',
  // ── Project-cluster writes (reversible) ──────────────────────────
  'lykn_addProjectNeurons',
  'lykn_removeProjectNeurons',
  // Save a dragged-in chat file to the vault AND cluster it into a project in
  // one step ("upload this image to my <project>"). Acts on this turn's
  // attachments — see uploadToProject.js.
  'lykn_uploadToProject',
  // ── Project metadata writes ──────────────────────────────────────
  'lykn_setActiveProject',
  // Create a NEW project — in-app only, and ONLY after the user agrees to the
  // assistant's suggestion (confirm-first policy lives in the tool description
  // + system prompt). Appears under Projects immediately.
  'lykn_createProject',
  'lykn_updateProject',
  // ── Project hard delete (confirm-gated inside the tool) ──────────
  'lykn_deleteProject',
  // ── Project merge (two-phase: dry-run preview → confirm commit) ──
  'lykn_mergeProjects',
  // ── Cross-neuron edges + concept recency (low-risk writes) ───────
  'lykn_createNeuronLink',
  'lykn_touchConcept',
  // ── Rule application telemetry (records belief→reply attribution) ─
  'lykn_recordRuleApplication',
  // ── New-neuron proposals (write into facts / vault — beliefs are user-only) ─
  'lykn_proposeFact',
  'lykn_createVaultNote',
  // Keep a GENERATED artifact (a doc/plan/deck/spreadsheet the model or a
  // capability tool just produced, or a sub-agent's report) in the vault —
  // text body becomes the searchable item, an optional generated file is
  // preserved as a durable reference + download link. Reach for this after
  // build_template / build_spreadsheet / generate_image / communicate_with_model.
  'lykn_saveFileToVault',
  // URL-specialised vault save (rich link card, URL dedupe). The agent
  // should reach for this whenever the thing being saved is a link the
  // user pasted/dropped; createVaultNote stays the path for plain text
  // / snippet / code-block saves.
  'lykn_saveLinkToVault',
  // ── Reminders (time-anchored prompts; pull-based surfacing) ──────
  'lykn_createReminder',
  'lykn_listReminders',
  'lykn_updateReminder',
  // ── Calendar (native LYKN events; rendered in the calendar pop-up) ─
  'lykn_createEvent',
  'lykn_listEvents',
  'lykn_updateEvent',
  'lykn_deleteEvent',
  // ── To-dos (native task list; rendered in the to-do pop-up) ──────
  'lykn_createTodo',
  'lykn_listTodos',
  'lykn_updateTodo',
  'lykn_deleteTodo',
  // ── Night Shift steward queue ────────────────────────────────────
  'lykn_createStewardItem',
  'lykn_listStewardItems',
  'lykn_updateStewardItem',
  // Custom models / sub-agents soft-unplugged — see lib/customModelsEnabled.js.
  // Hand a coding task to a Cursor cloud agent (opens a PR) and check on it.
  // Async — the server poller surfaces completion; deploy stays manual.
  'lykn_build_with_cursor',
  'lykn_check_cursor_build',
  // ── Preference write (ASK FIRST — see tool description) ──────────
  'lykn_updateUserPreference',
  // ── Self-tuning (change LYKN's own default tone/style; client-persisted) ──
  // Voice parity for update_voice_instructions. The system prompt's SELF-TUNING
  // block teaches when to call it; the chat orchestrator persists the result.
  'lykn_update_assistant_instructions',
  // ── Settings (the changes LYKN can't make for the user) ──────────
  // Opens the Settings window on the pane they asked about — wallpaper, plan,
  // connected apps. Sits next to self-tuning because the two are easy to
  // confuse, and both tool descriptions point at each other.
  'lykn_open_settings',
  // Opens a LYKN page (To-dos, Calendar, Projects, Vault) or an app the user
  // built in LYKN. Distinct from local_open_app, which launches a real macOS
  // application — both tool descriptions say so, because the ask sounds
  // identical ("open my notes").
  'lykn_open_app',
  // ── Exterior capabilities (on-demand, server-executed) ───────────
  'lykn_web_search',
  'lykn_web_fetch',
  'lykn_calculate',
  'lykn_generate_chart',
  'lykn_generate_diagram',
  'lykn_get_current_time',
  'lykn_run_python',
  'lykn_generate_image',
  // ── Model Builder capabilities ─────────────────────────────────────
  'lykn_manage_file',
  'lykn_parse_document',
  'lykn_run_code',
  'lykn_build_spreadsheet',
  // Claude-Artifacts-style React builds — documents, dashboards, tools,
  // games, prototypes rendered live from model-written React code.
  'lykn_build_react_artifact',
  // Remotion renders: model-written frame-based compositions → real .mp4
  // (animated logos, image animations, motion graphics for landing pages).
  'lykn_render_video',
  'lykn_symbolic_math',
  'lykn_process_image',
  'lykn_transcribe_audio',
  'lykn_generate_speech',
  'lykn_build_template',
  'lykn_translate',
  'lykn_http_request',
  // Main-agent orchestration soft-unplugged with custom models.
];

export const CHAT_TOOLS = CHAT_TOOL_NAMES
  .map((name) => ALL_CHAT_TOOLS_BY_NAME[name])
  .filter(Boolean);

export const CHAT_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(CHAT_TOOLS.map((t) => [t.name, t])),
);

// ---------------------------------------------------------------------------
// Per-provider schema converters
// ---------------------------------------------------------------------------
// Each provider has its own `tools[]` shape and its own quirks around the
// inputSchema. The Anthropic and Gemini APIs are strict about extra
// keywords on the schema (`additionalProperties` is fine on OpenAI,
// rejected by Gemini in some shapes) — we sanitise where needed.
//
// Description budget: every tool description ships on EVERY tool-enabled
// turn and is billed as input tokens. Our MCP descriptions are long-form
// prose for Claude / Cursor (Anthropic recommends "spend tokens here, not
// in handler logs") — cap to ~1KB for in-app chat so a 10-tool whitelist
// stays under ~2500 input tokens of overhead per turn.
const DESCRIPTION_CAP = 1000;

function clipDescription(tool) {
  return String(tool.description || tool.title || tool.name).slice(0, DESCRIPTION_CAP);
}

function safeParameters(tool) {
  return tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {}, additionalProperties: false };
}

// OpenAI Chat Completions + Grok (xAI is OpenAI-compatible):
//   { type: 'function', function: { name, description, parameters } }
export function toOpenAIToolSchema(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: clipDescription(tool),
      parameters: safeParameters(tool),
    },
  };
}

// Anthropic Messages API:
//   { name, description, input_schema }
// `input_schema` is the same JSON Schema object — Anthropic accepts the
// `additionalProperties` keyword.
export function toAnthropicToolSchema(tool) {
  return {
    name: tool.name,
    description: clipDescription(tool),
    input_schema: safeParameters(tool),
  };
}

// Google Gemini generateContent:
//   tools: [{ functionDeclarations: [{ name, description, parameters }] }]
//
// Gemini's JSON-Schema dialect is a stripped subset (OpenAPI 3.0 Schema
// minus a bunch of keywords). The keywords most likely to leak in from
// our MCP tool descriptors and that Gemini rejects are:
//   • additionalProperties        — ignored on top-level, errors on
//                                   some nested usages
//   • $schema / $id / definitions — not in OpenAPI 3.0 Schema
//   • const                       — use enum:[<one>] instead
//   • exclusiveMinimum / exclusiveMaximum as booleans — older draft
//
// We do a defensive deep-clean before sending: drop those keywords and
// uppercase the `type` enum (Gemini wants "STRING", "OBJECT" — accepting
// lowercase in practice but spec is uppercase; we leave lowercase since
// it actually works and the API docs admit lowercase).
function geminiSanitiseSchema(node) {
  if (Array.isArray(node)) return node.map(geminiSanitiseSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' || key === '$schema' || key === '$id' || key === 'definitions') continue;
    if (key === 'const') {
      out.enum = [value];
      continue;
    }
    out[key] = geminiSanitiseSchema(value);
  }
  return out;
}

export function toGeminiToolDeclaration(tool) {
  return {
    name: tool.name,
    description: clipDescription(tool),
    parameters: geminiSanitiseSchema(safeParameters(tool)),
  };
}

// ---------------------------------------------------------------------------
// Per-provider "build the whole tools[] array" wrappers
// ---------------------------------------------------------------------------

/**
 * Resolve the in-app tool list for a turn.
 * @param {string[] | null | undefined} toolNames — undefined = full CHAT_TOOLS whitelist; [] = none
 */
export function resolveChatTools(toolNames) {
  if (toolNames === undefined || toolNames === null) {
    return CHAT_TOOLS;
  }
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    return [];
  }
  const set = new Set(toolNames);
  // Local Mode tools are resolvable only when explicitly requested by name;
  // they are never part of the default whitelist. Order them after the
  // regular chat tools so they don't steal salience from core tools.
  const order = set.size && LOCAL_TOOL_NAMES.some((n) => set.has(n))
    ? [...CHAT_TOOL_NAMES, ...LOCAL_TOOL_NAMES]
    : CHAT_TOOL_NAMES;
  return order
    .filter((n) => set.has(n))
    .map((n) => ALL_CHAT_TOOLS_BY_NAME[n] || LOCAL_CHAT_TOOLS_BY_NAME[n])
    .filter(Boolean);
}

export function buildOpenAiTools(toolNames) {
  const tools = resolveChatTools(toolNames);
  if (!tools.length) return null;
  return tools.map(toOpenAIToolSchema);
}

export function buildAnthropicTools(toolNames) {
  const tools = resolveChatTools(toolNames);
  if (!tools.length) return null;
  return tools.map(toAnthropicToolSchema);
}

export function buildGeminiTools(toolNames) {
  const tools = resolveChatTools(toolNames);
  if (!tools.length) return null;
  return [{ functionDeclarations: tools.map(toGeminiToolDeclaration) }];
}

// ---------------------------------------------------------------------------
// Tool runner (provider-agnostic — the agent loop calls this for every hop)
// ---------------------------------------------------------------------------
/**
 * Run an in-app chat tool by name. Scoped to the chat whitelist (so a
 * model can't smuggle a non-whitelisted synthesis tool through the agent
 * loop just by emitting its name) and returns a plain JS object instead
 * of an Express response.
 *
 *   const { ok, payload, isError, latencyMs } = await runChatTool(
 *     'lykn_listProjects',
 *     { status: 'active' },
 *     ctx,
 *   );
 *
 * `ctx` matches the MCP tool handler contract — `{ supabaseAdmin,
 * userId, ... }`. Build it with `buildChatToolCtx(req)` below.
 *
 * Returns:
 *   ok        — true on success, false on any handler error or non-whitelisted tool
 *   payload   — JSON-parsed tool result (best-effort); falls back to { text } on text tools
 *   isError   — mirrors the MCP tool's `isError` flag
 *   latencyMs — wall-clock time spent in the handler (telemetry)
 */
export async function runChatTool(toolName, args, ctx, options = {}) {
  const allowed = options?.allowedToolNames;
  if (Array.isArray(allowed) && !allowed.includes(toolName)) {
    return {
      ok: false,
      isError: true,
      payload: { ok: false, error: `tool_not_enabled_for_model: ${toolName}` },
      latencyMs: 0,
    };
  }
  const tool = CHAT_TOOLS_BY_NAME[toolName];
  if (!tool) {
    return {
      ok: false,
      isError: true,
      payload: { ok: false, error: `tool_not_whitelisted_for_chat: ${toolName}` },
      latencyMs: 0,
    };
  }
  if (!ctx?.userId) {
    return {
      ok: false,
      isError: true,
      payload: { ok: false, error: 'unauthenticated' },
      latencyMs: 0,
    };
  }

  const startedAt = Date.now();
  let result;
  let isError = false;
  try {
    const safeArgs = args && typeof args === 'object' ? args : {};
    result = await tool.handler(safeArgs, ctx);
    isError = Boolean(result?.isError);
  } catch (err) {
    const msg = err?.message || String(err);
    console.error(`[chat-tool:${toolName}] handler threw:`, msg);
    result = errorContent(msg);
    isError = true;
  }
  const latencyMs = Date.now() - startedAt;

  const blocks = Array.isArray(result?.content) ? result.content : [];
  const first = blocks[0];
  let payload;
  if (first?.type === 'text') {
    try {
      payload = JSON.parse(first.text);
    } catch {
      payload = { ok: !isError, text: String(first.text) };
    }
  } else {
    payload = { ok: !isError, content: blocks };
  }

  return { ok: !isError, isError, payload, latencyMs };
}

/**
 * Build the ctx a synthesis tool handler expects from an Express `req`.
 * This deliberately mirrors `buildToolCtx` in server.js (the voice path)
 * so the same tool handler behaves identically in chat and voice.
 *
 *   const ctx = buildChatToolCtx(req);
 *   await runChatTool('lykn_listProjects', args, ctx);
 *
 * Surface convention: in-app chat traffic is always `lykn-chat` (matches
 * what the <applied> tag funnel uses).
 */
/**
 * Label for the in-app chat model (custom display name or served model id).
 * Project-state pushes no longer use this for UI attribution — those brand
 * as "LYKN" via resolveProjectPushClient — but other call sites may still
 * want the concrete model identity.
 */
export function resolveChatModelLabel({ customModelName, modelId } = {}) {
  const custom = typeof customModelName === 'string' ? customModelName.trim() : '';
  if (custom) return custom.slice(0, 80);
  const model = typeof modelId === 'string' ? modelId.trim() : '';
  if (model) return model.slice(0, 80);
  return 'lykn-chat';
}

export function buildChatToolCtx(req, extras = {}) {
  return {
    supabaseAdmin: req.app.get('supabaseAdmin'),
    userId: req.user?.id || null,
    clientLabel: String(req.headers['user-agent'] || '').slice(0, 240),
    attribSurface: 'lykn-chat',
    chatModelLabel: extras.chatModelLabel || null,
    /** Custom model linked_project_id — default target for project writes. */
    boundProjectId: extras.boundProjectId || null,
    /** Board/chat scope from req.body.projectId. */
    boardProjectId: extras.boardProjectId || null,
    /**
     * JSX source of the React artifact open in the preview popup (from
     * req.body.activeArtifact). Lets lykn_build_react_artifact apply targeted
     * `edits` server-side instead of forcing a ground-up re-emit of the code.
     */
    activeArtifactCode: typeof extras.activeArtifactCode === 'string' && extras.activeArtifactCode.trim()
      ? extras.activeArtifactCode
      : null,
    /** Multi-file React project sources (from req.body.activeArtifact.files). */
    activeArtifactFiles: Array.isArray(extras.activeArtifactFiles)
      ? extras.activeArtifactFiles
      : extras.activeArtifactFiles && typeof extras.activeArtifactFiles === 'object'
        ? extras.activeArtifactFiles
        : null,
    activeArtifactEntry:
      typeof extras.activeArtifactEntry === 'string' && extras.activeArtifactEntry.trim()
        ? extras.activeArtifactEntry.trim()
        : null,
    activeArtifactTodos: Array.isArray(extras.activeArtifactTodos)
      ? extras.activeArtifactTodos
      : null,
    /** Console/runtime errors captured from the preview iframe since last load. */
    activeArtifactRuntimeErrors: Array.isArray(extras.activeArtifactRuntimeErrors)
      ? extras.activeArtifactRuntimeErrors
      : null,
    /** Open template artifact fields — style-only rebuilds reuse sections. */
    activeArtifactSections: Array.isArray(extras.activeArtifactSections)
      ? extras.activeArtifactSections
      : null,
    activeArtifactContent:
      typeof extras.activeArtifactContent === 'string' && extras.activeArtifactContent.trim()
        ? extras.activeArtifactContent
        : null,
    activeArtifactHeaders: Array.isArray(extras.activeArtifactHeaders)
      ? extras.activeArtifactHeaders
      : null,
    activeArtifactRows: Array.isArray(extras.activeArtifactRows)
      ? extras.activeArtifactRows
      : null,
    activeArtifactTitle:
      typeof extras.activeArtifactTitle === 'string' ? extras.activeArtifactTitle : null,
    activeArtifactTheme:
      typeof extras.activeArtifactTheme === 'string' ? extras.activeArtifactTheme : null,
    activeArtifactFont:
      typeof extras.activeArtifactFont === 'string' ? extras.activeArtifactFont : null,
    allowFullRewrite: extras.allowFullRewrite === true,
    allowStyleChange: extras.allowStyleChange === true,
    /** Open-panel refine — short agent loop, one artifact ship per turn. */
    editingArtifact: extras.editingArtifact === true,
    /**
     * Binary attachments the user dragged/pasted into THIS chat turn (image /
     * pdf / file / video / audio), as compact metadata. lykn_uploadToProject
     * reads these to save a dragged file into the vault and cluster it into a
     * project. Image attachments carry an `imageIndex` into `turnImageUrls`
     * (below) so the tool can recover the base64 bytes when no durable
     * storagePath exists yet. Empty on turns with no attachments.
     */
    turnAttachments: sanitizeTurnAttachments(req.body?.attachments),
    /**
     * The base64 / signed image URLs sent for vision this turn, in the same
     * order the client assigned `imageIndex`. Used as the byte source of last
     * resort for image attachments lacking a storagePath.
     */
    turnImageUrls: (Array.isArray(req.body?.imageUrls) ? req.body.imageUrls : []).slice(0, 8),
    /**
     * The apps the user has built in LYKN, as { id, name }. They live in the
     * local store on the user's machine, so the server only knows about them
     * because the desktop client sends them with the turn. lykn_open_app
     * matches a spoken name against this. Empty in the browser.
     */
    installedApps: sanitizeInstalledApps(req.body?.installedApps),
    /**
     * The applications on the user's Mac, by name. lykn_open_app checks this to
     * tell an app they HAVE (open the real thing) from one they don't (the web
     * is the right answer) — which differs per machine, so it can't be a fixed
     * list. Empty in the browser, where there is no Mac.
     */
    macApps: sanitizeMacApps(req.body?.macApps),
    /**
     * Whether the local_* tools are live this turn. lykn_open_app reads it so
     * that "open Chrome" with Local Mode off explains why it can't rather than
     * opening LYKN's browser as a stand-in.
     */
    localMode: req.body?.localMode === true,
    /**
     * What is in AI Drive — the artifacts and generated images LYKN has made
     * for this user, as { id, name, folder }. `id` is the vault row, which is
     * what a deep link into the drive needs. Same reason as installedApps: the
     * server has no way to know what they have made unless it is told.
     */
    aiDrive: sanitizeAiDrive(req.body?.aiDrive),
    /**
     * How much is in AI Drive, as opposed to how much of it is named above.
     * Only the newest items are sent by name, so without this the model reads
     * a truncated list as a total and tells the user they have made three
     * images when they have made forty.
     */
    aiDriveTotals: sanitizeAiDriveTotals(req.body?.aiDriveTotals),
    // In-app chat never searches the retired connected-apps vault library.
    // Files live in the Finder window: [AI DRIVE] + local_* for Mac folders.
    skipVaultSearch: true,
  };
}

/** Non-negative counts, and whether the client got to the end of the vault. */
function sanitizeAiDriveTotals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100_000) : 0;
  };
  return {
    artifacts: count(raw.artifacts),
    images: count(raw.images),
    complete: raw.complete === true,
  };
}

/** Vault-row id, display name and which of AI Drive's two folders it sits in. */
function sanitizeAiDrive(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim().slice(0, 120) : '';
    const name = typeof item.name === 'string' ? item.name.trim().slice(0, 120) : '';
    if (!id || !name) continue;
    out.push({ id, name, folder: item.folder === 'images' ? 'images' : 'artifacts' });
  }
  return out;
}

/** Names only, capped and coerced. Accepts the bare strings the client sends
 *  and the { name } objects the Mac dock uses, so either shape works. */
function sanitizeMacApps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const app of raw.slice(0, 200)) {
    const name = String(typeof app === 'string' ? app : app?.name || '').trim().slice(0, 80);
    if (name) out.push(name);
  }
  return out;
}

/** Same defensive treatment as the attachments below: known fields only,
 *  capped, coerced, so a malformed payload can't reach a tool handler. */
function sanitizeInstalledApps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const app of raw.slice(0, 60)) {
    if (!app || typeof app !== 'object') continue;
    const id = typeof app.id === 'string' ? app.id.trim().slice(0, 120) : '';
    if (!id) continue;
    out.push({
      id,
      name: typeof app.name === 'string' ? app.name.trim().slice(0, 120) : '',
    });
  }
  return out;
}

// Defensive cleaner for the client-supplied per-turn attachment metadata: we
// only keep the small, known fields (never bytes), cap the count, and coerce
// types so a malformed payload can't reach the tool handler.
function sanitizeTurnAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const type = String(a.type || '').toLowerCase().slice(0, 24);
    if (!['image', 'pdf', 'file', 'video', 'audio'].includes(type)) continue;
    const meta = {
      type,
      name: typeof a.name === 'string' ? a.name.slice(0, 200) : 'attachment',
    };
    if (typeof a.mime === 'string') meta.mime = a.mime.slice(0, 120);
    if (typeof a.storagePath === 'string') meta.storagePath = a.storagePath.slice(0, 400);
    if (typeof a.storageBucket === 'string') meta.storageBucket = a.storageBucket.slice(0, 120);
    if (typeof a.url === 'string' && /^https?:\/\//i.test(a.url)) meta.url = a.url.slice(0, 2000);
    if (Number.isInteger(a.imageIndex) && a.imageIndex >= 0 && a.imageIndex < 8) meta.imageIndex = a.imageIndex;
    out.push(meta);
    if (out.length >= 8) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pick a provider from a model id. Mirrors the routing isOpenAIModel /
// model.includes('claude') / startsWith('gemini') / includes('grok')
// pattern used everywhere else in server.js. Single source of truth so
// the agent-loop dispatcher and any future "does this model support
// tools?" check stay aligned.
// ---------------------------------------------------------------------------
export function providerForModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (m.startsWith('gpt-') || m === 'o3' || m === 'o3-pro' || m === 'o4-mini') return 'openai';
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('grok')) return 'grok';
  if (m.startsWith('gemini-') || m.includes('gemini')) return 'gemini';
  return null;
}

// Tool calling is supported on every provider we route through (modulo
// some legacy aliases). Kept as a helper so callers don't need to know
// the provider-id ↔ tool-support map.
export function supportsTools(model) {
  const p = providerForModel(model);
  return p === 'openai' || p === 'anthropic' || p === 'gemini' || p === 'grok';
}
