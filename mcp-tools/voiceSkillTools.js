// ============================================================================
// mcp-tools/voiceSkillTools.js — Voice aliases for Chat skills Voice lacked
// ============================================================================
// Schema owner for the spoken surface of Chat-only families (documents,
// media, compute, artifacts, prefs, steward, shell, local). Existing Voice
// adapters stay in voiceTools.js. Names are live ElevenLabs / Realtime
// contracts once shipped.
//
// DISCLOSURE IS NOT AUTHORIZATION.

import { LOCAL_CHAT_TOOLS } from './localTools.js';

function skill(name, mcp, description, properties, required = []) {
  return {
    name,
    mcp,
    description,
    parameters: { type: 'object', properties, required },
  };
}

export const VOICE_CHAT_SKILL_DEFS = [
  skill(
    'get_current_time',
    'lykn_get_current_time',
    'Get the current date and time. Call when scheduling or they ask what time/day it is. Speak a natural local time, never raw ISO.',
    { timezone: { type: 'string', description: 'IANA timezone, e.g. America/Denver. Omit to use theirs.' } },
  ),
  skill(
    'calculate',
    'lykn_calculate',
    'Exact arithmetic instead of guessing. Expression like "(1200 * 0.075) + 450", or value + from_unit + to_unit to convert.',
    {
      expression: { type: 'string', description: 'Math expression to evaluate.' },
      value: { type: 'number', description: 'Numeric value when converting units.' },
      from_unit: { type: 'string', description: 'Source unit (km, mi, kg, lb, …).' },
      to_unit: { type: 'string', description: 'Target unit.' },
    },
  ),
  skill(
    'symbolic_math',
    'lykn_symbolic_math',
    'Simplify, solve, integrate, differentiate, expand, or factor a symbolic expression.',
    {
      expression: { type: 'string', description: 'The expression.' },
      mode: {
        type: 'string',
        enum: ['simplify', 'solve', 'integrate', 'differentiate', 'expand', 'factor'],
      },
    },
    ['expression'],
  ),
  skill(
    'run_python',
    'lykn_run_python',
    'Run a short Python snippet for analysis or transforms. No network or file I/O. Prefer calculate for simple arithmetic.',
    { code: { type: 'string', description: 'Python to run (<=6000 chars).' } },
    ['code'],
  ),
  skill(
    'run_code',
    'lykn_run_code',
    'Run a short code snippet (JS or Python) when they asked you to execute something.',
    {
      language: { type: 'string', description: 'javascript or python.' },
      code: { type: 'string', description: 'The snippet to run.' },
    },
    ['code'],
  ),
  skill(
    'http_request',
    'lykn_http_request',
    'Call a public HTTP API. Never send cookies or Authorization headers. Confirm destructive calls out loud first.',
    {
      method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE. Defaults to GET.' },
      url: { type: 'string', description: 'Full http(s) URL.' },
      query: { type: 'object' },
      body: { type: 'object' },
    },
    ['url'],
  ),
  skill(
    'get_preferences',
    'lykn_getUserPreferences',
    "Read the user's saved LYKN preferences (name, timezone, model, …).",
    {},
  ),
  skill(
    'update_preference',
    'lykn_updateUserPreference',
    'Update one saved preference after they clearly asked. Confirm what changed.',
    {
      key: { type: 'string', description: 'Preference key.' },
      value: { type: 'string', description: 'New value.' },
    },
    ['key', 'value'],
  ),
  skill(
    'list_steward_items',
    'lykn_listStewardItems',
    "List Night Shift / steward queue items when they ask what's queued overnight.",
    { status: { type: 'string', description: 'open, done, or all.' } },
  ),
  skill(
    'create_steward_item',
    'lykn_createStewardItem',
    'Add something to the overnight steward queue after they ask.',
    {
      title: { type: 'string' },
      body: { type: 'string' },
    },
    ['title'],
  ),
  skill(
    'update_steward_item',
    'lykn_updateStewardItem',
    'Complete, cancel, or edit a steward item. Get its id from list_steward_items first.',
    {
      id: { type: 'string' },
      status: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
    ['id'],
  ),
  skill(
    'write_document',
    'lykn_write_document',
    'Write a finished letter, memo, notes, bio, or simple document as a file. It lands in AI Drive / Docs and Downloads and opens on screen. Pass the finished body. Not for interactive apps or sourced research reports.',
    {
      title: { type: 'string', description: 'Short title used as the filename.' },
      content: { type: 'string', description: 'Finished document. Markdown unless they asked for HTML.' },
      format: { type: 'string', enum: ['markdown', 'html'] },
    },
    ['content'],
  ),
  skill(
    'save_file_to_vault',
    'lykn_saveFileToVault',
    'Keep a generated file (document, image, chart, artifact) in the vault after they ask to save it.',
    {
      title: { type: 'string' },
      content: { type: 'string', description: 'Optional text body when there is no file_url.' },
      file_url: { type: 'string' },
      filename: { type: 'string' },
    },
    ['title'],
  ),
  skill(
    'open_app',
    'lykn_open_app',
    'Open something INSIDE LYKN on their screen: To-dos, Calendar, Projects, Vault, AI Drive, Files, Browser, or an app they built. After calling, say what you opened. A real Mac app is local_open_app. Settings is open_settings.',
    {
      app: {
        type: 'string',
        description: 'Page id (todos, calendar, projects, vault, files, browser, drive, docs) or a built-app / AI Drive item name.',
      },
    },
    ['app'],
  ),
  skill(
    'open_settings',
    'lykn_open_settings',
    'Open LYKN Settings on the pane they asked about (wallpaper, plan, connected apps). Does not make the change. Tone/behavior changes use update_voice_instructions.',
    {
      section: {
        type: 'string',
        description:
          'account, workspace, assistant, notifications, localVault, installedApps, privacy, appearance, integrations, billing, keyboard, advanced.',
      },
    },
  ),
  skill(
    'generate_image',
    'lykn_generate_image',
    'Create an image from a spoken prompt. The picture appears on their screen. Call when they ask to generate / draw / make a picture. Describe the image; do not invent that it was created if the tool errors.',
    {
      prompt: { type: 'string', description: 'What to draw. With a reference, say only what should change.' },
      aspect_ratio: { type: 'string', description: 'Optional, e.g. 16:9 or 1:1.' },
    },
    ['prompt'],
  ),
  skill(
    'process_image',
    'lykn_process_image',
    'OCR, analyze, or edit an existing image. For a brand-new picture use generate_image.',
    {
      operation: { type: 'string', enum: ['ocr', 'analyze', 'edit'] },
      image_url: { type: 'string' },
      prompt: { type: 'string', description: 'Required for edit; optional for analyze.' },
    },
    ['operation'],
  ),
  skill(
    'generate_speech',
    'lykn_generate_speech',
    'Generate spoken audio from text and put the file on screen. Not your live voice in this call.',
    {
      text: { type: 'string' },
      voice: { type: 'string' },
    },
    ['text'],
  ),
  skill(
    'transcribe_audio',
    'lykn_transcribe_audio',
    'Transcribe an audio URL they shared. Read the transcript back; do not invent it.',
    { audio_url: { type: 'string' } },
    ['audio_url'],
  ),
  skill(
    'parse_document',
    'lykn_parse_document',
    'Extract text from a PDF or document URL they shared.',
    { file_url: { type: 'string' } },
    ['file_url'],
  ),
  skill(
    'translate',
    'lykn_translate',
    'Translate text they gave you. Speak the translation; do not dump a glossary.',
    {
      text: { type: 'string' },
      target_language: { type: 'string' },
      source_language: { type: 'string' },
    },
    ['text', 'target_language'],
  ),
  skill(
    'generate_chart',
    'lykn_generate_chart',
    'Build a bar/line/pie chart from labels + numbers. The chart appears on screen. Speak a short summary, not the raw data.',
    {
      chart_type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut', 'radar'] },
      title: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' } },
      datasets: { type: 'array', items: { type: 'object' } },
    },
    ['labels', 'datasets'],
  ),
  skill(
    'generate_diagram',
    'lykn_generate_diagram',
    'Build a flowchart or diagram from Mermaid source. It appears on screen.',
    {
      mermaid: { type: 'string' },
      title: { type: 'string' },
    },
    ['mermaid'],
  ),
  skill(
    'build_spreadsheet',
    'lykn_build_spreadsheet',
    'Build a spreadsheet / table and put it on screen. Pass headers + rows, or cell_edits for an open sheet.',
    {
      title: { type: 'string' },
      headers: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array', items: { type: 'object' } },
      output_format: { type: 'string', enum: ['markdown', 'csv', 'xlsx'] },
    },
  ),
  skill(
    'build_template',
    'lykn_build_template',
    'Build a slideshow, deck, or structured template. It opens on screen. Use write_document for a simple letter or memo.',
    {
      template_type: {
        type: 'string',
        enum: ['slideshow', 'presentation', 'education', 'worksheet', 'document', 'email', 'form', 'social', 'layout', 'generic'],
      },
      title: { type: 'string' },
      sections: { type: 'array', items: { type: 'object' } },
      content: { type: 'string' },
    },
    ['template_type'],
  ),
  skill(
    'build_react_artifact',
    'lykn_build_react_artifact',
    'Build an interactive app, page, dashboard, game, or prototype in React. It opens on their screen. Pass title plus code (one component) or files. Not for a simple letter (use write_document).',
    {
      title: { type: 'string' },
      code: { type: 'string', description: 'Single-file React component (export default).' },
      files: { type: 'array', items: { type: 'object' }, description: 'Multi-file project: [{path, content}].' },
    },
    ['title'],
  ),
  skill(
    'render_video',
    'lykn_render_video',
    'Render a real .mp4 from a Remotion composition they asked for. Tell them it is rendering; do not claim a link you did not get.',
    {
      title: { type: 'string' },
      code: { type: 'string', description: 'Remotion component (export default). Import only remotion and react.' },
      duration_in_frames: { type: 'integer' },
      fps: { type: 'integer' },
    },
    ['title', 'code'],
  ),
  skill(
    'manage_file',
    'lykn_manage_file',
    'Create, edit, convert, or load a text/HTML/CSV/JSON file. Prefer write_document for a simple keepable document.',
    {
      action: { type: 'string', enum: ['create', 'edit', 'convert', 'load'] },
      filename: { type: 'string' },
      content: { type: 'string' },
      storage_path: { type: 'string' },
    },
    ['action'],
  ),
];

const SKIP_LOCAL = new Set(['local_ask_bot', 'local_browser_agent']);

export const VOICE_LOCAL_SKILL_DEFS = LOCAL_CHAT_TOOLS
  .filter((t) => !SKIP_LOCAL.has(t.name))
  .map((t) => ({
    name: t.name,
    client: true,
    description: t.description,
    parameters: t.inputSchema || { type: 'object', properties: {} },
  }));

export const VOICE_SKILL_DEFS = Object.freeze([...VOICE_CHAT_SKILL_DEFS, ...VOICE_LOCAL_SKILL_DEFS]);

export const VOICE_SKILL_ALIAS_CLASS = Object.freeze({
  get_current_time: { class: 'CANONICAL_ALIAS', canonical: 'lykn_get_current_time', note: 'Voice-shaped schema over the Chat handler.' },
  calculate: { class: 'CANONICAL_ALIAS', canonical: 'lykn_calculate', note: 'Voice-shaped schema over the Chat handler.' },
  symbolic_math: { class: 'CANONICAL_ALIAS', canonical: 'lykn_symbolic_math', note: 'Voice-shaped schema over the Chat handler.' },
  run_python: { class: 'CANONICAL_ALIAS', canonical: 'lykn_run_python', note: 'Voice-shaped schema over the Chat handler.' },
  run_code: { class: 'CANONICAL_ALIAS', canonical: 'lykn_run_code', note: 'Voice-shaped schema over the Chat handler.' },
  http_request: { class: 'CANONICAL_ALIAS', canonical: 'lykn_http_request', note: 'Voice-shaped schema over the Chat handler.' },
  get_preferences: { class: 'CANONICAL_ALIAS', canonical: 'lykn_getUserPreferences', note: 'Voice-shaped schema over the Chat handler.' },
  update_preference: { class: 'CANONICAL_ALIAS', canonical: 'lykn_updateUserPreference', note: 'Voice-shaped schema over the Chat handler.' },
  list_steward_items: { class: 'CANONICAL_ALIAS', canonical: 'lykn_listStewardItems', note: 'Voice-shaped schema over the Chat handler.' },
  create_steward_item: { class: 'CANONICAL_ALIAS', canonical: 'lykn_createStewardItem', note: 'Voice-shaped schema over the Chat handler.' },
  update_steward_item: { class: 'CANONICAL_ALIAS', canonical: 'lykn_updateStewardItem', note: 'Voice-shaped schema over the Chat handler.' },
  write_document: { class: 'CANONICAL_ALIAS', canonical: 'lykn_write_document', note: 'Spoken document writer; opens on screen.' },
  save_file_to_vault: { class: 'CANONICAL_ALIAS', canonical: 'lykn_saveFileToVault', note: 'Voice-shaped schema over the Chat handler.' },
  open_app: { class: 'CANONICAL_ALIAS', canonical: 'lykn_open_app', note: 'Server settles target; client opens the window.' },
  open_settings: { class: 'CANONICAL_ALIAS', canonical: 'lykn_open_settings', note: 'Server settles pane; client opens Settings.' },
  generate_image: { class: 'CANONICAL_ALIAS', canonical: 'lykn_generate_image', note: 'Spoken Imagine; result opens on screen.' },
  process_image: { class: 'CANONICAL_ALIAS', canonical: 'lykn_process_image', note: 'Voice-shaped schema over the Chat handler.' },
  generate_speech: { class: 'CANONICAL_ALIAS', canonical: 'lykn_generate_speech', note: 'Voice-shaped schema over the Chat handler.' },
  transcribe_audio: { class: 'CANONICAL_ALIAS', canonical: 'lykn_transcribe_audio', note: 'Voice-shaped schema over the Chat handler.' },
  parse_document: { class: 'CANONICAL_ALIAS', canonical: 'lykn_parse_document', note: 'Voice-shaped schema over the Chat handler.' },
  translate: { class: 'CANONICAL_ALIAS', canonical: 'lykn_translate', note: 'Voice-shaped schema over the Chat handler.' },
  generate_chart: { class: 'CANONICAL_ALIAS', canonical: 'lykn_generate_chart', note: 'Voice-shaped schema over the Chat handler.' },
  generate_diagram: { class: 'CANONICAL_ALIAS', canonical: 'lykn_generate_diagram', note: 'Voice-shaped schema over the Chat handler.' },
  build_spreadsheet: { class: 'CANONICAL_ALIAS', canonical: 'lykn_build_spreadsheet', note: 'Voice-shaped schema over the Chat handler.' },
  build_template: { class: 'CANONICAL_ALIAS', canonical: 'lykn_build_template', note: 'Voice-shaped schema over the Chat handler.' },
  build_react_artifact: { class: 'CANONICAL_ALIAS', canonical: 'lykn_build_react_artifact', note: 'Spoken Create; result opens on screen.' },
  render_video: { class: 'CANONICAL_ALIAS', canonical: 'lykn_render_video', note: 'Voice-shaped schema over the Chat handler.' },
  manage_file: { class: 'CANONICAL_ALIAS', canonical: 'lykn_manage_file', note: 'Voice-shaped schema over the Chat handler.' },
  local_list_dir: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_list_dir', note: 'Client-only Local Mode; same name as Chat.' },
  local_read_file: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_read_file', note: 'Client-only Local Mode; same name as Chat.' },
  local_search_files: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_search_files', note: 'Client-only Local Mode; same name as Chat.' },
  local_pull_file: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_pull_file', note: 'Client-only Local Mode; same name as Chat.' },
  local_write_file: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_write_file', note: 'Client-only Local Mode; same name as Chat.' },
  local_edit_file: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_edit_file', note: 'Client-only Local Mode; same name as Chat.' },
  local_run_command: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_run_command', note: 'Client-only Local Mode; same name as Chat.' },
  local_synced_folders: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_synced_folders', note: 'Client-only Local Mode; same name as Chat.' },
  local_running_apps: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_running_apps', note: 'Client-only Local Mode; same name as Chat.' },
  local_read_app: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_read_app', note: 'Client-only Local Mode; same name as Chat.' },
  local_open_app: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_open_app', note: 'Client-only Local Mode; same name as Chat.' },
  local_open_path: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_open_path', note: 'Client-only Local Mode; same name as Chat.' },
  local_organize_desktop: { class: 'REQUIRED_VOICE_ADAPTER', canonical: 'local_organize_desktop', note: 'Client-only Local Mode; same name as Chat.' },
});
