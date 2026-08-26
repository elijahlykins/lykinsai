// ============================================================================
// mcp-tools/voiceToolResolver.js — Voice selection over Phase A capabilities
// ============================================================================
// Reuses FirstPartyCapabilityResolver. Does NOT invent a second taxonomy.
// Maps canonical families onto Voice-supported aliases, then optionally
// composes Universal MCP (capped) the same way Chat does.
//
// No extra LLM call. Disclosure is not authorization.

import {
  MAX_EXTERNAL_TOOLS_PER_DISCLOSURE,
  resolveFirstPartyCapabilities,
  selectExternalToolsForNeeds,
} from './firstPartyCapabilities.js';
import { messageWantsConnectedAppApis } from './chatIntentSignals.js';
import {
  LYKN_VOICE_TOOL_BY_NAME,
  LYKN_VOICE_TOOL_NAMES,
  RETIRED_VOICE_ALIASES,
  measureVoiceToolSchemas,
  toOpenAiChatTools,
  toRealtimeTools,
} from './voiceTools.js';

/**
 * Canonical capability family → Voice alias names.
 * Families with no Voice surface stay empty (Chat-only / Local / Browser).
 */
export const VOICE_TOOLS_BY_CAPABILITY = Object.freeze({
  'memory.read': Object.freeze(['memory_list', 'memory_read']),
  'memory.write': Object.freeze(['memory_patch', 'memory_create', 'memory_forget']),
  'projects.read': Object.freeze(['list_projects', 'get_project_state', 'get_recent_activity']),
  'projects.write': Object.freeze([
    'set_active_project',
    'create_project',
    'update_project_state',
    'add_to_project',
  ]),
  'projects.destroy': Object.freeze([]),
  'vault.read': Object.freeze(['search_vault', 'read_document', 'display_document']),
  'vault.write': Object.freeze(['save_to_vault', 'save_link_to_vault']),
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
  'compute.time': Object.freeze([]),
  'prefs.read': Object.freeze([]),
  'prefs.write': Object.freeze([]),
  'steward.read': Object.freeze([]),
  'steward.write': Object.freeze([]),
  'web.http': Object.freeze([]),
  'compute.math': Object.freeze([]),
  'compute.code': Object.freeze([]),
  'media.image': Object.freeze([]),
  'media.video': Object.freeze([]),
  'media.audio': Object.freeze([]),
  'media.parse': Object.freeze([]),
  'media.translate': Object.freeze([]),
  'artifacts.build': Object.freeze([]),
  'artifacts.edit': Object.freeze([]),
  'shell.open': Object.freeze([]),
  'local.files.read': Object.freeze([]),
  'local.files.write': Object.freeze([]),
  'local.apps': Object.freeze([]),
  'local.shell': Object.freeze([]),
  'local.desktop': Object.freeze([]),
  'browser.agent': Object.freeze([]),
  'connections.external': Object.freeze([]),
});

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
  return {
    message: ctx.message || '',
    conversation: ctx.conversation || [],
    exclusiveComposerMode: null,
    localMode: false,
    overlayAsk: false,
    inProject: Boolean(ctx.inProject),
    allowNewArtifactBuild: false,
    lockOutArtifactBuilds: true,
    forceImage: false,
    artifactToolName: null,
    activeArtifactEditable: false,
  };
}

/**
 * Voice-turn disclosure: capabilities → Voice aliases → optional MCP.
 */
export function resolveVoiceTurnDisclosure(ctx = {}) {
  const capabilityResult = resolveFirstPartyCapabilities(voiceCapabilityCtx(ctx));
  const firstPartyToolNames = voiceToolsForCapabilities(capabilityResult.capabilities, ctx);
  const externalTools = typeof ctx.resolveExternal === 'function'
    ? ctx.resolveExternal(capabilityResult.externalNeeds) || []
    : selectExternalToolsForNeeds(ctx.discoveredExternalTools || [], capabilityResult.externalNeeds);
  const selectedExternal = (Array.isArray(externalTools) ? externalTools : [])
    .slice(0, MAX_EXTERNAL_TOOLS_PER_DISCLOSURE);
  const inspect = measureVoiceToolSchemas(firstPartyToolNames, ctx.format || 'realtime');
  return {
    capabilities: capabilityResult.capabilities,
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
