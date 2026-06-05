// ============================================================================
// mcp-tools/chatTools.js — tools the IN-APP LYKN chat can call
// ============================================================================
// The MCP surface in mcp-tools/index.js exposes every synthesis-layer tool
// to OUTSIDE AI clients (Claude Desktop, Cursor, Claude Code, ChatGPT) via
// /mcp + the REST mirror at /api/v1/synthesis/*.
//
// This file is the IN-APP equivalent: the subset of those tools that the
// LYKN chat itself (the one at /api/ai/stream) is allowed to function-call
// AND the per-provider schema translators so the same tool surface works
// across OpenAI / Anthropic / Gemini / Grok native function calling.
//
// Adding a tool to in-app chat = include it in CHAT_TOOL_NAMES below and
// teach the in-app system prompt when to call it (see LYKN_CHAT_TOOL_GUIDANCE
// in server.js). The schema converters below pick it up automatically.
//
// We deliberately do NOT re-export the full MCP_TOOLS list. The defaults
// for in-app chat should always be an explicit whitelist; broad write
// access via tool calls is exactly the failure mode that makes "the chat
// nuked my projects" stories. New tools opt in here explicitly.

import { MCP_TOOLS_BY_NAME, errorContent } from './index.js';
import { EXTERIOR_TOOLS_BY_NAME } from './exterior/index.js';
import { delegateToSubModelTool } from './delegateToSubModel.js';
import { listSubModelTasksTool } from './listSubModelTasks.js';
import { getSubModelTaskTool } from './getSubModelTask.js';

const ALL_CHAT_TOOLS_BY_NAME = Object.freeze({
  ...MCP_TOOLS_BY_NAME,
  ...EXTERIOR_TOOLS_BY_NAME,
  [delegateToSubModelTool.name]: delegateToSubModelTool,
  [listSubModelTasksTool.name]: listSubModelTasksTool,
  [getSubModelTaskTool.name]: getSubModelTaskTool,
});

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------
// Order matters — the model gives the earlier-listed tools slightly more
// salience when picking between similarly-described options. Cluster by
// rough "this is how a single conversation flows":
//
//   discovery → read   → cluster → mutate → propose-new
//   listProjects → findConnections / searchVault → addProjectNeurons /
//   removeProjectNeurons → updateProject / setActiveProject / deleteProject →
//   proposeFact
//
// Read tools first because the agent loop's first call on most turns is
// a read, and writes get more conservative when the model has already
// seen the world via reads.
export const CHAT_TOOL_NAMES = [
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
  'lykn_searchVault',
  'lykn_getNeuronLinks',
  'lykn_getRecentActivity',
  // ── Project working-memory write (git-style, reversible) ─────────
  'lykn_pushProjectState',
  // ── Project-cluster writes (reversible) ──────────────────────────
  'lykn_addProjectNeurons',
  'lykn_removeProjectNeurons',
  // ── Project metadata writes ──────────────────────────────────────
  'lykn_setActiveProject',
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
  // URL-specialised vault save (rich link card, URL dedupe). The agent
  // should reach for this whenever the thing being saved is a link the
  // user pasted/dropped; createVaultNote stays the path for plain text
  // / snippet / code-block saves.
  'lykn_saveLinkToVault',
  // ── Preference write (ASK FIRST — see tool description) ──────────
  'lykn_updateUserPreference',
  // ── Capability-aware routing (read-only catalog lookup) ──────────
  // Called when the user asks LYKN to do something it can't (send email,
  // generate images, run code in their repo, etc.). Returns a small
  // list of outside tools the user can connect via /connections. Pull
  // model only — LYKN never dispatches.
  'lykn_recommendTools',
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
  'lykn_symbolic_math',
  'lykn_process_image',
  'lykn_transcribe_audio',
  'lykn_generate_speech',
  'lykn_build_template',
  'lykn_translate',
  'lykn_http_request',
  // Main-agent orchestration (enabled per-turn when a main agent is active)
  'lykn_delegate_to_sub_model',
  'lykn_list_sub_model_tasks',
  'lykn_get_sub_model_task',
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
  return CHAT_TOOL_NAMES.filter((n) => set.has(n))
    .map((n) => ALL_CHAT_TOOLS_BY_NAME[n])
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
 * Run an in-app chat tool by name. Mirrors `runRestTool` in server.js
 * but is scoped to the chat whitelist (so a model can't smuggle a
 * non-whitelisted MCP tool through the agent loop just by emitting its
 * name) and returns a plain JS object instead of an Express response.
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
 * Build the ctx an MCP tool handler expects from an Express `req`. This
 * deliberately mirrors `buildToolCtx` / `buildContext` in server.js +
 * mcp-server.js so the same tool handler behaves identically across all
 * three transports (MCP / REST / in-app chat).
 *
 *   const ctx = buildChatToolCtx(req);
 *   await runChatTool('lykn_listProjects', args, ctx);
 *
 * Surface convention: in-app chat traffic is always `lykn-chat` (matches
 * what the <applied> tag funnel uses), and `mcpAuth` is null (JWT path).
 */
/**
 * Human-readable attribution for in-app chat tool writes (project state,
 * etc.). Custom models use their display name; frontier models use the
 * served model id so the project panel can show "via Mark" / "via gpt-4.1".
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
    mcpAuth: null,
    clientLabel: String(req.headers['user-agent'] || '').slice(0, 240),
    attribSurface: 'lykn-chat',
    tokenId: null,
    chatModelLabel: extras.chatModelLabel || null,
    /** Custom model linked_project_id — default target for project writes. */
    boundProjectId: extras.boundProjectId || null,
    /** Board/chat scope from req.body.projectId. */
    boardProjectId: extras.boardProjectId || null,
  };
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
