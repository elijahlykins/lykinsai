// ============================================================================
// mcp-tools/exterior/capabilityTools.js — Model Builder capability tools
// ============================================================================

import { manageFile } from '../../lib/exterior/capabilities/fileOps.js';
import { parseDocument } from '../../lib/exterior/capabilities/documentParse.js';
import { runCode } from '../../lib/exterior/capabilities/runCode.js';
import { buildSpreadsheet } from '../../lib/exterior/capabilities/spreadsheet.js';
import { runSymbolicMath } from '../../lib/exterior/capabilities/symbolicMath.js';
import { processImage } from '../../lib/exterior/capabilities/processImage.js';
import { transcribeAudio } from '../../lib/exterior/capabilities/transcribeAudio.js';
import { generateSpeech } from '../../lib/exterior/capabilities/generateAudio.js';
import { buildTemplate } from '../../lib/exterior/capabilities/buildTemplate.js';
import { translateText } from '../../lib/exterior/capabilities/translate.js';
import { httpRequest } from '../../lib/exterior/capabilities/httpRequest.js';
import { capabilityCtx } from '../../lib/exterior/capabilityStorage.js';
import { logAiUsage } from '../../usageTracking.js';
import { jsonContent, errorContent } from '../index.js';

function withCtx(fn) {
  return async (args = {}, ctx = {}) => {
    const c = capabilityCtx({ ...ctx, logUsage: (info) => logAiUsage(info) });
    const result = await fn(args, c);
    if (result?.ok === false && result.error) return errorContent(result.error);
    return jsonContent(result);
  };
}

export const manageFileTool = {
  name: 'lykn_manage_file',
  title: 'Create, edit, convert, or load files',
  scope: 'read',
  description: [
    'Create, edit, convert, or load user files. Supported formats: markdown, html, csv, json, plain text.',
    'Authenticated users get a persisted download URL (file_url). Use action=load with storage_path to read back.',
    'For interactive mini-apps and custom UIs: action=create with a .html filename and full self-contained HTML.',
    'The chat UI renders .html files inline as a live preview — prefer this over pasting HTML in markdown.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'edit', 'convert', 'load'] },
      filename: { type: 'string' },
      content: { type: 'string' },
      storage_path: { type: 'string', description: 'For load action — path from a prior file_url response.' },
      source_format: { type: 'string' },
      target_format: { type: 'string' },
      persist: { type: 'boolean', description: 'Default true when user is signed in.' },
    },
    required: ['action'],
    additionalProperties: false,
  },
  handler: withCtx(manageFile),
};

export const parseDocumentTool = {
  name: 'lykn_parse_document',
  title: 'Parse a document or web page',
  scope: 'read',
  description: [
    'Extract text from PDF, DOCX, XLSX, PPTX, CSV, ODT, plain text, or readable web pages.',
    'Pass a URL or base64-encoded file bytes plus filename when possible.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      base64: { type: 'string' },
      filename: { type: 'string' },
      mime_type: { type: 'string' },
      text: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler: withCtx(parseDocument),
};

export const runCodeTool = {
  name: 'lykn_run_code',
  title: 'Run code (Python or JavaScript)',
  scope: 'read',
  description: [
    'Execute Python or JavaScript for coding, debugging, review, and analysis.',
    'Python debug/review modes allow safe stdlib imports (math, json, statistics, etc.).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      language: { type: 'string', enum: ['python', 'javascript'] },
      mode: { type: 'string', enum: ['write', 'debug', 'review', 'refactor'] },
      profile: { type: 'string', enum: ['strict', 'analysis'] },
      code: { type: 'string' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  handler: withCtx(runCode),
};

export const buildSpreadsheetTool = {
  name: 'lykn_build_spreadsheet',
  title: 'Build spreadsheet tables',
  scope: 'read',
  description: [
    'Create markdown tables, CSV, or XLSX from headers and row data.',
    'Returns a download URL when the user is signed in. Include markdown_table or download link in your reply.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      headers: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array', items: { type: 'object' } },
      output_format: { type: 'string', enum: ['markdown', 'csv', 'xlsx'] },
    },
    required: ['rows'],
    additionalProperties: false,
  },
  handler: withCtx(buildSpreadsheet),
};

export const symbolicMathTool = {
  name: 'lykn_symbolic_math',
  title: 'Symbolic math',
  scope: 'read',
  description: [
    'Simplify, solve, integrate, differentiate, expand, or factor symbolic expressions.',
    'Uses SymPy when available; falls back to Gemini/OpenAI otherwise.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      expression: { type: 'string' },
      mode: {
        type: 'string',
        enum: ['simplify', 'solve', 'integrate', 'differentiate', 'expand', 'factor'],
      },
    },
    required: ['expression'],
    additionalProperties: false,
  },
  handler: withCtx(runSymbolicMath),
};

export const processImageTool = {
  name: 'lykn_process_image',
  title: 'OCR, analyze, or edit images',
  scope: 'read',
  description: [
    'OCR (including PDFs), vision analysis, or image editing.',
    'For edit, pass operation=edit plus a detailed prompt — returns a hosted image_url.',
    'For brand-new images from scratch use lykn_generate_image.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['ocr', 'analyze', 'edit'] },
      image_url: { type: 'string' },
      base64: { type: 'string' },
      mime_type: { type: 'string' },
      prompt: { type: 'string' },
      aspect_ratio: { type: 'string' },
      image_size: { type: 'string' },
    },
    required: ['operation'],
    additionalProperties: false,
  },
  handler: withCtx(processImage),
};

export const transcribeAudioTool = {
  name: 'lykn_transcribe_audio',
  title: 'Transcribe audio to text',
  scope: 'read',
  description: 'Transcribe speech from an audio URL or base64 payload using Whisper.',
  inputSchema: {
    type: 'object',
    properties: {
      audio_url: { type: 'string' },
      base64: { type: 'string' },
      language: { type: 'string' },
      prompt: { type: 'string' },
    },
    additionalProperties: false,
  },
  handler: withCtx(transcribeAudio),
};

export const generateSpeechTool = {
  name: 'lykn_generate_speech',
  title: 'Generate speech from text',
  scope: 'read',
  description: 'Convert text to speech. Returns a hosted download URL for the audio file.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      voice: { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] },
      format: { type: 'string', enum: ['mp3', 'opus', 'aac', 'flac'] },
    },
    required: ['text'],
    additionalProperties: false,
  },
  handler: withCtx(generateSpeech),
};

export const buildTemplateTool = {
  name: 'lykn_build_template',
  title: 'Build structured templates',
  scope: 'read',
  description: [
    'Build slideshows, lessons, worksheets, documents, emails, forms, social posts, or layouts.',
    'Exports markdown, JSON schema, HTML (presentable slideshow), and PPTX when signed in.',
    'The chat UI renders HTML artifacts inline — use this for pitch decks and slides.',
    'Pass export_formats: ["html","pptx"] for presentations. Summarise in prose after; no need to paste URLs.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      template_type: {
        type: 'string',
        enum: [
          'slideshow',
          'presentation',
          'education',
          'worksheet',
          'document',
          'email',
          'form',
          'social',
          'layout',
          'generic',
        ],
      },
      title: { type: 'string' },
      sections: { type: 'array', items: { type: 'object' } },
      metadata: { type: 'object' },
      content: { type: 'string' },
      export_formats: {
        type: 'array',
        items: { type: 'string', enum: ['markdown', 'json', 'html', 'pptx'] },
      },
    },
    required: ['template_type'],
    additionalProperties: false,
  },
  handler: withCtx(buildTemplate),
};

export const translateTool = {
  name: 'lykn_translate',
  title: 'Translate text',
  scope: 'read',
  description: 'Translate text to a target language. Returns the translation only.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      target_language: { type: 'string' },
      source_language: { type: 'string' },
    },
    required: ['text', 'target_language'],
    additionalProperties: false,
  },
  handler: withCtx(translateText),
};

export const httpRequestTool = {
  name: 'lykn_http_request',
  title: 'HTTP / API request',
  scope: 'read',
  description: [
    'Make a restricted HTTP request to a public API. Private/local URLs blocked. Rate limited.',
    'Do not send cookies or Authorization headers.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      url: { type: 'string' },
      headers: { type: 'object' },
      body: {},
    },
    required: ['url'],
    additionalProperties: false,
  },
  handler: withCtx(httpRequest),
};

export const CAPABILITY_TOOLS = [
  manageFileTool,
  parseDocumentTool,
  runCodeTool,
  buildSpreadsheetTool,
  symbolicMathTool,
  processImageTool,
  transcribeAudioTool,
  generateSpeechTool,
  buildTemplateTool,
  translateTool,
  httpRequestTool,
];

export const CAPABILITY_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(CAPABILITY_TOOLS.map((t) => [t.name, t])),
);
