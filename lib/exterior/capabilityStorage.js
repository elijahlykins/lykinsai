import crypto from 'node:crypto';
import { GENERATED_IMAGE_BUCKET, GENERATED_IMAGE_SIGNED_TTL_SEC } from './constants.js';
import { buildFileProxyUrl } from './fileProxy.js';

/**
 * Wrap a storage object in a branded download URL served by this API server,
 * falling back to the raw Supabase signed URL if token signing isn't possible
 * (e.g. no secret configured). Keeps `https://<project>.supabase.co/...` out of
 * user-facing links.
 */
function brandedDownloadUrl(storagePath, filename, fallbackSignedUrl) {
  try {
    return buildFileProxyUrl({
      bucket: GENERATED_IMAGE_BUCKET,
      path: storagePath,
      filename,
      ttlSec: GENERATED_IMAGE_SIGNED_TTL_SEC,
    });
  } catch {
    return fallbackSignedUrl;
  }
}

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT = {
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  mp4: 'video/mp4',
  tsx: 'text/plain; charset=utf-8',
  jsx: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export function mimeTypeForFilename(filename) {
  const ext = String(filename || '').split('.').pop()?.toLowerCase() || 'txt';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function sanitizeFilename(name) {
  const base = String(name || 'artifact')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return base || 'artifact';
}

function assertUserPath(userId, storagePath) {
  const uid = String(userId || '').trim();
  const path = String(storagePath || '').trim();
  if (!uid || !path) return { ok: false, error: 'storage_path_required' };
  if (!path.startsWith(`${uid}/`)) return { ok: false, error: 'storage_path_forbidden' };
  return { ok: true, path };
}

/**
 * Persist a capability artifact to user-files and return a signed download URL.
 */
export async function persistCapabilityArtifact(supabaseAdmin, userId, opts = {}) {
  if (!supabaseAdmin || !userId) {
    return { ok: false, error: 'unauthenticated', persisted: false };
  }

  const buffer = opts.buffer instanceof Buffer ? opts.buffer : Buffer.from(opts.buffer || '');
  if (!buffer.length) return { ok: false, error: 'empty_buffer' };
  if (buffer.length > MAX_ARTIFACT_BYTES) {
    return { ok: false, error: 'artifact_too_large', max_bytes: MAX_ARTIFACT_BYTES };
  }

  const filename = sanitizeFilename(opts.filename || 'artifact.txt');
  const category = String(opts.category || 'capabilities').replace(/[^a-z0-9_-]/gi, '');
  const mimeType = opts.mimeType || mimeTypeForFilename(filename);
  const id = crypto.randomBytes(6).toString('hex');
  const storagePath = `${userId}/${category}/${Date.now()}-${id}-${filename}`;

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

  if (uploadErr) {
    return { ok: false, error: uploadErr.message || 'storage_upload_failed', persisted: false };
  }

  const { data, error: signErr } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .createSignedUrl(storagePath, GENERATED_IMAGE_SIGNED_TTL_SEC);

  if (signErr || !data?.signedUrl) {
    return {
      ok: false,
      error: signErr?.message || 'signed_url_failed',
      storage_path: storagePath,
      persisted: false,
    };
  }

  const fileUrl = brandedDownloadUrl(storagePath, filename, data.signedUrl);

  return {
    ok: true,
    persisted: true,
    storage_path: storagePath,
    file_url: fileUrl,
    filename,
    mime_type: mimeType,
    bytes: buffer.length,
    expires_in_sec: GENERATED_IMAGE_SIGNED_TTL_SEC,
    markdown: `[${filename}](${fileUrl})`,
  };
}

/** Load an artifact the user owns from storage. */
export async function loadCapabilityArtifact(supabaseAdmin, userId, storagePath) {
  const gate = assertUserPath(userId, storagePath);
  if (!gate.ok) return gate;

  const { data, error } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .download(gate.path);

  if (error || !data) {
    return { ok: false, error: error?.message || 'storage_download_failed' };
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  return { ok: true, buffer, bytes: buffer.length, storage_path: gate.path };
}

/** Attach persistence fields when upload succeeds; otherwise return result unchanged. */
export async function maybePersistTextArtifact(result, ctx, opts = {}) {
  if (!result?.ok || !ctx?.supabaseAdmin || !ctx?.userId) return result;
  if (opts.persist === false) return result;

  const content = opts.content ?? result.content ?? result.markdown ?? result.text;
  if (content == null) return result;

  const stored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
    buffer: Buffer.from(String(content), 'utf8'),
    filename: opts.filename || result.filename || 'output.txt',
    mimeType: opts.mimeType,
    category: opts.category || 'capabilities',
  });

  if (!stored.ok) {
    return { ...result, persistence_warning: stored.error, persisted: false };
  }

  return {
    ...result,
    ...stored,
    download_url: stored.file_url,
  };
}

export async function maybePersistBufferArtifact(result, ctx, opts = {}) {
  if (!result?.ok || !ctx?.supabaseAdmin || !ctx?.userId) return result;
  if (opts.persist === false) return result;
  if (!opts.buffer?.length) return result;

  const stored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
    buffer: opts.buffer,
    filename: opts.filename || result.filename || 'output.bin',
    mimeType: opts.mimeType,
    category: opts.category || 'capabilities',
  });

  if (!stored.ok) {
    return { ...result, persistence_warning: stored.error, persisted: false };
  }

  return { ...result, ...stored, download_url: stored.file_url };
}

export function capabilityCtx(ctx = {}) {
  return {
    userId: ctx.userId || ctx.user_id || null,
    supabaseAdmin: ctx.supabaseAdmin || ctx.supabase_admin || null,
    logUsage: ctx.logUsage || null,
    // Open side-panel artifact — surgical edit paths (edits / section_edits /
    // cell_edits / style-only reuse) read these instead of forcing a rebuild.
    activeArtifactCode: typeof ctx.activeArtifactCode === 'string' ? ctx.activeArtifactCode : null,
    activeArtifactContent:
      typeof ctx.activeArtifactContent === 'string' ? ctx.activeArtifactContent : null,
    activeArtifactSections: Array.isArray(ctx.activeArtifactSections)
      ? ctx.activeArtifactSections
      : null,
    activeArtifactHeaders: Array.isArray(ctx.activeArtifactHeaders)
      ? ctx.activeArtifactHeaders
      : null,
    activeArtifactRows: Array.isArray(ctx.activeArtifactRows) ? ctx.activeArtifactRows : null,
    activeArtifactTitle: typeof ctx.activeArtifactTitle === 'string' ? ctx.activeArtifactTitle : null,
    activeArtifactTheme: typeof ctx.activeArtifactTheme === 'string' ? ctx.activeArtifactTheme : null,
    activeArtifactFont: typeof ctx.activeArtifactFont === 'string' ? ctx.activeArtifactFont : null,
    // Progress callback for long server-side renders (lykn_render_video):
    // pings the SSE stall watchdog and drives client-visible percent updates.
    onRenderProgress: typeof ctx.onRenderProgress === 'function' ? ctx.onRenderProgress : null,
  };
}
