// ============================================================================
// lib/vaultAttachment.js — turn a file the model is holding into a durable,
// vault-renderable attachment.
// ============================================================================
// Shared by lykn_saveFileToVault (keep a generated artifact) and
// lykn_uploadToProject (save a dragged-in file + cluster it into a project).
//
// Three byte sources are supported, in order of durability:
//   • storage_path  → reference the path (the vault re-signs it forever) and
//     mint a fresh signed URL for an immediate render.
//   • http(s) URL   → download the bytes into our storage so they survive past
//     the source's expiry and render as a real card.
//   • data: URL     → decode the inline base64 and persist it. This is what
//     lets a JUST-dragged chat image (whose background upload to user-files
//     may not have landed yet) still be saved without losing the bytes.
//
// Returns null when nothing renderable could be built (callers fall back to a
// plain download link or a text-only note).

import { persistCapabilityArtifact, mimeTypeForFilename, assertUserPath } from './exterior/capabilityStorage.js';
import { GENERATED_IMAGE_BUCKET, GENERATED_IMAGE_SIGNED_TTL_SEC } from './exterior/constants.js';

// Caller-supplied bucket + service-role client below: allowlist it. Everything
// this module persists or re-signs lives in user-files, matching server.js's
// /api/storage/signed-url allowlist.
const SIGNED_URL_ALLOWED_BUCKETS = new Set([GENERATED_IMAGE_BUCKET]);

const ATTACHMENT_FETCH_TIMEOUT_MS = 15000;
const MAX_FETCH_BYTES = 25 * 1024 * 1024;
const FILENAME_MAX = 160;

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

// Map a file (by MIME, then filename/URL extension) onto the vault's
// attachment vocabulary. The vault's resolveAttachmentType returns any
// explicit non-"file" type verbatim, so getting this right is what makes an
// image render as an image card instead of a dead link.
export function inferAttachmentKind(mimeType, filename, url) {
  const m = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (m === 'text/html') return 'html';
  if (m.includes('spreadsheetml') || m === 'text/csv' || m === 'application/vnd.ms-excel') return 'spreadsheet';
  const src = String(filename || url || '').split('?')[0];
  const ext = (src.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic', 'heif', 'tiff'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma'].includes(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['html', 'htm'].includes(ext)) return 'html';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'spreadsheet';
  return 'file';
}

export function deriveFilename(filename, mimeType, url, title) {
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

// Parse a `data:<mime>;base64,<payload>` URL into { buffer, mimeType }.
// Returns null for anything that isn't a base64 data URL.
function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/is.exec(s);
  if (!m) return null;
  const mimeType = (m[1] || 'application/octet-stream').trim();
  const isBase64 = /;base64/i.test(m[2] || '');
  const payload = m[3] || '';
  try {
    const buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (!buffer.length) return null;
    return { buffer, mimeType };
  } catch {
    return null;
  }
}

/**
 * Build a durable, renderable vault attachment from a file the model is
 * holding. See module header for the byte-source priority.
 *
 * @param {object} ctx — { supabaseAdmin, userId }
 * @param {object} opts — { fileUrl?, dataUrl?, storagePath?, storageBucket?, filename?, mimeType?, title? }
 * @returns {Promise<object|null>} vault attachment ({ type, url, name, storagePath, storageBucket, mimeType, size? }) or null.
 */
export async function resolveVaultAttachment(ctx, opts = {}) {
  const { fileUrl, dataUrl, storagePath, storageBucket, filename, mimeType, title } = opts;

  // 1. Already in our storage — reference the path and re-sign for render.
  if (storagePath) {
    const bucket = storageBucket || GENERATED_IMAGE_BUCKET;
    // supabaseAdmin bypasses Storage RLS, so this check is the only boundary
    // between a caller-chosen key and a signed URL for it. Rejecting the whole
    // branch (not just skipping the mint) also keeps a foreign path from being
    // persisted into this user's attachment record.
    const gate = assertUserPath(ctx.userId, storagePath);
    if (!gate.ok || !SIGNED_URL_ALLOWED_BUCKETS.has(bucket)) return null;
    let url = fileUrl || '';
    try {
      const { data } = await ctx.supabaseAdmin.storage
        .from(bucket)
        .createSignedUrl(gate.path, GENERATED_IMAGE_SIGNED_TTL_SEC);
      if (data?.signedUrl) url = data.signedUrl;
    } catch { /* keep the provided fileUrl */ }
    const name = deriveFilename(filename, mimeType, gate.path || fileUrl, title);
    return {
      type: inferAttachmentKind(mimeType, name, gate.path || fileUrl),
      url,
      name,
      storagePath: gate.path,
      storageBucket: bucket,
      mimeType: mimeType || mimeTypeForFilename(name),
    };
  }

  // 2. Inline base64 data URL (e.g. a just-dragged chat image whose background
  //    upload hasn't landed) — decode and persist into our storage.
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
    const decoded = decodeDataUrl(dataUrl);
    if (decoded && decoded.buffer.length <= MAX_FETCH_BYTES) {
      const resolvedMime = mimeType || decoded.mimeType || 'application/octet-stream';
      const name = deriveFilename(filename, resolvedMime, '', title);
      const stored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
        buffer: decoded.buffer,
        filename: name,
        mimeType: resolvedMime,
        category: 'saved',
      });
      if (stored.ok) {
        return {
          type: inferAttachmentKind(stored.mime_type || resolvedMime, name, ''),
          url: stored.file_url,
          name,
          storagePath: stored.storage_path,
          storageBucket: GENERATED_IMAGE_BUCKET,
          mimeType: stored.mime_type || resolvedMime,
          size: stored.bytes,
        };
      }
    }
  }

  // 3. External http(s) URL — download the bytes so they outlive the source.
  if (/^https?:\/\//i.test(fileUrl || '')) {
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
