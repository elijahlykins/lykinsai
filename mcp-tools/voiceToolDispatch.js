// ============================================================================
// mcp-tools/voiceToolDispatch.js — Voice runtime lookup + on-screen display
// ============================================================================
// Voice aliases map to Chat/MCP handlers. In-app-only tools (document writer,
// open app/settings, save file) are not in LYKN_TOOLS_BY_NAME. Generated
// media/docs attach a `display` payload the voice client intercepts.

import { LYKN_TOOLS_BY_NAME } from './index.js';
import { EXTERIOR_TOOLS_BY_NAME } from './exterior/index.js';
import { writeDocumentTool } from './writeDocument.js';
import { openAppTool } from './openApp.js';
import { openSettingsTool } from './openSettings.js';
import { saveFileToVaultTool } from './saveFileToVault.js';

const IN_APP_VOICE_TOOLS = Object.freeze({
  [writeDocumentTool.name]: writeDocumentTool,
  [openAppTool.name]: openAppTool,
  [openSettingsTool.name]: openSettingsTool,
  [saveFileToVaultTool.name]: saveFileToVaultTool,
});

export function lookupVoiceMcpTool(mcpName) {
  const name = String(mcpName || '');
  return LYKN_TOOLS_BY_NAME[name] || EXTERIOR_TOOLS_BY_NAME[name] || IN_APP_VOICE_TOOLS[name] || null;
}

function firstHttpUrl(...candidates) {
  for (const raw of candidates) {
    if (typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) return raw.trim();
  }
  return '';
}

/**
 * Attach a client `display` payload so generated work appears on screen the
 * way display_document does for vault items. Leaves the model-facing fields.
 */
export function attachVoiceDisplay(voiceName, result) {
  if (!result || typeof result !== 'object' || result.ok === false || result.display) return result;
  const name = String(voiceName || '');
  const title = String(result.title || result.filename || '').trim();

  if (name === 'generate_image' || name === 'process_image') {
    const url = firstHttpUrl(result.image_url, result.preview_url);
    if (!url) return result;
    return {
      ...result,
      display: { kind: 'url', url, title: title || 'Generated image', media: 'image' },
      message: result.message || 'The image is on your screen now.',
    };
  }
  if (name === 'generate_chart') {
    const url = firstHttpUrl(result.chart_url, result.preview_url, result.file_url);
    if (!url) return result;
    return {
      ...result,
      display: { kind: 'url', url, title: title || 'Chart', media: 'image' },
      message: result.message || 'The chart is on your screen now.',
    };
  }
  if (name === 'generate_diagram') {
    const url = firstHttpUrl(result.preview_url, result.file_url, result.image_url);
    if (!url) return result;
    return {
      ...result,
      display: { kind: 'url', url, title: title || 'Diagram', media: 'image' },
      message: result.message || 'The diagram is on your screen now.',
    };
  }
  if (name === 'write_document' || name === 'manage_file') {
    const url = firstHttpUrl(result.file_url, result.preview_url);
    if (!url && !result.preview_html) return result;
    return {
      ...result,
      display: url
        ? { kind: 'url', url, title: title || 'Document', media: 'file' }
        : { kind: 'html', html: result.preview_html, title: title || 'Document' },
      message: result.message || `Wrote "${title || 'the document'}". It's on your screen now.`,
    };
  }
  if (name === 'generate_speech') {
    const url = firstHttpUrl(result.file_url, result.audio_url);
    if (!url) return result;
    return {
      ...result,
      display: { kind: 'url', url, title: title || 'Audio', media: 'audio' },
      message: result.message || 'The audio is on your screen now.',
    };
  }
  if (name === 'render_video') {
    const url = firstHttpUrl(result.file_url, result.video_url, result.preview_url);
    if (!url) return result;
    return {
      ...result,
      display: { kind: 'url', url, title: title || 'Video', media: 'video' },
      message: result.message || 'The video is on your screen now.',
    };
  }
  if (
    name === 'build_react_artifact'
    || name === 'build_template'
    || name === 'build_spreadsheet'
  ) {
    const url = firstHttpUrl(result.preview_url, result.file_url, result.html_url);
    if (!url) return result;
    return {
      ...result,
      display: { kind: 'url', url, title: title || 'Build', media: 'file' },
      message: result.message || 'It is on your screen now.',
    };
  }
  return result;
}
