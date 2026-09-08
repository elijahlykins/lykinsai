import crypto from 'node:crypto';
import { GENERATED_IMAGE_BUCKET, EPHEMERAL_SIGNED_TTL_SEC } from './constants.js';
import { buildFileProxyUrl } from './fileProxy.js';
import { withReservedUsage } from '../billing/usageBalance.js';

/**
 * 3D model generation — provider-agnostic (Tripo primary, Meshy fallback).
 *
 * Why this exists: procedural scripting (Blender bpy, three.js) cannot sculpt
 * organic curvature — "model a Porsche" fails at the geometry level no matter
 * how disciplined the agent is. Image/text-to-3D diffusion models solve
 * exactly that step: they return a textured GLB mesh which the agent then
 * refines (materials, exact scale) with the tools it already has.
 *
 * Provider notes:
 *   - Tripo v3: text-to-model AND image-to-model. Async: POST returns a
 *     task_id, poll GET /v3/tasks/{id} until success. Output URLs expire in
 *     ~5 minutes, so the GLB is downloaded and re-hosted immediately — but
 *     only as EPHEMERAL transit (24h, then swept): the deliverable lands on
 *     the user's machine via download/curl, never as long-term cloud storage.
 *   - Meshy v1: image-to-3d only (its text mode needs a two-stage
 *     preview→refine chain we don't carry). Used when only MESHY_API_KEY is
 *     configured and the request has an image reference.
 *
 * Both adapters take injected fetch/sleep so the full submit→poll→download→
 * persist flow is unit-testable without live keys.
 */

const MAX_PROMPT_LEN = 2000;
const MAX_MODEL_BYTES = 200 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_WAIT_MS = 6 * 60 * 1000;

const TRIPO_BASE = 'https://openapi.tripo3d.ai/v3';
const MESHY_BASE = 'https://api.meshy.ai/openapi/v1';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tripoGenerate({ apiKey, prompt, imageUrl, fetchImpl, sleep, maxWaitMs, pollIntervalMs }) {
  const endpoint = imageUrl ? 'image-to-model' : 'text-to-model';
  const body = imageUrl
    ? { input: imageUrl, texture: true, pbr: true }
    : { prompt, texture: true, pbr: true };
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const submit = await fetchImpl(`${TRIPO_BASE}/generation/${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const submitted = await submit.json().catch(() => ({}));
  const taskId = submitted?.data?.task_id;
  if (!submit.ok || !taskId) {
    return {
      ok: false,
      error: submitted?.message || submitted?.error?.message || `tripo_http_${submit.status}`,
      retryable: submit.status === 429 || submit.status >= 500,
    };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(pollIntervalMs);
    const poll = await fetchImpl(`${TRIPO_BASE}/tasks/${taskId}`, { headers });
    const pj = await poll.json().catch(() => ({}));
    const status = pj?.data?.status;
    if (status === 'success') {
      const out = pj.data.output || {};
      const glbUrl = out.pbr_model || out.model_url || out.model;
      if (!glbUrl) return { ok: false, error: 'tripo_no_model_url', retryable: false };
      return {
        ok: true,
        provider: 'tripo',
        model: pj.data.type || 'tripo-v3',
        glbUrl,
        previewUrl: out.rendered_image_url || out.rendered_image || null,
      };
    }
    if (status === 'failed' || status === 'cancelled') {
      return { ok: false, error: `tripo_task_${status}`, retryable: false };
    }
    // queued / running → keep polling.
  }
  return { ok: false, error: 'tripo_timeout', retryable: false };
}

async function meshyGenerate({ apiKey, imageUrl, fetchImpl, sleep, maxWaitMs, pollIntervalMs }) {
  if (!imageUrl) {
    // Meshy text mode is a two-stage preview→refine chain — not carried here.
    return { ok: false, error: 'meshy_needs_image_reference', retryable: false };
  }
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const submit = await fetchImpl(`${MESHY_BASE}/image-to-3d`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ image_url: imageUrl, enable_pbr: true, should_texture: true }),
  });
  const submitted = await submit.json().catch(() => ({}));
  const taskId = submitted?.result;
  if (!submit.ok || !taskId) {
    return {
      ok: false,
      error: submitted?.message || `meshy_http_${submit.status}`,
      retryable: submit.status === 429 || submit.status >= 500,
    };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(pollIntervalMs);
    const poll = await fetchImpl(`${MESHY_BASE}/image-to-3d/${taskId}`, { headers });
    const pj = await poll.json().catch(() => ({}));
    if (pj?.status === 'SUCCEEDED') {
      const glbUrl = pj.model_urls?.glb;
      if (!glbUrl) return { ok: false, error: 'meshy_no_model_url', retryable: false };
      return {
        ok: true,
        provider: 'meshy',
        model: 'meshy-image-to-3d',
        glbUrl,
        previewUrl: pj.thumbnail_url || null,
      };
    }
    if (pj?.status === 'FAILED' || pj?.status === 'CANCELED') {
      return {
        ok: false,
        error: pj?.task_error?.message || `meshy_task_${String(pj.status).toLowerCase()}`,
        retryable: false,
      };
    }
  }
  return { ok: false, error: 'meshy_timeout', retryable: false };
}

/** Providers in preference order, keyed by which API keys are configured. */
export function pick3dProviders(env = process.env) {
  const chain = [];
  if (env.TRIPO_API_KEY) chain.push({ id: 'tripo', apiKey: env.TRIPO_API_KEY });
  if (env.MESHY_API_KEY) chain.push({ id: 'meshy', apiKey: env.MESHY_API_KEY });
  return chain;
}

// Cloud storage is TRANSIT for 3D deliverables, not a home: the GLB belongs on
// the user's machine (downloaded from chat, or curled into a build-workspace
// project the same turn). Objects land under `<userId>/ephemeral/` with a
// 24h signed URL, and the vault reconciler's ephemeral sweep deletes them by
// age — so 3D generations add no long-term storage cost.
async function persistGeneratedAsset(supabaseAdmin, userId, { buffer, ext, contentType, filename }) {
  const id = crypto.randomBytes(8).toString('hex');
  const storagePath = `${userId}/ephemeral/${Date.now()}-${id}.${ext}`;
  const { error: uploadErr } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .upload(storagePath, buffer, { contentType, upsert: false });
  if (uploadErr) return { ok: false, error: uploadErr.message || 'storage_upload_failed' };

  const { data, error: signErr } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .createSignedUrl(storagePath, EPHEMERAL_SIGNED_TTL_SEC);
  if (signErr || !data?.signedUrl) {
    return { ok: false, error: signErr?.message || 'signed_url_failed', storage_path: storagePath };
  }

  let url = data.signedUrl;
  try {
    url = buildFileProxyUrl({
      bucket: GENERATED_IMAGE_BUCKET,
      path: storagePath,
      filename,
      ttlSec: EPHEMERAL_SIGNED_TTL_SEC,
    });
  } catch {
    // No proxy secret configured — raw signed URL still works.
  }
  return { ok: true, url, storage_path: storagePath, bytes: buffer.length };
}

/**
 * Generate a 3D model (GLB) from a text prompt and/or a reference image URL,
 * meter the Usage Balance, and stage the result in ephemeral storage (24h,
 * then swept). Returns a temporary model_url (file proxy) plus a
 * preview_image_url when the provider rendered one — the deliverable is
 * expected to be downloaded to the user's machine within that window.
 */
export async function generate3dModel({
  prompt,
  imageUrl,
  userId,
  supabaseAdmin,
  logUsage,
  authorizeUsage,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  env = process.env,
}) {
  const text = String(prompt || '').trim();
  const image = String(imageUrl || '').trim();
  if (!text && !image) return { ok: false, error: 'prompt or image_url is required' };
  if (text.length > MAX_PROMPT_LEN) return { ok: false, error: 'prompt_too_long' };
  if (image && !/^https?:\/\//i.test(image)) {
    return { ok: false, error: 'image_url must be an http(s) URL the provider can fetch' };
  }

  const providers = pick3dProviders(env);
  if (providers.length === 0) return { ok: false, error: 'model3d_generation_not_configured' };
  if (!supabaseAdmin || !userId) return { ok: false, error: 'unauthenticated' };

  let reservation = null;
  if (typeof authorizeUsage === 'function') {
    const auth = await authorizeUsage({ actionType: 'model3d_gen' });
    if (!auth?.ok) {
      return {
        ok: false,
        error: auth?.error || 'insufficient_usage_balance',
        message: auth?.message || 'Add funds to continue with this action.',
        add_funds: true,
        hint: 'The user needs to add funds to their Usage Balance before this 3D model can be generated.',
      };
    }
    reservation = auth.reservation || null;
  }

  return withReservedUsage(reservation, async ({ settle }) => {
    let lastErr = 'model3d_generation_failed';
    let gen = null;
    for (const provider of providers) {
      const args = {
        apiKey: provider.apiKey,
        prompt: text,
        imageUrl: image || null,
        fetchImpl,
        sleep: sleepImpl,
        maxWaitMs,
        pollIntervalMs,
      };
      const attempt = provider.id === 'tripo' ? await tripoGenerate(args) : await meshyGenerate(args);
      if (attempt.ok) {
        gen = attempt;
        break;
      }
      lastErr = attempt.error || lastErr;
      console.warn(`[3d-gen] ${provider.id} failed (${lastErr})`);
    }
    if (!gen) {
      return {
        ok: false,
        error: lastErr,
        hint:
          'For transient errors (timeout, 5xx) retry the tool once as-is. Otherwise tell the user ' +
          'plainly what failed — do not invent a model. Procedural modeling in Blender or three.js ' +
          'is the fallback path.',
      };
    }

    // Provider output URLs expire within minutes — download and persist NOW.
    const glbRes = await fetchImpl(gen.glbUrl);
    if (!glbRes.ok) return { ok: false, error: `model_download_failed_${glbRes.status}` };
    const glbBuf = Buffer.from(await glbRes.arrayBuffer());
    if (glbBuf.length === 0 || glbBuf.length > MAX_MODEL_BYTES) {
      return { ok: false, error: 'model_download_bad_size' };
    }
    const storedModel = await persistGeneratedAsset(supabaseAdmin, userId, {
      buffer: glbBuf,
      ext: 'glb',
      contentType: 'model/gltf-binary',
      filename: 'generated-model.glb',
    });
    if (!storedModel.ok) return storedModel;

    let previewUrl = null;
    if (gen.previewUrl) {
      try {
        const prevRes = await fetchImpl(gen.previewUrl);
        if (prevRes.ok) {
          const prevBuf = Buffer.from(await prevRes.arrayBuffer());
          const prevType = prevRes.headers.get('content-type') || 'image/png';
          const stored = await persistGeneratedAsset(supabaseAdmin, userId, {
            buffer: prevBuf,
            ext: prevType.includes('jpeg') ? 'jpg' : 'png',
            contentType: prevType.split(';')[0],
            filename: 'model-preview.png',
          });
          if (stored.ok) previewUrl = stored.url;
        }
      } catch {
        // Preview is best-effort — the GLB is the deliverable.
      }
    }

    await settle({ provider: gen.provider, model: gen.model });
    if (typeof logUsage === 'function') {
      try {
        await logUsage({
          userId,
          actionType: 'model3d_gen',
          model: gen.model,
          provider: gen.provider,
          inputTokens: Math.ceil((text.length + image.length) / 4),
          outputTokens: 0,
          metadata: {
            tool: 'lykn_generate_3d_model',
            storage_path: storedModel.storage_path,
            provider: gen.provider,
            has_image_reference: Boolean(image),
          },
        });
      } catch {
        /* telemetry non-critical */
      }
    }

    return {
      ok: true,
      prompt: text || null,
      provider: gen.provider,
      model: gen.model,
      model_url: storedModel.url,
      model_format: 'glb',
      model_bytes: storedModel.bytes,
      storage_path: storedModel.storage_path,
      preview_image_url: previewUrl,
      usage_hint:
        'model_url is a TEMPORARY link (~24 hours) — the model belongs on the user\'s machine, not ' +
        'in the cloud. In a build workspace, download it into the project NOW with local_run_command ' +
        'curl and load it (three.js GLTFLoader / Blender import). In plain chat, give the user the ' +
        'model_url as a markdown download link and tell them to download it soon — the link expires. ' +
        'Look at preview_image_url to judge the result before using it.',
    };
  });
}

export const __test = { tripoGenerate, meshyGenerate, persistGeneratedAsset };
