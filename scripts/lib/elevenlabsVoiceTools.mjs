// ============================================================================
// scripts/lib/elevenlabsVoiceTools.mjs — ElevenLabs client tools
// ============================================================================
// Derived from LYKN_VOICE_TOOL_DEFS so provision/update cannot drift from
// the Voice registry. Custom-model aliases stay retired.

import { LYKN_VOICE_TOOL_DEFS } from '../../mcp-tools/voiceTools.js';

const SLOW_TOOLS = new Set([
  'web_search',
  'web_fetch',
  'generate_image',
  'process_image',
  'generate_speech',
  'transcribe_audio',
  'parse_document',
  'translate',
  'build_react_artifact',
  'build_template',
  'render_video',
  'run_python',
  'run_code',
  'build_with_cursor',
  'check_cursor_build',
  'http_request',
]);

function timeoutFor(name) {
  if (name === 'build_react_artifact' || name === 'render_video') return 90;
  if (name === 'generate_image' || name === 'process_image') return 60;
  if (SLOW_TOOLS.has(name)) return 30;
  return 15;
}

export const LYKN_VOICE_CLIENT_TOOLS = LYKN_VOICE_TOOL_DEFS.map((t) => ({
  type: 'client',
  name: t.name,
  description: t.description,
  expects_response: true,
  response_timeout_secs: timeoutFor(t.name),
  parameters: t.parameters || { type: 'object', properties: {} },
}));
