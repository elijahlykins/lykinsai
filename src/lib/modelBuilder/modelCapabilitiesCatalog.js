/** Capability options shown in Model Builder (UI catalog). */

/** @typedef {{ id: string, label: string, implemented?: boolean, risky?: boolean }} ModelCapabilityDef */

/** Keep in sync with lib/modelBuilder/modelCapabilitiesCatalog.js */
export const CAPABILITY_RUNTIME_MAP = {
  web_search: ['lykn_web_search'],
  web_scrape: ['lykn_web_fetch'],
  file_editor: ['lykn_manage_file'],
  file_creator: ['lykn_manage_file'],
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
  template_document: ['lykn_build_template'],
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
};

/** @type {{ id: string, label: string, hint: string, capabilities: ModelCapabilityDef[] }[]} */
export const MODEL_CAPABILITY_GROUPS = [
  {
    id: 'web',
    label: 'Web',
    hint: 'Search the open web and pull content from pages.',
    capabilities: [
      { id: 'web_search', label: 'Web search', implemented: true },
      { id: 'web_scrape', label: 'Web scrape & fetch', implemented: true },
    ],
  },
  {
    id: 'files',
    label: 'Files & documents',
    hint: 'Create, edit, convert, and parse documents.',
    capabilities: [
      { id: 'file_editor', label: 'File editor', implemented: true },
      { id: 'file_creator', label: 'File creator', implemented: true },
      { id: 'file_converter', label: 'File converter', implemented: true },
      { id: 'document_parse', label: 'Parse PDF & documents', implemented: true },
    ],
  },
  {
    id: 'code',
    label: 'Coding',
    hint: 'Write, debug, review, and refactor code.',
    capabilities: [
      { id: 'code_write', label: 'Code writing', implemented: true },
      { id: 'code_debug', label: 'Debugging', implemented: true },
      { id: 'code_review', label: 'Code review', implemented: true },
      { id: 'code_refactor', label: 'Refactoring', implemented: true },
    ],
  },
  {
    id: 'data',
    label: 'Data & math',
    hint: 'Analyze data, build charts, and work with numbers.',
    capabilities: [
      { id: 'data_analysis', label: 'Data analysis', implemented: true, risky: true },
      { id: 'data_visualization', label: 'Charts & graphs', implemented: true },
      { id: 'spreadsheet_tables', label: 'Spreadsheets & tables', implemented: true },
      { id: 'math_calculate', label: 'Math & calculations', implemented: true },
      { id: 'math_symbolic', label: 'Symbolic math', implemented: true },
      { id: 'math_units', label: 'Unit conversion', implemented: true },
    ],
  },
  {
    id: 'media',
    label: 'Images, audio & video',
    hint: 'Generate and process visual and audio content.',
    capabilities: [
      { id: 'ocr', label: 'OCR (text from images)', implemented: true },
      { id: 'image_generation', label: 'Image generation', implemented: true },
      { id: 'image_edit', label: 'Image editing', implemented: true },
      { id: 'image_analysis', label: 'Image analysis & vision', implemented: true },
      { id: 'transcription', label: 'Transcription (speech to text)', implemented: true },
      { id: 'audio_generation', label: 'Audio & speech generation', implemented: true },
    ],
  },
  {
    id: 'templates',
    label: 'Templates & builders',
    hint: 'Build reusable structures: decks, lessons, documents, forms, and more.',
    capabilities: [
      { id: 'template_slideshow', label: 'Slideshow & deck builder', implemented: true },
      { id: 'template_presentation', label: 'Presentations & pitch decks', implemented: true },
      { id: 'template_education', label: 'Lessons, courses & curricula', implemented: true },
      { id: 'template_worksheet', label: 'Worksheets, quizzes & assessments', implemented: true },
      { id: 'template_document', label: 'Document templates (reports, proposals, SOPs)', implemented: true },
      { id: 'template_email', label: 'Email & newsletter templates', implemented: true },
      { id: 'template_form', label: 'Forms, surveys & checklists', implemented: true },
      { id: 'template_social', label: 'Social & marketing content templates', implemented: true },
      { id: 'template_layout', label: 'Page & layout templates (web, print, landing pages)', implemented: true },
      { id: 'template_generic', label: 'Custom / general template builder', implemented: true },
    ],
  },
  {
    id: 'workspace',
    label: 'Projects & vault',
    hint: 'Search your vault and work with existing projects. Projects and beliefs are user-created in Synthesis Layer — models cannot create them.',
    capabilities: [
      { id: 'search_vault', label: 'Search vault', implemented: true },
      { id: 'project_list', label: 'List projects', implemented: true },
      { id: 'project_view', label: 'View project state', implemented: true },
      { id: 'project_update', label: 'Update project', implemented: true, risky: true },
      { id: 'project_push_state', label: 'Push project state', implemented: true, risky: true },
      { id: 'project_set_active', label: 'Set active project', implemented: true, risky: true },
      { id: 'project_merge', label: 'Merge projects', implemented: true, risky: true },
      { id: 'project_delete', label: 'Delete project', implemented: true, risky: true },
    ],
  },
  {
    id: 'other',
    label: 'Other',
    hint: 'Translation and external API calls.',
    capabilities: [
      { id: 'translation', label: 'Translation', implemented: true },
      { id: 'api_request', label: 'HTTP / API requests', implemented: true, risky: true },
    ],
  },
];

export const ALL_MODEL_CAPABILITY_IDS = MODEL_CAPABILITY_GROUPS.flatMap((g) =>
  g.capabilities.map((c) => c.id),
);

const CAPABILITY_ID_SET = new Set(ALL_MODEL_CAPABILITY_IDS);

/** Keep in sync with lib/modelBuilder/modelCapabilitiesCatalog.js */
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

/** @param {string} capabilityId */
export function isCapabilityImplemented(capabilityId) {
  return Boolean(CAPABILITY_RUNTIME_MAP[capabilityId]?.length);
}

/** Client-side inference when loading legacy models saved with runtime tool names only. */
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

/** @param {string[]} capabilities */
export function capabilitiesToRuntimeToolNames(capabilities) {
  const seen = new Set();
  const out = [];
  for (const cap of sanitizeModelCapabilities(capabilities)) {
    const tools = CAPABILITY_RUNTIME_MAP[cap];
    if (!tools) continue;
    for (const name of tools) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
