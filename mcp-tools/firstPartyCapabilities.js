// ============================================================================
// mcp-tools/firstPartyCapabilities.js — Chat first-party progressive disclosure
// ============================================================================
// Canonical capability metadata + resolvers for IN-APP Chat tools.
//
//   User turn / Chat context
//           ↓
//   FirstPartyCapabilityResolver   (deterministic family inference)
//           ↓
//   small capability set
//           ↓
//   FirstPartyToolResolver         (family → canonical tool names)
//           ↓
//   composeWithExternalTools       (optional MCP / ExternalToolResolver)
//           ↓
//   resolveChatTools(names) → provider serialization
//
// DISCLOSURE IS NOT AUTHORIZATION.
// Hiding a tool from the model is a token/accuracy optimization.
// Execution still requires:
//   CHAT_TOOLS_BY_NAME ∩ turn allowedToolNames ∩ handler gates
//   Local Mode: Electron approval + localToolNames
//   TaskRuntime (when Chat is a Task): capabilities[] ∩ consequence
//
// This module does not execute tools, does not own MCP connections, and
// does not change Voice.

import { CHAT_TOOL_NAMES, buildOpenAiTools } from './chatTools.js';
import { LOCAL_TOOL_NAMES, looksLikeLocalSystemAsk, mightBeBrowserTaskAsk } from './localTools.js';
import {
  CALENDAR_SURFACE_INTENT,
  PLATE_SURFACE_INTENT,
  READ_VERB_RE,
  REMINDER_SURFACE_INTENT,
  TODO_SURFACE_INTENT,
  WRITE_VERB_RE,
  inferExternalCapabilityNeeds,
  messageLooksLikeMakeAsk,
  messageWantsAgentTools,
  messageWantsCalc,
  messageWantsCursor,
  messageWantsHttp,
  messageWantsLocalApps,
  messageWantsLocalDesktop,
  messageWantsLocalFilesWrite,
  messageWantsLocalFolderPeek,
  messageWantsLocalShell,
  messageWantsMemoryWrite,
  messageWantsOpenApp,
  messageWantsOpenSettings,
  messageWantsPageFetch,
  messageWantsPrefs,
  messageWantsProjectContext,
  messageWantsRemoteSession,
  messageWantsSavedRecall,
  messageWantsSelfTune,
  messageWantsSteward,
  messageWantsUrlFetch,
  messageWantsUserRecallCore,
  messageWantsVaultWrite,
  messageWantsWebTools,
  resolveIntentChatToolNames,
} from './chatIntentSignals.js';

export const MAX_EXTERNAL_TOOLS_PER_DISCLOSURE = 10;

export const FIRST_PARTY_CAPABILITY_FAMILIES = Object.freeze([
  'memory.read',
  'memory.write',
  'prefs.read',
  'prefs.write',
  'projects.read',
  'projects.write',
  'projects.destroy',
  'vault.read',
  'vault.write',
  'calendar.read',
  'calendar.write',
  'reminders.read',
  'reminders.write',
  'tasks.read',
  'tasks.write',
  'steward.read',
  'steward.write',
  'web.search',
  'web.read',
  'web.http',
  'compute.math',
  'compute.code',
  'compute.time',
  'media.image',
  'media.video',
  'media.audio',
  'media.parse',
  'media.translate',
  'artifacts.build',
  'artifacts.edit',
  'coding.cursor',
  'shell.open',
  'self.write',
  'local.files.read',
  'local.files.write',
  'local.apps',
  'local.shell',
  'local.desktop',
  'browser.agent',
  'connections.external',
]);

const FAMILY_SET = new Set(FIRST_PARTY_CAPABILITY_FAMILIES);

function meta(entry) {
  return Object.freeze({
    alwaysAvailable: false,
    localMode: false,
    surfaces: ['chat'],
    aliases: [],
    composerModes: null,
    ...entry,
  });
}

/**
 * Canonical metadata for every live Chat-callable tool.
 * Schemas stay in the tool definitions; this table only classifies them.
 */
export const FIRST_PARTY_TOOL_METADATA = Object.freeze(
  [
    meta({ name: 'memory_list', capabilities: ['memory.read'], family: 'memory.read', consequence: 'read' }),
    meta({ name: 'memory_read', capabilities: ['memory.read'], family: 'memory.read', consequence: 'read' }),
    meta({ name: 'memory_patch', capabilities: ['memory.write'], family: 'memory.write', consequence: 'write' }),
    meta({ name: 'memory_create', capabilities: ['memory.write'], family: 'memory.write', consequence: 'write' }),
    meta({ name: 'memory_forget', capabilities: ['memory.write'], family: 'memory.write', consequence: 'write' }),
    meta({ name: 'lykn_getUserPreferences', capabilities: ['prefs.read'], family: 'prefs.read', consequence: 'read' }),
    meta({ name: 'lykn_updateUserPreference', capabilities: ['prefs.write'], family: 'prefs.write', consequence: 'write' }),
    meta({ name: 'lykn_listProjects', capabilities: ['projects.read'], family: 'projects.read', consequence: 'read' }),
    meta({ name: 'lykn_resolveProject', capabilities: ['projects.read'], family: 'projects.read', consequence: 'read' }),
    meta({ name: 'lykn_getProjectState', capabilities: ['projects.read'], family: 'projects.read', consequence: 'read' }),
    meta({ name: 'lykn_getProjectNeurons', capabilities: ['projects.read'], family: 'projects.read', consequence: 'read' }),
    meta({ name: 'lykn_getRecentActivity', capabilities: ['projects.read'], family: 'projects.read', consequence: 'read' }),
    meta({ name: 'lykn_loadNeuron', capabilities: ['vault.read'], family: 'vault.read', consequence: 'read' }),
    meta({ name: 'lykn_loadNeurons', capabilities: ['vault.read'], family: 'vault.read', consequence: 'read' }),
    meta({
      name: 'lykn_pushProjectState',
      capabilities: ['projects.write'],
      family: 'projects.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_addProjectNeurons',
      capabilities: ['projects.write'],
      family: 'projects.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_removeProjectNeurons',
      capabilities: ['projects.write'],
      family: 'projects.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_uploadToProject',
      capabilities: ['projects.write'],
      family: 'projects.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_setActiveProject',
      capabilities: ['projects.write'],
      family: 'projects.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_createProject',
      capabilities: ['projects.write'],
      family: 'projects.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_updateProject',
      capabilities: ['projects.write'],
      family: 'projects.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_deleteProject',
      capabilities: ['projects.destroy'],
      family: 'projects.destroy',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_mergeProjects',
      capabilities: ['projects.destroy'],
      family: 'projects.destroy',
      consequence: 'write',
    }),
    meta({ name: 'lykn_createVaultNote', capabilities: ['vault.write'], family: 'vault.write', consequence: 'write' }),
    meta({ name: 'lykn_saveFileToVault', capabilities: ['vault.write'], family: 'vault.write', consequence: 'write' }),
    meta({ name: 'lykn_saveLinkToVault', capabilities: ['vault.write'], family: 'vault.write', consequence: 'write' }),
    meta({
      name: 'lykn_createReminder',
      capabilities: ['reminders.write'],
      family: 'reminders.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_listReminders',
      capabilities: ['reminders.read'],
      family: 'reminders.read',
      consequence: 'read',
    }),
    meta({
      name: 'lykn_updateReminder',
      capabilities: ['reminders.write'],
      family: 'reminders.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_createEvent',
      capabilities: ['calendar.write'],
      family: 'calendar.write',
      consequence: 'write',
    }),
    meta({ name: 'lykn_listEvents', capabilities: ['calendar.read'], family: 'calendar.read', consequence: 'read' }),
    meta({
      name: 'lykn_updateEvent',
      capabilities: ['calendar.write'],
      family: 'calendar.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_deleteEvent',
      capabilities: ['calendar.write'],
      family: 'calendar.write',
      consequence: 'write',
    }),
    meta({ name: 'lykn_createTodo', capabilities: ['tasks.write'], family: 'tasks.write', consequence: 'write' }),
    meta({ name: 'lykn_listTodos', capabilities: ['tasks.read'], family: 'tasks.read', consequence: 'read' }),
    meta({ name: 'lykn_updateTodo', capabilities: ['tasks.write'], family: 'tasks.write', consequence: 'write' }),
    meta({ name: 'lykn_deleteTodo', capabilities: ['tasks.write'], family: 'tasks.write', consequence: 'write' }),
    meta({
      name: 'lykn_createStewardItem',
      capabilities: ['steward.write'],
      family: 'steward.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_listStewardItems',
      capabilities: ['steward.read'],
      family: 'steward.read',
      consequence: 'read',
    }),
    meta({
      name: 'lykn_updateStewardItem',
      capabilities: ['steward.write'],
      family: 'steward.write',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_build_with_cursor',
      capabilities: ['coding.cursor'],
      family: 'coding.cursor',
      consequence: 'write',
    }),
    meta({
      name: 'lykn_check_cursor_build',
      capabilities: ['coding.cursor'],
      family: 'coding.cursor',
      consequence: 'read',
    }),
    meta({ name: 'lykn_update_assistant_instructions', capabilities: ['self.write'], family: 'self.write', consequence: 'write' }),
    meta({ name: 'lykn_open_settings', capabilities: ['shell.open'], family: 'shell.open', consequence: 'read' }),
    meta({ name: 'lykn_open_app', capabilities: ['shell.open'], family: 'shell.open', consequence: 'read' }),
    meta({ name: 'lykn_web_search', capabilities: ['web.search'], family: 'web.search', consequence: 'read', composerModes: ['web', 'research'] }),
    meta({ name: 'lykn_web_fetch', capabilities: ['web.read'], family: 'web.read', consequence: 'read', composerModes: ['web', 'research'] }),
    meta({ name: 'lykn_calculate', capabilities: ['compute.math'], family: 'compute.math', consequence: 'read' }),
    meta({ name: 'lykn_symbolic_math', capabilities: ['compute.math'], family: 'compute.math', consequence: 'read' }),
    meta({ name: 'lykn_run_python', capabilities: ['compute.code'], family: 'compute.code', consequence: 'read' }),
    meta({ name: 'lykn_run_code', capabilities: ['compute.code'], family: 'compute.code', consequence: 'read' }),
    meta({ name: 'lykn_get_current_time', capabilities: ['compute.time'], family: 'compute.time', consequence: 'read' }),
    meta({ name: 'lykn_http_request', capabilities: ['web.http'], family: 'web.http', consequence: 'read' }),
    meta({ name: 'lykn_parse_document', capabilities: ['media.parse'], family: 'media.parse', consequence: 'read' }),
    meta({ name: 'lykn_transcribe_audio', capabilities: ['media.audio'], family: 'media.audio', consequence: 'read' }),
    meta({
      name: 'lykn_translate',
      capabilities: ['media.translate'],
      family: 'media.translate',
      consequence: 'read',
      composerModes: ['translate'],
    }),
    meta({
      name: 'lykn_generate_image',
      capabilities: ['media.image'],
      family: 'media.image',
      consequence: 'write',
      composerModes: ['image'],
    }),
    meta({
      name: 'lykn_process_image',
      capabilities: ['media.image'],
      family: 'media.image',
      consequence: 'write',
      composerModes: ['image'],
    }),
    meta({ name: 'lykn_generate_speech', capabilities: ['media.audio'], family: 'media.audio', consequence: 'write' }),
    meta({ name: 'lykn_generate_chart', capabilities: ['artifacts.build'], family: 'artifacts.build', consequence: 'write' }),
    meta({ name: 'lykn_generate_diagram', capabilities: ['artifacts.build'], family: 'artifacts.build', consequence: 'write' }),
    meta({ name: 'lykn_manage_file', capabilities: ['artifacts.edit', 'artifacts.build'], family: 'artifacts.edit', consequence: 'write' }),
    meta({ name: 'lykn_build_spreadsheet', capabilities: ['artifacts.build'], family: 'artifacts.build', consequence: 'write' }),
    meta({ name: 'lykn_build_template', capabilities: ['artifacts.build'], family: 'artifacts.build', consequence: 'write' }),
    meta({ name: 'lykn_build_react_artifact', capabilities: ['artifacts.build'], family: 'artifacts.build', consequence: 'write' }),
    meta({ name: 'lykn_render_video', capabilities: ['media.video', 'artifacts.build'], family: 'media.video', consequence: 'write' }),
    meta({
      name: 'local_list_dir',
      capabilities: ['local.files.read'],
      family: 'local.files.read',
      consequence: 'read',
      localMode: true,
      surfaces: ['chat'],
    }),
    meta({
      name: 'local_read_file',
      capabilities: ['local.files.read'],
      family: 'local.files.read',
      consequence: 'read',
      localMode: true,
    }),
    meta({
      name: 'local_search_files',
      capabilities: ['local.files.read'],
      family: 'local.files.read',
      consequence: 'read',
      localMode: true,
    }),
    meta({
      name: 'local_pull_file',
      capabilities: ['local.files.read'],
      family: 'local.files.read',
      consequence: 'read',
      localMode: true,
    }),
    meta({
      name: 'local_synced_folders',
      capabilities: ['local.files.read'],
      family: 'local.files.read',
      consequence: 'read',
      localMode: true,
    }),
    meta({
      name: 'local_write_file',
      capabilities: ['local.files.write'],
      family: 'local.files.write',
      consequence: 'write',
      localMode: true,
    }),
    meta({
      name: 'local_edit_file',
      capabilities: ['local.files.write'],
      family: 'local.files.write',
      consequence: 'write',
      localMode: true,
    }),
    meta({
      name: 'local_run_command',
      capabilities: ['local.shell'],
      family: 'local.shell',
      consequence: 'write',
      localMode: true,
    }),
    meta({
      name: 'local_running_apps',
      capabilities: ['local.apps'],
      family: 'local.apps',
      consequence: 'read',
      localMode: true,
    }),
    meta({
      name: 'local_read_app',
      capabilities: ['local.apps'],
      family: 'local.apps',
      consequence: 'read',
      localMode: true,
    }),
    meta({
      name: 'local_open_app',
      capabilities: ['local.apps'],
      family: 'local.apps',
      consequence: 'read',
      localMode: true,
    }),
    meta({
      name: 'local_open_path',
      capabilities: ['local.files.read', 'local.apps'],
      family: 'local.files.read',
      consequence: 'read',
      localMode: true,
    }),
    meta({
      name: 'local_organize_desktop',
      capabilities: ['local.desktop'],
      family: 'local.desktop',
      consequence: 'write',
      localMode: true,
    }),
    meta({
      name: 'local_browser_agent',
      capabilities: ['browser.agent'],
      family: 'browser.agent',
      consequence: 'write',
      localMode: true,
    }),
  ].map((row) => Object.freeze(row)),
);

export const FIRST_PARTY_TOOL_METADATA_BY_NAME = Object.freeze(
  Object.fromEntries(FIRST_PARTY_TOOL_METADATA.map((row) => [row.name, row])),
);

/**
 * Live in a first-party registry but not Chat-disclosed by default.
 * Do not delete; classify only.
 */
export const FIRST_PARTY_TOOL_EXCLUSIONS = Object.freeze([
  Object.freeze({
    name: 'lykn_searchVault',
    status: 'legacy',
    rationale: 'Voice search_vault still dispatches; Chat skipVaultSearch rejects it. Not in CHAT_TOOL_NAMES.',
  }),
  Object.freeze({
    name: 'lykn_list_apps',
    status: 'hidden',
    rationale: 'Voice-only connected-app listing. Not in CHAT_TOOL_NAMES.',
  }),
  Object.freeze({
    name: 'lykn_call_app',
    status: 'hidden',
    rationale: 'Voice-only connected-app calls. Not in CHAT_TOOL_NAMES.',
  }),
  Object.freeze({
    name: 'lykn_listCustomModels',
    status: 'feature-gated',
    rationale: 'CUSTOM_MODELS_ENABLED is off; overlay voice still lists a drifted alias.',
  }),
  Object.freeze({
    name: 'lykn_delegate_to_sub_model',
    status: 'feature-gated',
    rationale: 'Main-agent orchestration injects this when custom models are on. Not a default Chat family.',
  }),
  Object.freeze({
    name: 'lykn_list_sub_model_tasks',
    status: 'feature-gated',
    rationale: 'Main-agent orchestration only.',
  }),
  Object.freeze({
    name: 'lykn_get_sub_model_task',
    status: 'feature-gated',
    rationale: 'Main-agent orchestration only.',
  }),
  Object.freeze({
    name: 'lykn_communicate_with_model',
    status: 'feature-gated',
    rationale: 'Soft-unplugged custom-model chat. Prompt residue only until Phase B.',
  }),
]);

export const CHAT_MAKER_TOOL_NAMES = Object.freeze(
  new Set([
    'lykn_build_react_artifact',
    'lykn_build_template',
    'lykn_build_spreadsheet',
    'lykn_manage_file',
    'lykn_render_video',
    'lykn_generate_chart',
    'lykn_generate_diagram',
    'lykn_build_with_cursor',
    'lykn_check_cursor_build',
  ]),
);

export const PROJECT_AGENT_TOOLS = Object.freeze(
  new Set([
    'lykn_listProjects',
    'lykn_resolveProject',
    'lykn_getProjectState',
    'lykn_getProjectNeurons',
    'lykn_pushProjectState',
    'lykn_setActiveProject',
    'lykn_createProject',
    'lykn_updateProject',
    'lykn_deleteProject',
    'lykn_mergeProjects',
    'lykn_addProjectNeurons',
    'lykn_removeProjectNeurons',
  ]),
);

export const GLASS_SCREEN_MAKER_TOOLS = Object.freeze(
  new Set(['lykn_generate_chart', 'lykn_generate_diagram', 'lykn_build_react_artifact']),
);

export const GLASS_VAULT_TOOLS = Object.freeze(new Set(['lykn_loadNeuron', 'lykn_loadNeurons']));

const LOCAL_DISCOVERY_TOOLS = Object.freeze([
  'local_synced_folders',
  'local_list_dir',
  'local_search_files',
]);

const IMAGE_TOOLS = Object.freeze(['lykn_generate_image', 'lykn_process_image']);
const WEB_TOOLS = Object.freeze(['lykn_web_search', 'lykn_web_fetch']);

const CAPABILITY_TO_TOOLS = (() => {
  const map = new Map();
  for (const family of FIRST_PARTY_CAPABILITY_FAMILIES) map.set(family, []);
  for (const row of FIRST_PARTY_TOOL_METADATA) {
    for (const cap of row.capabilities) {
      if (!map.has(cap)) map.set(cap, []);
      map.get(cap).push(row.name);
    }
  }
  return map;
})();

export function toolsForCapabilities(capabilities) {
  const set = new Set();
  for (const cap of capabilities || []) {
    const names = CAPABILITY_TO_TOOLS.get(cap);
    if (names) for (const n of names) set.add(n);
  }
  return orderToolNames([...set]);
}

export function capabilitiesForToolNames(toolNames) {
  const set = new Set();
  for (const name of toolNames || []) {
    const row = FIRST_PARTY_TOOL_METADATA_BY_NAME[name];
    if (!row) continue;
    for (const cap of row.capabilities) set.add(cap);
  }
  return [...set];
}

export function orderToolNames(names) {
  const set = new Set(names || []);
  return [...CHAT_TOOL_NAMES, ...LOCAL_TOOL_NAMES].filter((n) => set.has(n));
}

export function measureChatToolSchemas(toolNames) {
  const tools = buildOpenAiTools(toolNames);
  if (!tools || !tools.length) {
    return { count: 0, bytes: 0, approxTokens: 0 };
  }
  const json = JSON.stringify(tools);
  const bytes = Buffer.byteLength(json, 'utf8');
  return {
    count: tools.length,
    bytes,
    approxTokens: Math.round(bytes / 4),
  };
}

function addCap(set, cap) {
  if (FAMILY_SET.has(cap)) set.add(cap);
}

function exclusiveModeOf(ctx) {
  if (ctx.deepResearch || ctx.exclusiveComposerMode === 'research') return 'research';
  if (ctx.translateMode || ctx.exclusiveComposerMode === 'translate') return 'translate';
  if ((ctx.forceImage && !ctx.forceArtifact) || ctx.exclusiveComposerMode === 'image') return 'image';
  if (ctx.exclusiveComposerMode === 'web') return 'web';
  return null;
}

function schedulingCapabilities(message, caps) {
  const t = String(message || '');
  const wantsTodo = TODO_SURFACE_INTENT.test(t);
  const wantsCal = CALENDAR_SURFACE_INTENT.test(t);
  const wantsRem = REMINDER_SURFACE_INTENT.test(t);
  const wantsPlate = PLATE_SURFACE_INTENT.test(t);
  if (!wantsTodo && !wantsCal && !wantsRem && !wantsPlate) return;
  const writes = WRITE_VERB_RE.test(t);
  if (wantsTodo) {
    addCap(caps, 'tasks.read');
    if (writes) addCap(caps, 'tasks.write');
  }
  if (wantsCal) {
    addCap(caps, 'calendar.read');
    addCap(caps, 'compute.time');
    if (writes) addCap(caps, 'calendar.write');
  }
  if (wantsRem) {
    addCap(caps, 'reminders.read');
    addCap(caps, 'compute.time');
    if (writes) addCap(caps, 'reminders.write');
  }
  if (wantsPlate && !wantsTodo && !wantsCal && !wantsRem) {
    addCap(caps, 'tasks.read');
    addCap(caps, 'calendar.read');
    addCap(caps, 'reminders.read');
    addCap(caps, 'compute.time');
  }
}

function localCapabilities(ctx, caps) {
  if (!ctx.localMode) return 'none';
  const t = String(ctx.message || '');
  const localAsk = looksLikeLocalSystemAsk(t);
  const browserAsk = mightBeBrowserTaskAsk(t);
  let matched = false;
  if (localAsk && messageWantsLocalFilesWrite(t)) {
    addCap(caps, 'local.files.write');
    addCap(caps, 'local.files.read');
    matched = true;
  } else if (localAsk && !messageWantsLocalShell(t) && !messageWantsLocalApps(t) && !messageWantsLocalDesktop(t)) {
    addCap(caps, 'local.files.read');
    matched = true;
  }
  if (messageWantsLocalShell(t)) {
    addCap(caps, 'local.shell');
    addCap(caps, 'local.files.read');
    matched = true;
  }
  if (messageWantsLocalApps(t)) {
    addCap(caps, 'local.apps');
    matched = true;
  }
  if (messageWantsLocalDesktop(t)) {
    addCap(caps, 'local.desktop');
    matched = true;
  }
  if (browserAsk) {
    addCap(caps, 'browser.agent');
    matched = true;
  }
  if (!matched && messageWantsLocalFolderPeek(t)) {
    addCap(caps, 'local.files.read');
    matched = true;
  }
  if (matched) return 'matched';
  if (localAsk) {
    addCap(caps, 'local.files.read');
    return 'discovery';
  }
  return 'none';
}

/**
 * FirstPartyCapabilityResolver — deterministic, no extra LLM call.
 */
export function resolveFirstPartyCapabilities(ctx = {}) {
  const message = String(ctx.message || '');
  const reasons = [];
  const caps = new Set();
  const exclusive = exclusiveModeOf(ctx);

  if (exclusive === 'research' || exclusive === 'web') {
    addCap(caps, 'web.search');
    addCap(caps, 'web.read');
    reasons.push(`exclusive:${exclusive}`);
    return finalizeCapabilities(caps, {
      exclusive,
      fallback: 'none',
      externalNeeds: [],
      reasons,
      keepToolsOn: true,
    });
  }
  if (exclusive === 'translate') {
    reasons.push('exclusive:translate');
    return finalizeCapabilities(caps, {
      exclusive,
      fallback: 'empty',
      externalNeeds: [],
      reasons,
      keepToolsOn: false,
    });
  }
  if (exclusive === 'image') {
    addCap(caps, 'media.image');
    reasons.push('exclusive:image');
    return finalizeCapabilities(caps, {
      exclusive,
      fallback: 'none',
      externalNeeds: [],
      reasons,
      keepToolsOn: true,
    });
  }

  // Existing lean-name helper is an input, not a fallback dump. Exclusive
  // modes already returned above. A null here means "no tiny allowlist",
  // never "attach the leftover 42".
  const leanNames = resolveIntentChatToolNames(message, ctx);
  if (leanNames === null) reasons.push('intent-lean:unmatched');
  else if (leanNames.length === 0) reasons.push('intent-lean:empty');
  else reasons.push(`intent-lean:${leanNames.length}`);

  schedulingCapabilities(message, caps);

  if (messageWantsSavedRecall(message) && !messageWantsVaultWrite(message)) {
    addCap(caps, 'vault.read');
    reasons.push('vault.read');
  }
  if (messageWantsVaultWrite(message)) {
    addCap(caps, 'vault.write');
    reasons.push('vault.write');
  }
  if (messageWantsProjectContext(message) || (ctx.inProject && WRITE_VERB_RE.test(message))) {
    addCap(caps, 'projects.read');
    if (WRITE_VERB_RE.test(message) || ctx.inProject) addCap(caps, 'projects.write');
    if (/\b(?:delete|merge)\b/i.test(message) && messageWantsProjectContext(message)) {
      addCap(caps, 'projects.destroy');
    }
    reasons.push('projects');
  }
  if (!WRITE_VERB_RE.test(message) && messageWantsProjectContext(message) && READ_VERB_RE.test(message)) {
    caps.delete('projects.write');
    caps.delete('projects.destroy');
  }

  const wantsWeb =
    ctx.forceWebSearch ||
    ctx.deepResearch ||
    messageWantsWebTools(message, { conversation: ctx.conversation });
  const wantsFetch =
    ctx.forcePageFetch ||
    messageWantsPageFetch(message) ||
    messageWantsUrlFetch(message) ||
    (!!ctx.pageUrl &&
      ctx.overlayAsk &&
      /\b(?:website|web\s?site|landing\s?page|homepage|home\s?page|(?:my|this|the)\s+site|this\s+page)\b/i.test(
        message,
      ));
  if (wantsWeb) {
    addCap(caps, 'web.search');
    addCap(caps, 'web.read');
    reasons.push('web');
  } else if (wantsFetch) {
    addCap(caps, 'web.read');
    reasons.push('web.read');
  }
  if (messageWantsCalc(message)) {
    addCap(caps, 'compute.math');
    addCap(caps, 'compute.code');
    reasons.push('compute');
  }
  if (messageWantsHttp(message)) {
    addCap(caps, 'web.http');
    reasons.push('web.http');
  }
  if (messageWantsCursor(message) && ctx.allowNewArtifactBuild && !ctx.lockOutArtifactBuilds) {
    addCap(caps, 'coding.cursor');
    reasons.push('coding.cursor');
  }
  if (messageWantsUserRecallCore(message)) {
    addCap(caps, 'memory.read');
    reasons.push('memory.read');
  }
  if (messageWantsMemoryWrite(message)) {
    addCap(caps, 'memory.write');
    reasons.push('memory.write');
  }
  if (messageWantsPrefs(message)) {
    addCap(caps, 'prefs.read');
    if (WRITE_VERB_RE.test(message)) addCap(caps, 'prefs.write');
    reasons.push('prefs');
  }
  if (messageWantsSteward(message)) {
    addCap(caps, 'steward.read');
    if (WRITE_VERB_RE.test(message)) addCap(caps, 'steward.write');
    reasons.push('steward');
  }
  if (messageWantsSelfTune(message)) {
    addCap(caps, 'self.write');
    reasons.push('self.write');
  }
  if (messageWantsOpenSettings(message) || messageWantsOpenApp(message)) {
    addCap(caps, 'shell.open');
    reasons.push('shell.open');
  }
  if (/\b(?:parse|extract)\b.{0,32}\b(?:pdf|document|docx|spreadsheet)\b/i.test(message)) {
    addCap(caps, 'media.parse');
    reasons.push('media.parse');
  }
  if (/\b(?:transcribe|speech[- ]to[- ]text)\b/i.test(message)) {
    addCap(caps, 'media.audio');
    reasons.push('media.audio');
  }

  if (ctx.forceImage) addCap(caps, 'media.image');
  if (ctx.artifactToolName && ctx.allowNewArtifactBuild && !ctx.lockOutArtifactBuilds && !ctx.brainstormBuildMention) {
    addCap(caps, 'artifacts.build');
    const row = FIRST_PARTY_TOOL_METADATA_BY_NAME[ctx.artifactToolName];
    if (row) for (const cap of row.capabilities) addCap(caps, cap);
    reasons.push('artifactTool');
  }
  if (ctx.activeArtifactEditable && ctx.activeArtifactTool) {
    addCap(caps, 'artifacts.edit');
    const row = FIRST_PARTY_TOOL_METADATA_BY_NAME[ctx.activeArtifactTool];
    if (row) for (const cap of row.capabilities) addCap(caps, cap);
    reasons.push('artifactEdit');
  }

  const localFallback = localCapabilities(ctx, caps);
  if (localFallback !== 'none') reasons.push(`local:${localFallback}`);

  const externalNeeds = inferExternalCapabilityNeeds(message);
  if (externalNeeds.length) {
    addCap(caps, 'connections.external');
    reasons.push('connections.external');
  }

  if (messageWantsRemoteSession(message) && caps.size === 0) {
    reasons.push('remote:task-runtime-only');
    return finalizeCapabilities(caps, {
      exclusive: null,
      fallback: 'empty',
      externalNeeds,
      reasons,
      keepToolsOn: false,
    });
  }

  let fallback = 'none';
  if (caps.size === 0) {
    if (ctx.localMode && looksLikeLocalSystemAsk(message)) {
      addCap(caps, 'local.files.read');
      fallback = 'local-discovery';
      reasons.push('fallback:local-discovery');
    } else {
      fallback = 'empty';
      reasons.push('fallback:empty');
    }
  }

  if (!ctx.allowNewArtifactBuild || ctx.lockOutArtifactBuilds || ctx.brainstormBuildMention || ctx.vagueBuildAsk) {
    caps.delete('artifacts.build');
    if (!ctx.activeArtifactEditable) caps.delete('artifacts.edit');
    if (!ctx.forceImage && exclusive !== 'image') caps.delete('media.image');
    caps.delete('media.video');
  }

  if (!ctx.inProject && !messageWantsProjectContext(message)) {
    caps.delete('projects.read');
    caps.delete('projects.write');
    caps.delete('projects.destroy');
  }

  if (ctx.overlayAsk && !messageWantsSavedRecall(message)) {
    caps.delete('vault.read');
  }

  const wantsAgent = messageWantsAgentTools(message, ctx);
  const keepToolsOn =
    caps.size > 0 ||
    externalNeeds.length > 0 ||
    Boolean(ctx.forceImage || ctx.artifactToolName || ctx.activeArtifactEditable) ||
    wantsAgent && fallback !== 'empty';

  return finalizeCapabilities(caps, {
    exclusive: null,
    fallback,
    externalNeeds,
    reasons,
    keepToolsOn,
  });
}

function finalizeCapabilities(caps, extra) {
  const capabilities = FIRST_PARTY_CAPABILITY_FAMILIES.filter((f) => caps.has(f));
  const keepToolsOn =
    extra.keepToolsOn ||
    capabilities.some((c) => c !== 'connections.external') ||
    extra.externalNeeds.length > 0;
  return {
    capabilities,
    exclusive: extra.exclusive,
    fallback: extra.fallback,
    externalNeeds: extra.externalNeeds,
    reasons: extra.reasons,
    keepToolsOn,
  };
}

/**
 * FirstPartyToolResolver — capability set → ordered canonical tool names.
 */
export function resolveFirstPartyTools(capabilityResult, ctx = {}) {
  const caps = new Set(capabilityResult?.capabilities || []);
  const names = new Set(toolsForCapabilities([...caps]));

  if (ctx.forceImage && !ctx.forceArtifact) {
    return { toolNames: [...IMAGE_TOOLS], exclusive: true };
  }
  if (capabilityResult?.exclusive === 'research' || capabilityResult?.exclusive === 'web') {
    return { toolNames: [...WEB_TOOLS], exclusive: true };
  }
  if (capabilityResult?.exclusive === 'translate') {
    return { toolNames: [], exclusive: true };
  }
  if (capabilityResult?.exclusive === 'image') {
    return { toolNames: [...IMAGE_TOOLS], exclusive: true };
  }

  if (ctx.artifactToolName && ctx.allowNewArtifactBuild && !ctx.lockOutArtifactBuilds && !ctx.brainstormBuildMention) {
    names.add(ctx.artifactToolName);
  }
  if (ctx.activeArtifactEditable && ctx.activeArtifactTool) {
    names.add(ctx.activeArtifactTool);
  }

  const stripMakers =
    !ctx.allowNewArtifactBuild || ctx.lockOutArtifactBuilds || ctx.brainstormBuildMention || ctx.vagueBuildAsk;
  if (stripMakers) {
    const keepEdit =
      ctx.activeArtifactEditable && ctx.activeArtifactTool ? String(ctx.activeArtifactTool) : null;
    for (const n of [...names]) {
      if (keepEdit && n === keepEdit) continue;
      if (CHAT_MAKER_TOOL_NAMES.has(n)) names.delete(n);
      if (!ctx.forceImage && (n === 'lykn_generate_image' || n === 'lykn_process_image')) names.delete(n);
    }
  }

  if (ctx.overlayAsk) {
    const keepMakers = new Set();
    if (ctx.artifactToolName) keepMakers.add(ctx.artifactToolName);
    if (ctx.activeArtifactEditable && ctx.activeArtifactTool) keepMakers.add(String(ctx.activeArtifactTool));
    for (const n of [...names]) {
      if (GLASS_SCREEN_MAKER_TOOLS.has(n) && !keepMakers.has(n)) names.delete(n);
    }
    if (!messageWantsSavedRecall(ctx.message)) {
      for (const n of GLASS_VAULT_TOOLS) names.delete(n);
    }
    if (
      (ctx.forcePageFetch ||
        (ctx.overlayAsk && ctx.pageUrl && messageWantsPageFetch(String(ctx.message || '')))) &&
      !names.has('lykn_web_fetch') &&
      (caps.has('web.read') || ctx.forcePageFetch)
    ) {
      names.add('lykn_web_fetch');
    }
  }

  if (!ctx.inProject && !messageWantsProjectContext(ctx.message)) {
    for (const n of PROJECT_AGENT_TOOLS) names.delete(n);
  }

  if (ctx.agentBrowser) {
    names.delete('lykn_list_apps');
    names.delete('lykn_call_app');
  }

  if (!ctx.localMode) {
    for (const n of LOCAL_TOOL_NAMES) names.delete(n);
  } else if (capabilityResult?.fallback === 'local-discovery') {
    for (const n of LOCAL_TOOL_NAMES) {
      if (!LOCAL_DISCOVERY_TOOLS.includes(n)) names.delete(n);
    }
    for (const n of LOCAL_DISCOVERY_TOOLS) names.add(n);
  }

  if (Array.isArray(ctx.ceilingToolNames)) {
    const ceiling = new Set(ctx.ceilingToolNames);
    for (const n of [...names]) {
      if (!ceiling.has(n) && !n.startsWith('local_')) names.delete(n);
    }
  }

  return { toolNames: orderToolNames([...names]), exclusive: false };
}

export function composeWithExternalTools(firstPartyToolNames, externalTools = [], opts = {}) {
  const max = Number.isFinite(opts.maxExternal)
    ? Math.max(0, Math.floor(opts.maxExternal))
    : MAX_EXTERNAL_TOOLS_PER_DISCLOSURE;
  const firstParty = orderToolNames(firstPartyToolNames || []);
  const selectedExternal = (Array.isArray(externalTools) ? externalTools : []).slice(0, max);
  return {
    firstPartyToolNames: firstParty,
    externalTools: selectedExternal,
    toolNames: [...firstParty, ...selectedExternal.map((t) => t.name).filter(Boolean)],
  };
}

const EXTERNAL_NEED_MATCHERS = {
  email: /\b(gmail|mail|inbox|outlook|message|email)\b/i,
  documents: /\b(docs?|drive|document|dropbox|notion|file)\b/i,
  chat: /\b(slack|chat|message)\b/i,
  issues: /\b(todoist|linear|issue|ticket)\b/i,
};

export function selectExternalToolsForNeeds(discoveredTools, needs, opts = {}) {
  const max = Number.isFinite(opts.max) ? Math.max(0, Math.floor(opts.max)) : MAX_EXTERNAL_TOOLS_PER_DISCLOSURE;
  const needList = Array.isArray(needs) ? needs : [];
  if (!needList.length || !Array.isArray(discoveredTools) || !discoveredTools.length) return [];
  const matched = [];
  for (const tool of discoveredTools) {
    const blob = `${tool.name || ''} ${tool.description || ''} ${tool.connectionKind || ''} ${tool.connectionId || ''}`;
    if (needList.some((need) => (EXTERNAL_NEED_MATCHERS[need] || null)?.test(blob))) {
      matched.push(tool);
      if (matched.length >= max) break;
    }
  }
  return matched.slice(0, max);
}

/**
 * Full Chat-turn disclosure: capabilities → first-party names → optional MCP.
 * Provider adapters must serialize this same name list.
 */
export function resolveChatTurnDisclosure(ctx = {}) {
  const capabilityResult = resolveFirstPartyCapabilities(ctx);
  const { toolNames } = resolveFirstPartyTools(capabilityResult, ctx);
  const externalTools = typeof ctx.resolveExternal === 'function'
    ? ctx.resolveExternal(capabilityResult.externalNeeds) || []
    : selectExternalToolsForNeeds(ctx.discoveredExternalTools || [], capabilityResult.externalNeeds);
  const composed = composeWithExternalTools(toolNames, externalTools);
  const inspect = measureChatToolSchemas(composed.firstPartyToolNames);
  const useSlimGuidance = !ctx.forceImage && !ctx.artifactToolName && !ctx.activeArtifactEditable;
  const keepToolsOn =
    composed.firstPartyToolNames.length > 0 || composed.externalTools.length > 0;
  return {
    capabilities: capabilityResult.capabilities,
    exclusive: capabilityResult.exclusive,
    fallback: capabilityResult.fallback,
    reasons: capabilityResult.reasons,
    externalNeeds: capabilityResult.externalNeeds,
    firstPartyToolNames: composed.firstPartyToolNames,
    externalTools: composed.externalTools,
    toolNames: composed.toolNames,
    keepToolsOn,
    useSlimGuidance,
    inspect,
  };
}

export function expandFirstPartyDisclosure(disclosure, extraCapabilities, ctx = {}) {
  const caps = new Set([...(disclosure?.capabilities || []), ...(extraCapabilities || [])]);
  const capabilityResult = {
    ...disclosure,
    capabilities: FIRST_PARTY_CAPABILITY_FAMILIES.filter((f) => caps.has(f)),
  };
  return resolveFirstPartyTools(capabilityResult, ctx);
}

export function inspectFirstPartyDisclosure(disclosure) {
  const names = disclosure?.firstPartyToolNames || disclosure?.toolNames || [];
  const inspect = measureChatToolSchemas(names);
  return {
    capabilities: disclosure?.capabilities || [],
    toolNames: names,
    fallback: disclosure?.fallback || 'none',
    exclusive: disclosure?.exclusive || null,
    externalNeeds: disclosure?.externalNeeds || [],
    schemaBytes: inspect.bytes,
    approxTokens: inspect.approxTokens,
    toolCount: inspect.count,
  };
}
