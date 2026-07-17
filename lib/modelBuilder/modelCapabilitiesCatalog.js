import { CHAT_TOOL_NAMES } from '../../mcp-tools/chatTools.js';

/**
 * Maps builder capability ids → runtime chat tool names.
 * Keep in sync with src/lib/modelBuilder/modelCapabilitiesCatalog.js
 */
export const CAPABILITY_RUNTIME_MAP = Object.freeze({
  web_search: ['lykn_web_search'],
  web_scrape: ['lykn_web_fetch'],
  file_editor: ['lykn_manage_file'],
  file_creator: ['lykn_manage_file', 'lykn_build_react_artifact'],
  file_converter: ['lykn_manage_file'],
  document_parse: ['lykn_parse_document'],
  code_write: ['lykn_run_code'],
  code_debug: ['lykn_run_code'],
  code_review: ['lykn_run_code'],
  code_refactor: ['lykn_run_code'],
  data_analysis: ['lykn_run_python', 'lykn_run_code'],
  data_visualization: ['lykn_generate_chart', 'lykn_generate_diagram'],
  spreadsheet_tables: ['lykn_build_spreadsheet'],
  math_calculate: ['lykn_calculate'],
  math_symbolic: ['lykn_symbolic_math'],
  math_units: ['lykn_calculate'],
  ocr: ['lykn_process_image'],
  image_generation: ['lykn_generate_image'],
  image_edit: ['lykn_process_image', 'lykn_generate_image'],
  image_analysis: ['lykn_process_image'],
  transcription: ['lykn_transcribe_audio'],
  audio_generation: ['lykn_generate_speech'],
  template_slideshow: ['lykn_build_template'],
  template_presentation: ['lykn_build_template'],
  template_education: ['lykn_build_template'],
  template_worksheet: ['lykn_build_template'],
  template_document: ['lykn_build_template', 'lykn_build_react_artifact'],
  template_email: ['lykn_build_template'],
  template_form: ['lykn_build_template'],
  template_social: ['lykn_build_template'],
  template_layout: ['lykn_build_template'],
  template_generic: ['lykn_build_template'],
  search_vault: ['lykn_searchVault'],
  project_list: ['lykn_listProjects'],
  project_view: ['lykn_getProjectState'],
  project_update: ['lykn_updateProject'],
  project_delete: ['lykn_deleteProject'],
  project_merge: ['lykn_mergeProjects'],
  project_set_active: ['lykn_setActiveProject'],
  project_push_state: ['lykn_pushProjectState'],
  translation: ['lykn_translate'],
  api_request: ['lykn_http_request'],
});

export const ALL_MODEL_CAPABILITY_IDS = Object.freeze([
  'web_search',
  'web_scrape',
  'file_editor',
  'file_creator',
  'file_converter',
  'document_parse',
  'code_write',
  'code_debug',
  'code_review',
  'code_refactor',
  'data_analysis',
  'data_visualization',
  'spreadsheet_tables',
  'math_calculate',
  'math_symbolic',
  'math_units',
  'ocr',
  'image_generation',
  'image_edit',
  'image_analysis',
  'transcription',
  'audio_generation',
  'template_slideshow',
  'template_presentation',
  'template_education',
  'template_worksheet',
  'template_document',
  'template_email',
  'template_form',
  'template_social',
  'template_layout',
  'template_generic',
  'search_vault',
  'project_list',
  'project_view',
  'project_update',
  'project_push_state',
  'project_set_active',
  'project_merge',
  'project_delete',
  'translation',
  'api_request',
]);

const CAPABILITY_ID_SET = new Set(ALL_MODEL_CAPABILITY_IDS);
const CHAT_TOOL_NAME_SET = new Set(CHAT_TOOL_NAMES);

/** Keep in sync with src/lib/modelBuilder/modelCapabilitiesCatalog.js */
export const DEFAULT_MODEL_CAPABILITIES = [
  'web_search',
  'web_scrape',
  'code_write',
  'code_debug',
  'data_analysis',
  'data_visualization',
  'math_calculate',
  'search_vault',
  'project_list',
  'project_update',
  'project_push_state',
  'file_creator',
  'template_presentation',
];

/** @param {unknown} raw */
export function sanitizeModelCapabilities(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    const n = String(id || '').trim();
    if (!n || !CAPABILITY_ID_SET.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** @param {string[]} capabilities */
export function capabilitiesToRuntimeToolNames(capabilities) {
  const seen = new Set();
  const out = [];
  for (const cap of sanitizeModelCapabilities(capabilities)) {
    const tools = CAPABILITY_RUNTIME_MAP[cap];
    if (!tools) continue;
    for (const name of tools) {
      if (!CHAT_TOOL_NAME_SET.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Infer capabilities from a legacy runtime tool list. */
export function runtimeToolsToCapabilities(toolNames) {
  if (!Array.isArray(toolNames)) return [];
  const toolSet = new Set(toolNames.map((n) => String(n || '').trim()).filter(Boolean));
  const out = [];
  for (const cap of ALL_MODEL_CAPABILITY_IDS) {
    const mapped = CAPABILITY_RUNTIME_MAP[cap];
    if (!mapped?.length) continue;
    if (mapped.some((t) => toolSet.has(t))) out.push(cap);
  }
  return out;
}

/** @param {string} capabilityId */
export function isCapabilityImplemented(capabilityId) {
  return Boolean(CAPABILITY_RUNTIME_MAP[capabilityId]?.length);
}
