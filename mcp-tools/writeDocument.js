// Write a basic keepable document (letter, notes, memo) as HTML.
// The desktop client saves the same file to Downloads and AI Drive so the
// user can open it in a browser, attach it, or upload it.

import { createRequire } from 'node:module';
import { jsonContent, errorContent } from './content.js';
import { persistCapabilityArtifact } from '../lib/exterior/capabilityStorage.js';

const require = createRequire(import.meta.url);
const { assembleDocument } = require('../lib/basicDocument.cjs');

const TITLE_MAX = 80;
const CONTENT_MAX = 200000;

export const writeDocumentTool = {
  name: 'lykn_write_document',
  title: 'Write a simple HTML document and save it',
  scope: 'write',
  description: [
    'Write something out as a simple HTML document and save it — a letter,',
    'memo, notes, write-up, one-pager, bio, or any keepable document the user',
    'will open, attach, upload, or send. The file lands in AI Drive / Docs and, on',
    'the desktop, in their Downloads folder.',
    '',
    'Use this when they asked for something written out as a file. Do not use',
    'it for a chat answer (just reply), a deep sourced research report',
    '(research tools), or an interactive app / page / game (build tools).',
    '',
    'Pass the finished document. `content` is markdown unless they asked for',
    'HTML. Do not ask where to save it.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: `Short title (<=${TITLE_MAX} chars). Used as the filename and the HTML <title>.`,
      },
      content: {
        type: 'string',
        description:
          `The document body (<=${CONTENT_MAX} chars). Markdown by default, or a full HTML document.`,
      },
      format: {
        type: 'string',
        enum: ['markdown', 'html'],
        description: 'Source format. Defaults to markdown unless content is already an HTML document.',
      },
    },
    required: ['content'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    const title = String(args.title || '').trim().slice(0, TITLE_MAX);
    const content = String(args.content || '').trim().slice(0, CONTENT_MAX);
    const format = String(args.format || '').toLowerCase() === 'html' ? 'html' : 'markdown';
    const doc = assembleDocument({ title, content, format });
    if (!doc.ok) {
      return errorContent('The document is empty. Pass the full text to write out.');
    }

    let stored = null;
    if (ctx.supabaseAdmin && ctx.userId) {
      stored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
        buffer: Buffer.from(doc.html, 'utf8'),
        filename: doc.filename,
        mimeType: 'text/html; charset=utf-8',
        category: 'documents',
      });
    }

    return jsonContent({
      ok: true,
      title: doc.title,
      filename: doc.filename,
      preview_html: doc.html,
      file_url: stored?.file_url || null,
      storage_path: stored?.storage_path || null,
      storage_bucket: stored?.ok ? 'user-files' : null,
      message: `Wrote "${doc.title}" as ${doc.filename}. It is saved to Downloads and AI Drive / Docs and opened in the LYKN browser so they can read it.`,
    });
  },
};
