// ============================================================================
// mcp-tools/saveFileToVault.js — keep an AI-generated artifact in the Vault.
// ============================================================================
// The capability tools (lykn_build_template, lykn_build_spreadsheet,
// lykn_generate_image, lykn_generate_speech, lykn_manage_file) and sub-agent
// reports PRODUCE content — a marketing plan, a deck, a spreadsheet — but that
// output otherwise evaporates at the end of the chat: a generated file lands in
// the capability-storage bucket as a short-lived signed link, and a sub-agent's
// text report is just relayed and forgotten. There was no way for the model to
// turn "I just made this" into durable, searchable Vault memory.
//
// This tool closes that gap. It is the "keep this" verb the model reaches for
// AFTER it has generated something worth retaining:
//   • The TEXT/markdown body becomes the durable, searchable Vault item
//     (same `notes` table, same /vault surface, same lykn_searchVault).
//   • An optional generated FILE is recorded two ways: a visible markdown
//     download link in the body, AND a structured, durable reference in
//     ai_signals.generated_file (storage_path + bucket) so a later pass can
//     promote it into a first-class Vault attachment without losing the file.
//   • The optional "why" lands as the first comment on the note (the user's
//     "your why" on a Vault item).
//
// v1 deliberately stores text + a download link rather than copying the file
// bytes into the user-files bucket — that full attachment/embedding path is the
// Vault data-model work tracked separately. The durable storage reference kept
// here is what lets that later work upgrade these notes in place.
//
// Self-contained: inserts straight into `notes` via ctx.supabaseAdmin +
// ctx.userId, so it behaves identically wherever the chat agent loop runs it.

import { jsonContent, errorContent, requireWrite } from './index.js';
import { persistCapabilityArtifact, mimeTypeForFilename } from '../lib/exterior/capabilityStorage.js';
import { GENERATED_IMAGE_BUCKET, GENERATED_IMAGE_SIGNED_TTL_SEC } from '../lib/exterior/constants.js';

const TITLE_MAX = 200;
const CONTENT_MAX = 60000;
const WHY_MAX = 2000;
const FOLDER_MAX = 80;
const TAG_MAX_LEN = 32;
const TAG_MAX_COUNT = 12;
const FILENAME_MAX = 160;
const ATTACHMENT_FETCH_TIMEOUT_MS = 15000;
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'text/html': 'html',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

// Map a generated file (by MIME, then filename/URL extension) onto the vault's
// attachment vocabulary. The vault's resolveAttachmentType returns any explicit
// non-"file" type verbatim, so getting this right is what makes a chart render
// as an image card instead of a dead link.
function inferAttachmentKind(mimeType, filename, url) {
  const m = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m.includes('spreadsheetml') || m === 'text/csv' || m === 'application/vnd.ms-excel') return 'spreadsheet';
  const src = String(filename || url || '').split('?')[0];
  const ext = (src.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'tiff'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'spreadsheet';
  return 'file';
}

function deriveFilename(filename, mimeType, url, title) {
  const clean = String(filename || '').trim();
  if (clean) return clean.slice(0, FILENAME_MAX);
  try {
    const base = (new URL(String(url)).pathname.split('/').pop() || '').trim();
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return decodeURIComponent(base).slice(0, FILENAME_MAX);
  } catch { /* not a parseable URL — fall through */ }
  const ext = EXT_BY_MIME[String(mimeType || '').toLowerCase().split(';')[0].trim()] || 'bin';
  const base =
    String(title || 'artifact')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'artifact';
  return `${base}.${ext}`;
}

// Turn the file the model handed us into a durable, vault-renderable attachment.
//   • Already in our storage (storage_path) → reference the path (the vault
//     re-signs it forever) and mint a fresh signed URL for immediate render.
//   • External URL (QuickChart PNG, a hosted image/file) → download the bytes
//     into user-files so it survives past the source's expiry and renders as a
//     real card instead of a fragile link to quickchart.io et al.
// Returns null when nothing renderable could be built (caller falls back to a
// visible download link so the artifact is still reachable).
async function resolveVaultAttachment(ctx, { fileUrl, storagePath, storageBucket, filename, mimeType, title }) {
  if (storagePath) {
    const bucket = storageBucket || GENERATED_IMAGE_BUCKET;
    let url = fileUrl || '';
    try {
      const { data } = await ctx.supabaseAdmin.storage
        .from(bucket)
        .createSignedUrl(storagePath, GENERATED_IMAGE_SIGNED_TTL_SEC);
      if (data?.signedUrl) url = data.signedUrl;
    } catch { /* keep the provided fileUrl */ }
    const name = deriveFilename(filename, mimeType, storagePath || fileUrl, title);
    return {
      type: inferAttachmentKind(mimeType, name, storagePath || fileUrl),
      url,
      name,
      storagePath,
      storageBucket: bucket,
      mimeType: mimeType || mimeTypeForFilename(name),
    };
  }

  if (/^https?:\/\//i.test(fileUrl)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(fileUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return null;
      const ct = (res.headers.get('content-type') || '').split(';')[0].trim();
      const declaredLen = Number(res.headers.get('content-length') || 0);
      if (declaredLen && declaredLen > MAX_FETCH_BYTES) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > MAX_FETCH_BYTES) return null;
      const resolvedMime = mimeType || ct || 'application/octet-stream';
      const name = deriveFilename(filename, resolvedMime, fileUrl, title);
      const stored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
        buffer: buf,
        filename: name,
        mimeType: resolvedMime,
        category: 'saved',
      });
      if (!stored.ok) return null;
      return {
        type: inferAttachmentKind(stored.mime_type || resolvedMime, name, fileUrl),
        url: stored.file_url,
        name,
        storagePath: stored.storage_path,
        storageBucket: GENERATED_IMAGE_BUCKET,
        mimeType: stored.mime_type || resolvedMime,
        size: stored.bytes,
      };
    } catch {
      return null;
    }
  }

  return null;
}

function cleanTags(raw) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(raw) ? raw : []) {
    if (out.length >= TAG_MAX_COUNT) break;
    if (typeof t !== 'string') continue;
    const tag = t.trim().slice(0, TAG_MAX_LEN);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export const saveFileToVaultTool = {
  name: 'lykn_saveFileToVault',
  title: 'Save a generated artifact (and any file) to the user\'s vault',
  scope: 'write',
  description: [
    'Save something YOU just generated — a document, marketing plan, deck,',
    'spreadsheet, summary, or a sub-agent\'s report — into the user\'s LYKN',
    'vault so it survives past this chat and is searchable in /vault and via',
    'lykn_searchVault.',
    '',
    'This is the "keep this" step AFTER a capability tool',
    '(lykn_generate_chart / lykn_generate_image / lykn_process_image /',
    'lykn_build_template / lykn_build_spreadsheet / lykn_generate_speech /',
    'lykn_manage_file) or a sub-agent (lykn_communicate_with_model) produced',
    'output:',
    '  1. Generate the artifact.',
    '  2. Pass its TEXT/markdown as `content` (this is what gets searched).',
    '  3. If it produced a FILE or a visual (chart, image, deck, spreadsheet,',
    '     audio), pass its URL as `file_url` — use chart_url for charts,',
    '     image_url for images, file_url/download_url for files — and, when you',
    '     have them, `storage_path` + `storage_bucket` + `filename` + `mime_type`.',
    '     The file is downloaded into the vault and saved as a real, viewable',
    '     card (the chart/image renders inline; files get a download card), NOT',
    '     a fragile external link. ALWAYS pass file_url for charts/images so the',
    '     user sees the visual in their vault, never a broken quickchart.io link.',
    '',
    'CONSENT — ASK FIRST. The vault is the user\'s personal memory; writing to',
    'it unasked is hostile. Before calling, ask once: "Want me to save this to',
    'your vault?" The user\'s yes is the gate. Do not call without it (unless',
    'the user already told you to save outputs automatically).',
    '',
    'GOOD HYGIENE (so the vault stays organised): give a clear `title` (lead',
    'with what it is; include a date for time-bound docs like plans), add a',
    'few `tags` (campaign/audience/type), set a `folder` when it belongs to a',
    'collection, and capture the user\'s `why` when they tell you why it',
    'matters.',
    '',
    'When NOT to call: casual one-off replies, anything marked private /',
    'off-the-record, personal principles (those are user-authored Core Belief',
    'neurons), or atomic identity facts (use lykn_proposeFact).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short human-readable title (<=200 chars). Strongly preferred — lead with what the artifact is; add a date for time-bound docs.',
      },
      content: {
        type: 'string',
        description: 'The artifact body as text/markdown (<=60,000 chars). This is the durable, searchable Vault item. Do NOT paste base64 file blobs here.',
      },
      why: {
        type: 'string',
        description: 'Optional — the user\'s "why" / why this matters. Saved as the first comment on the vault item.',
      },
      file_url: {
        type: 'string',
        description: 'Optional URL of the generated file/visual — chart_url for charts, image_url for images, file_url/download_url for documents. The bytes are downloaded into the vault and saved as a viewable card, so ALWAYS pass this for charts and images.',
      },
      storage_path: {
        type: 'string',
        description: 'Optional durable storage path of the generated file (from a capability tool\'s storage_path) so the file reference outlives the signed URL.',
      },
      storage_bucket: {
        type: 'string',
        description: 'Optional storage bucket the file lives in (pairs with storage_path).',
      },
      filename: {
        type: 'string',
        description: 'Optional original filename of the generated file (used as the link label).',
      },
      mime_type: {
        type: 'string',
        description: 'Optional MIME type of the generated file.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags (each <=32 chars, max 12). Prefer campaign/audience/type tags. Reuse the user\'s existing tags when known.',
      },
      folder: {
        type: 'string',
        description: 'Optional folder / collection name (<=80 chars).',
      },
    },
    required: ['content'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    let content = String(args?.content || '').trim();
    if (!content) return errorContent('content is required and must be non-empty.');
    if (content.length > CONTENT_MAX) {
      return errorContent(`content exceeds ${CONTENT_MAX} chars. Trim before saving.`);
    }
    if (/data:[a-z/+.-]+;base64,/i.test(content) && content.length > 8000) {
      return errorContent('content looks like an inlined base64 file blob. Pass the file via file_url / storage_path instead.');
    }

    const title = typeof args?.title === 'string' ? args.title.trim().slice(0, TITLE_MAX) || null : null;
    const folder = typeof args?.folder === 'string' ? args.folder.trim().slice(0, FOLDER_MAX) || null : null;
    const why = typeof args?.why === 'string' ? args.why.trim().slice(0, WHY_MAX) : '';
    const tags = cleanTags(args?.tags);

    const fileUrl = typeof args?.file_url === 'string' ? args.file_url.trim() : '';
    const storagePath = typeof args?.storage_path === 'string' ? args.storage_path.trim() : '';
    const storageBucket = typeof args?.storage_bucket === 'string' ? args.storage_bucket.trim() : '';
    const filename = typeof args?.filename === 'string' ? args.filename.trim().slice(0, FILENAME_MAX) : '';
    const mimeType = typeof args?.mime_type === 'string' ? args.mime_type.trim().slice(0, 120) : '';
    const hasFile = Boolean(fileUrl || storagePath);

    // Build a durable, renderable vault attachment from the generated file:
    // download external URLs (e.g. QuickChart PNGs) into our storage, and
    // reference already-stored artifacts by path so the vault re-signs them.
    // This is what makes a chart/image/deck land as a real card instead of a
    // bare text note pointing at quickchart.io or an expiring signed link.
    const attachment = hasFile
      ? await resolveVaultAttachment(ctx, {
          fileUrl,
          storagePath,
          storageBucket,
          filename,
          mimeType,
          title,
        })
      : null;

    if (attachment) {
      // The vault renders any note containing this marker as a rich card,
      // dispatched on attachment.type (image → image, pdf → pdf viewer, etc.).
      const marker = `\n\n[ATTACHMENTS_JSON:${JSON.stringify([attachment])}]`;
      if (content.length + marker.length > CONTENT_MAX) {
        content = content.slice(0, CONTENT_MAX - marker.length).trimEnd();
      }
      content += marker;
    } else if (fileUrl) {
      // Couldn't persist a renderable attachment (fetch blocked, oversized,
      // storage down) — fall back to a visible download link so the artifact
      // is at least reachable rather than silently lost.
      const label = filename || 'Download generated file';
      const footer = `\n\n— **Generated file:** [${label}](${fileUrl})`;
      if (content.length + footer.length <= CONTENT_MAX) content += footer;
    }

    // Durable structured reference (mirrors the attachment when we built one)
    // so a later pass can re-promote the file without re-generating it.
    const generatedFile = hasFile
      ? {
          file_url: (attachment && attachment.url) || fileUrl || null,
          storage_path: (attachment && attachment.storagePath) || storagePath || null,
          storage_bucket: (attachment && attachment.storageBucket) || storageBucket || null,
          filename: (attachment && attachment.name) || filename || null,
          mime_type: (attachment && attachment.mimeType) || mimeType || null,
          attachment_type: attachment ? attachment.type : null,
          saved_at: new Date().toISOString(),
        }
      : null;

    const source = `lykn-chat-agent:${ctx.attribSurface || 'lykn-chat'}`.slice(0, 64);

    const comments = why
      ? [{
          id: `c_${Date.now().toString(36)}`,
          text: why,
          created_at: new Date().toISOString(),
        }]
      : null;

    const richRow = {
      user_id: ctx.userId,
      title,
      content,
      tags: tags.length ? tags : null,
      folder,
      source,
      ...(generatedFile ? { ai_signals: { generated_file: generatedFile } } : {}),
      ...(comments ? { comments } : {}),
    };

    const selectCols = 'id, title, content, tags, folder, created_at, updated_at';
    let { data, error } = await ctx.supabaseAdmin
      .from('notes')
      .insert(richRow)
      .select(selectCols)
      .single();

    // The capability columns (ai_signals / comments) ship via later migrations;
    // if this DB predates them, retry with the always-present columns so the
    // text artifact still lands (mirrors the vault upload pipeline's fallback).
    const missingColumn =
      error &&
      (error.code === 'PGRST204' ||
        /could not find/i.test(error.message || '') ||
        /does not exist/i.test(error.message || ''));
    if (missingColumn) {
      ({ data, error } = await ctx.supabaseAdmin
        .from('notes')
        .insert({
          user_id: ctx.userId,
          title,
          content,
          tags: tags.length ? tags : null,
          folder,
          source,
        })
        .select(selectCols)
        .single());
    }

    if (error) {
      console.warn('[mcp:saveFileToVault]', error.message);
      return errorContent(`vault save failed: ${error.message}`);
    }

    return jsonContent({
      ok: true,
      message: title ? `Saved "${title}" to your vault.` : 'Saved to your vault.',
      note: {
        id: data.id,
        title: data.title,
        node_id: `vault_${data.id}`,
        tags: data.tags || [],
        folder: data.folder,
        created_at: data.created_at,
        url: `/vault?note=${encodeURIComponent(data.id)}`,
        has_file: hasFile,
        // True when the file was saved as a renderable vault card (image, pdf,
        // file, …); false means it fell back to a plain download link.
        rendered_as_attachment: Boolean(attachment),
        attachment_type: attachment ? attachment.type : null,
      },
    });
  },
};
