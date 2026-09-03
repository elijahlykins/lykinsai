// ============================================================================
// mcp-tools/voiceToolResolver.js — Voice selection over Phase A capabilities
// ============================================================================
// Reuses FirstPartyCapabilityResolver. Does NOT invent a second taxonomy.
// Maps canonical families onto Voice-supported aliases, then optionally
// composes Universal MCP (capped) the same way Chat does.
//
// No extra LLM call. Disclosure is not authorization.

import { createRequire } from 'node:module';
import {
  MAX_EXTERNAL_TOOLS_PER_DISCLOSURE,
  resolveFirstPartyCapabilities,
  selectExternalToolsForNeeds,
} from './firstPartyCapabilities.js';
import {
  messageLooksLikeMakeAsk,
  messageWantsConnectedAppApis,
  messageWantsCursor,
  messageWantsWrittenDocument,
} from './chatIntentSignals.js';
import {
  LYKN_VOICE_TOOL_BY_NAME,
  LYKN_VOICE_TOOL_NAMES,
  RETIRED_VOICE_ALIASES,
  measureVoiceToolSchemas,
  toOpenAiChatTools,
  toRealtimeTools,
} from './voiceTools.js';

const require = createRequire(import.meta.url);
const artifactBuildIntent = require('../lib/artifactBuildIntent.cjs');

/**
 * Canonical capability family → Voice alias names.
 * Families with no Voice surface stay empty (Chat-only / Local / Browser).
 */
export const VOICE_TOOLS_BY_CAPABILITY = Object.freeze({
  'memory.read': Object.freeze(['memory_list', 'memory_read']),
  'memory.write': Object.freeze(['memory_patch', 'memory_create', 'memory_forget']),
  'projects.read': Object.freeze(['list_projects', 'resolve_project', 'get_project_state', 'get_recent_activity']),
  'projects.write': Object.freeze([
    'set_active_project',
    'create_project',
    'update_project',
    'update_project_state',
    'add_to_project',
  ]),
  'projects.destroy': Object.freeze(['delete_project', 'merge_projects']),
  // Chat parity: things LYKN built live in AI Drive and are pulled up with
  // open_app. The legacy vault hybrid search (search_vault / read_document /
  // display_document) is retired — see RETIRED_VOICE_ALIASES.
  'vault.read': Object.freeze(['open_app']),
  'vault.write': Object.freeze(['save_to_vault', 'save_link_to_vault', 'save_file_to_vault']),
  'calendar.read': Object.freeze(['list_events']),
  'calendar.write': Object.freeze(['create_event', 'update_event', 'delete_event']),
  'reminders.read': Object.freeze(['list_reminders']),
  'reminders.write': Object.freeze(['create_reminder', 'update_reminder']),
  'tasks.read': Object.freeze(['list_todos']),
  'tasks.write': Object.freeze(['create_todo', 'update_todo', 'delete_todo']),
  'web.search': Object.freeze(['web_search']),
  'web.read': Object.freeze(['web_fetch']),
  'coding.cursor': Object.freeze(['build_with_cursor', 'check_cursor_build']),
  'self.write': Object.freeze(['update_voice_instructions']),
  'compute.time': Object.freeze(['get_current_time']),
  'prefs.read': Object.freeze(['get_preferences']),
  'prefs.write': Object.freeze(['update_preference']),
  'steward.read': Object.freeze(['list_steward_items']),
  'steward.write': Object.freeze(['create_steward_item', 'update_steward_item']),
  'web.http': Object.freeze(['http_request']),
  'compute.math': Object.freeze(['calculate', 'symbolic_math']),
  'compute.code': Object.freeze(['run_python', 'run_code']),
  'media.image': Object.freeze(['generate_image', 'process_image']),
  'media.video': Object.freeze(['render_video']),
  'media.audio': Object.freeze(['transcribe_audio', 'generate_speech']),
  'media.parse': Object.freeze(['parse_document']),
  'media.translate': Object.freeze(['translate']),
  'documents.write': Object.freeze(['write_document']),
  'artifacts.build': Object.freeze([
    'generate_chart',
    'generate_diagram',
    'build_spreadsheet',
    'build_template',
    'build_react_artifact',
    'render_video',
    'manage_file',
  ]),
  'artifacts.edit': Object.freeze(['manage_file', 'build_template', 'build_spreadsheet', 'build_react_artifact']),
  'shell.open': Object.freeze(['open_app', 'open_settings']),
  'local.files.read': Object.freeze([
    'local_synced_folders',
    'local_list_dir',
    'local_search_files',
    'local_read_file',
    'local_pull_file',
    'local_open_path',
  ]),
  'local.files.write': Object.freeze(['local_write_file', 'local_edit_file']),
  'local.apps': Object.freeze(['local_running_apps', 'local_read_app', 'local_open_app']),
  'local.shell': Object.freeze(['local_run_command']),
  'local.desktop': Object.freeze(['local_organize_desktop']),
  'browser.agent': Object.freeze(['browser_agent']),
  'bots.ask': Object.freeze(['ask_bot']),
  'connections.external': Object.freeze([]),
});

const SPOKEN_IMAGE_RE =
  /\b(?:generate|create|make|draw|imagine|render|design)\b.{0,48}\b(?:image|picture|photo|illustration|logo|icon|poster)\b/i;
const SPOKEN_IMAGE_OF_RE = /\b(?:image|picture|photo|illustration)\s+of\b/i;
const SPOKEN_TRANSLATE_RE = /\b(?:translate|translation|in\s+(?:spanish|french|german|japanese|chinese|korean|italian|portuguese))\b/i;
const SPOKEN_TIME_RE = /\b(?:what time|current time|what(?:'s| is) the time|what day is it)\b/i;

export function messageWantsSpokenImage(msg) {
  const t = String(msg || '');
  return SPOKEN_IMAGE_RE.test(t) || SPOKEN_IMAGE_OF_RE.test(t);
}

export function messageWantsSpokenTranslate(msg) {
  return SPOKEN_TRANSLATE_RE.test(String(msg || ''));
}

function inferVoiceArtifactTool(message) {
  const t = String(message || '');
  if (!t.trim()) return null;
  if (messageWantsSpokenImage(t) || messageWantsWrittenDocument(t)) return null;
  if (/\b(?:video|mp4|motion graphics?)\b/i.test(t) && /\b(?:make|build|create|generate|render|animate)\b/i.test(t)) {
    return 'lykn_render_video';
  }
  if (/\b(?:spread\s?sheet|xlsx|csv|data table)\b/i.test(t)) return 'lykn_build_spreadsheet';
  if (/\b(?:pitch\s?deck|slide\s?deck|slideshow|presentation|keynote)\b/i.test(t)) return 'lykn_build_template';
  if (/\b(?:chart|graph|plot)\b/i.test(t) && /\b(?:make|build|create|generate|draw)\b/i.test(t)) {
    return 'lykn_generate_chart';
  }
  if (/\b(?:diagram|flow\s?chart|mind\s?map)\b/i.test(t)) return 'lykn_generate_diagram';
  if (artifactBuildIntent.isTypedNewDeliverableAsk(t) || messageLooksLikeMakeAsk(t)) {
    return 'lykn_build_react_artifact';
  }
  return null;
}

const CUSTOM_REST_VOICE_TOOLS = Object.freeze(['list_apps', 'call_app']);

function orderVoiceNames(names) {
  const set = new Set(names || []);
  return LYKN_VOICE_TOOL_NAMES.filter((n) => set.has(n));
}

export function voiceToolsForCapabilities(capabilities, ctx = {}) {
  const set = new Set();
  for (const cap of capabilities || []) {
    const names = VOICE_TOOLS_BY_CAPABILITY[cap];
    if (names) for (const n of names) set.add(n);
  }
  // Custom REST is Voice-isolated. Disclose only when the user asked for
  // connected-app APIs, never as a hidden MCP fallback (Gmail/Slack/etc.).
  if (messageWantsConnectedAppApis(ctx.message)) {
    for (const n of CUSTOM_REST_VOICE_TOOLS) set.add(n);
  }
  return orderVoiceNames([...set]);
}

function voiceCapabilityCtx(ctx = {}) {
  const message = ctx.message || '';
  const spokenImage = messageWantsSpokenImage(message);
  const spokenCursor = messageWantsCursor(message);
  const spokenDoc = messageWantsWrittenDocument(message);
  const artifactToolName = inferVoiceArtifactTool(message);
  const spokenMake = Boolean(artifactToolName) && !spokenDoc;
  return {
    message,
    conversation: ctx.conversation || [],
    exclusiveComposerMode: null,
    localMode: Boolean(ctx.localMode),
    overlayAsk: false,
    inProject: Boolean(ctx.inProject),
    lyknBots: Array.isArray(ctx.lyknBots) ? ctx.lyknBots : [],
    allowNewArtifactBuild: Boolean(spokenMake || spokenCursor || artifactToolName),
    lockOutArtifactBuilds: false,
    forceImage: spokenImage,
    artifactToolName: spokenMake ? artifactToolName : null,
    activeArtifactEditable: false,
  };
}

/**
 * Voice-turn disclosure: capabilities → Voice aliases → optional MCP.
 */
export function resolveVoiceTurnDisclosure(ctx = {}) {
  const capabilityResult = resolveFirstPartyCapabilities(voiceCapabilityCtx(ctx));
  const capabilities = [...capabilityResult.capabilities];
  if (messageWantsSpokenTranslate(ctx.message) && !capabilities.includes('media.translate')) {
    capabilities.push('media.translate');
  }
  if (SPOKEN_TIME_RE.test(String(ctx.message || '')) && !capabilities.includes('compute.time')) {
    capabilities.push('compute.time');
  }
  const firstPartyToolNames = voiceToolsForCapabilities(capabilities, ctx);
  const externalTools = typeof ctx.resolveExternal === 'function'
    ? ctx.resolveExternal(capabilityResult.externalNeeds) || []
    : selectExternalToolsForNeeds(ctx.discoveredExternalTools || [], capabilityResult.externalNeeds);
  const selectedExternal = (Array.isArray(externalTools) ? externalTools : [])
    .slice(0, MAX_EXTERNAL_TOOLS_PER_DISCLOSURE);
  const inspect = measureVoiceToolSchemas(firstPartyToolNames, ctx.format || 'realtime');
  return {
    capabilities,
    exclusive: capabilityResult.exclusive,
    fallback: capabilityResult.fallback,
    reasons: capabilityResult.reasons,
    externalNeeds: capabilityResult.externalNeeds,
    firstPartyToolNames,
    externalTools: selectedExternal,
    toolNames: [...firstPartyToolNames, ...selectedExternal.map((t) => t.name).filter(Boolean)],
    inspect,
  };
}

export function serializeVoiceRealtimeTools(names) {
  const defs = (names || []).map((n) => LYKN_VOICE_TOOL_BY_NAME[n]).filter(Boolean);
  return toRealtimeTools(defs);
}

export function serializeVoiceOpenAiChatTools(names) {
  const defs = (names || []).map((n) => LYKN_VOICE_TOOL_BY_NAME[n]).filter(Boolean);
  return toOpenAiChatTools(defs);
}

/**
 * Filter an upstream OpenAI-shaped tools[] (ElevenLabs custom LLM) down to
 * this turn's Voice aliases. First-party Voice names not disclosed this turn
 * are dropped. Non-Voice names (MCP / agent extras) stay only when the turn
 * has an external need, capped at MAX_EXTERNAL_TOOLS_PER_DISCLOSURE.
 */
export function filterOpenAiToolsForVoiceDisclosure(upstreamTools, disclosure) {
  const voiceAllowed = new Set(disclosure?.firstPartyToolNames || []);
  const voiceAll = new Set([
    ...LYKN_VOICE_TOOL_NAMES,
    ...RETIRED_VOICE_ALIASES.map((a) => a.name),
  ]);
  const externalAllowed = new Set((disclosure?.externalTools || []).map((t) => t.name));
  const keepUnknown = (disclosure?.externalNeeds || []).length > 0;
  const incoming = Array.isArray(upstreamTools) ? upstreamTools : [];
  const filtered = [];
  let unknownKept = 0;
  for (const tool of incoming) {
    const name = tool?.function?.name || tool?.name;
    if (!name) continue;
    if (voiceAll.has(name)) {
      if (voiceAllowed.has(name)) filtered.push(tool);
      continue;
    }
    if (externalAllowed.has(name) || (keepUnknown && unknownKept < MAX_EXTERNAL_TOOLS_PER_DISCLOSURE)) {
      filtered.push(tool);
      if (!externalAllowed.has(name)) unknownKept += 1;
    }
  }
  const have = new Set(filtered.map((t) => t?.function?.name || t?.name));
  const missingVoice = serializeVoiceOpenAiChatTools(
    (disclosure?.firstPartyToolNames || []).filter((n) => !have.has(n)),
  );
  return [...filtered, ...missingVoice];
}

export function inspectVoiceDisclosure(message, extra = {}) {
  return resolveVoiceTurnDisclosure({ message, ...extra });
}
