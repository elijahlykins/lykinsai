import crypto from 'node:crypto';
import { GENERATED_IMAGE_BUCKET, GENERATED_IMAGE_SIGNED_TTL_SEC } from './constants.js';
import { buildFileProxyUrl } from './fileProxy.js';
import { withReservedUsage } from '../billing/usageBalance.js';

/**
 * Video generation — OpenRouter's video API first, direct Gemini Veo as the
 * fallback. Same posture as chat: OpenRouter is the gateway (one key, and it
 * routes the top video models — Veo 3.1, Kling 3 Pro, Seedance 2, Wan 2.7,
 * Sora 2 Pro — behind one standardized async job API), direct providers are
 * the incident escape hatch.
 *
 * Both providers are async job flows:
 *   - OpenRouter: POST /api/v1/videos → { id, polling_url }; poll until
 *     status=completed; download unsigned_urls[0] with the Bearer key.
 *   - Gemini: POST models/{veo}:predictLongRunning → operation name; poll
 *     until done; download the video URI with the API key + redirects.
 *
 * Either way the MP4 is downloaded from the provider immediately — provider
 * URLs expire and (for Gemini) require the API key. It is then either handed
 * back as base64 (deliverBytes — local-vault desktop clients store the clip on
 * the user's machine, no cloud object at all) or persisted to OUR storage for
 * a durable file-proxy link.
 *
 * A reference image (a picked Imagine generation, or an attachment) rides as
 * the FIRST FRAME — the model animates from those exact pixels, which is what
 * makes "animate this image" work as a product.
 */

const MAX_PROMPT_LEN = 4000;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
// deliverBytes ceiling: above this the base64 JSON response gets unwieldy, so
// the clip falls back to storage persist instead of failing the generation.
// Imagine's fast-tier 4-8s clips sit far below this.
const MAX_BYTES_DELIVERY = 96 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 8000;
const DEFAULT_MAX_WAIT_MS = 8 * 60 * 1000;

const OPENROUTER_VIDEOS_BASE = 'https://openrouter.ai/api/v1/videos';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// The fixed-cost video_gen raw assumption ($1.20) is sized for the fast tier
// (≈$0.15/s × 8s). Flagship tiers (google/veo-3.1, kling-v3.0-pro, sora-2-pro)
// run several ×  that — revisit FIXED_RAW_COST_MICROS before defaulting to one.
export const DEFAULT_OPENROUTER_VIDEO_MODEL = 'google/veo-3.1-fast';
export const DEFAULT_VEO_MODEL = 'veo-3.1-fast-generate-preview';

const ALLOWED_VIDEO_ASPECTS = new Set(['16:9', '9:16']);
const ALLOWED_DURATIONS = new Set([4, 6, 8]);

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** data: URL or http(s) URL → { mimeType, base64 } (null when unusable). */
async function loadReferenceImage(input, fetchImpl) {
  const url = String(input || '').trim();
  if (!url) return null;
  if (url.startsWith('data:image/')) {
    const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (match && match[2].length <= MAX_REFERENCE_BYTES) {
      return { mimeType: match[1], base64: match[2] };
    }
    return null;
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) return null;
      const mime = (res.headers.get('content-type') || 'image/png').split(';')[0];
      if (!mime.startsWith('image/')) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_REFERENCE_BYTES) return null;
      return { mimeType: mime, base64: buf.toString('base64') };
    } catch {
      return null;
    }
  }
  return null;
}

/** Providers in preference order: the gateway first, direct Veo as fallback. */
export function pickVideoProviders(env = process.env) {
  const chain = [];
  if (env.OPENROUTER_API_KEY) chain.push({ id: 'openrouter', apiKey: env.OPENROUTER_API_KEY });
  if (env.GOOGLE_API_KEY) chain.push({ id: 'gemini', apiKey: env.GOOGLE_API_KEY });
  return chain;
}

/** A requested model routes by shape: OpenRouter slugs carry a vendor prefix. */
export function videoModelForProvider(providerId, requestedModel, env = process.env) {
  const requested = String(requestedModel || '').trim();
  if (providerId === 'openrouter') {
    if (requested.includes('/')) return requested;
    return String(env.OPENROUTER_VIDEO_MODEL || '').trim() || DEFAULT_OPENROUTER_VIDEO_MODEL;
  }
  if (requested && !requested.includes('/')) return requested;
  return String(env.VEO_MODEL || '').trim() || DEFAULT_VEO_MODEL;
}

async function openRouterGenerate({
  apiKey,
  model,
  prompt,
  referenceImage,
  aspectRatio,
  durationSeconds,
  fetchImpl,
  sleep,
  maxWaitMs,
  pollIntervalMs,
}) {
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const body = { model, prompt };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (durationSeconds) body.duration = durationSeconds;
  if (referenceImage) {
    body.frame_images = [
      {
        type: 'image_url',
        image_url: { url: `data:${referenceImage.mimeType};base64,${referenceImage.base64}` },
        frame_type: 'first_frame',
      },
    ];
  }

  const submit = await fetchImpl(OPENROUTER_VIDEOS_BASE, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const submitted = await submit.json().catch(() => ({}));
  const jobId = submitted?.id;
  if (!submit.ok || !jobId) {
    return {
      ok: false,
      error: submitted?.error?.message || submitted?.error || `openrouter_video_http_${submit.status}`,
      retryable: submit.status === 429 || submit.status >= 500,
    };
  }
  const pollingUrl = submitted.polling_url || `${OPENROUTER_VIDEOS_BASE}/${jobId}`;

  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(pollIntervalMs);
    const poll = await fetchImpl(pollingUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    const pj = await poll.json().catch(() => ({}));
    if (pj?.status === 'completed') {
      const contentUrl = pj.unsigned_urls?.[0] || `${OPENROUTER_VIDEOS_BASE}/${jobId}/content?index=0`;
      return {
        ok: true,
        provider: 'openrouter',
        model,
        download: { url: contentUrl, headers: { Authorization: `Bearer ${apiKey}` } },
        reportedCostUsd: typeof pj.usage?.cost === 'number' ? pj.usage.cost : null,
      };
    }
    if (pj?.status === 'failed' || pj?.status === 'cancelled' || pj?.status === 'expired') {
      return { ok: false, error: pj?.error || `openrouter_video_${pj.status}`, retryable: false };
    }
    // pending / in_progress → keep polling.
  }
  return { ok: false, error: 'openrouter_video_timeout', retryable: false };
}

async function veoGenerate({
  apiKey,
  model,
  prompt,
  referenceImage,
  aspectRatio,
  durationSeconds,
  fetchImpl,
  sleep,
  maxWaitMs,
  pollIntervalMs,
}) {
  const instance = { prompt };
  if (referenceImage) {
    instance.image = {
      inlineData: { mimeType: referenceImage.mimeType, data: referenceImage.base64 },
    };
  }
  const parameters = {};
  if (aspectRatio) parameters.aspectRatio = aspectRatio;
  if (durationSeconds) parameters.durationSeconds = durationSeconds;

  const submit = await fetchImpl(`${GEMINI_BASE}/models/${model}:predictLongRunning`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [instance], parameters }),
  });
  const submitted = await submit.json().catch(() => ({}));
  const opName = submitted?.name;
  if (!submit.ok || !opName) {
    return {
      ok: false,
      error: submitted?.error?.message || `veo_http_${submit.status}`,
      retryable: submit.status === 429 || submit.status >= 500,
    };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(pollIntervalMs);
    const poll = await fetchImpl(`${GEMINI_BASE}/${opName}`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    const pj = await poll.json().catch(() => ({}));
    if (pj?.done === true) {
      if (pj.error) {
        return { ok: false, error: pj.error.message || 'veo_operation_failed', retryable: false };
      }
      const sample = pj.response?.generateVideoResponse?.generatedSamples?.[0];
      const uri = sample?.video?.uri;
      if (!uri) return { ok: false, error: 'veo_no_video_uri', retryable: false };
      return {
        ok: true,
        provider: 'google',
        model,
        download: { url: uri, headers: { 'x-goog-api-key': apiKey } },
        filteredReasons: pj.response?.generateVideoResponse?.raiMediaFilteredReasons || null,
      };
    }
  }
  return { ok: false, error: 'veo_timeout', retryable: false };
}

async function persistGeneratedVideo(supabaseAdmin, userId, buffer) {
  const id = crypto.randomBytes(8).toString('hex');
  const storagePath = `${userId}/generated/${Date.now()}-${id}.mp4`;
  const { error: uploadErr } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: 'video/mp4', upsert: false });
  if (uploadErr) return { ok: false, error: uploadErr.message || 'storage_upload_failed' };

  const { data, error: signErr } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .createSignedUrl(storagePath, GENERATED_IMAGE_SIGNED_TTL_SEC);
  if (signErr || !data?.signedUrl) {
    return { ok: false, error: signErr?.message || 'signed_url_failed', storage_path: storagePath };
  }

  let url = data.signedUrl;
  try {
    url = buildFileProxyUrl({
      bucket: GENERATED_IMAGE_BUCKET,
      path: storagePath,
      filename: 'generated-video.mp4',
      ttlSec: GENERATED_IMAGE_SIGNED_TTL_SEC,
    });
  } catch {
    // No proxy secret configured — raw signed URL still works.
  }
  return { ok: true, url, storage_path: storagePath, bytes: buffer.length };
}

/**
 * Generate a video from a text prompt, optionally animating from a reference
 * image as the first frame. Meters the Usage Balance (video_gen) and either
 * persists the MP4 to storage (returning a durable video_url) or — when
 * deliverBytes is set by a local-vault desktop client — returns the raw MP4
 * as video_base64 so the clip lands on the user's machine and never touches
 * cloud storage.
 */
export async function generateChatVideo({
  prompt,
  referenceImage,
  aspectRatio,
  durationSeconds,
  model,
  userId,
  supabaseAdmin,
  logUsage,
  authorizeUsage,
  deliverBytes = false,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  env = process.env,
}) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: 'prompt is required' };
  if (text.length > MAX_PROMPT_LEN) return { ok: false, error: 'prompt_too_long' };

  const providers = pickVideoProviders(env);
  if (providers.length === 0) return { ok: false, error: 'video_generation_not_configured' };
  if (!supabaseAdmin || !userId) return { ok: false, error: 'unauthenticated' };

  const ar = ALLOWED_VIDEO_ASPECTS.has(String(aspectRatio || '')) ? String(aspectRatio) : null;
  const duration = ALLOWED_DURATIONS.has(Number(durationSeconds)) ? Number(durationSeconds) : null;

  let reservation = null;
  if (typeof authorizeUsage === 'function') {
    const auth = await authorizeUsage({ actionType: 'video_gen' });
    if (!auth?.ok) {
      return {
        ok: false,
        error: auth?.error || 'insufficient_usage_balance',
        message: auth?.message || 'Add funds to continue with this action.',
        usage_balance_usd: auth?.usage_balance_usd,
        required_usd: auth?.required_usd,
        add_funds: true,
      };
    }
    reservation = auth.reservation || null;
  }

  return withReservedUsage(reservation, async ({ settle }) => {
    const ref = referenceImage ? await loadReferenceImage(referenceImage, fetchImpl) : null;

    let gen = null;
    let lastErr = 'video_generation_failed';
    for (const provider of providers) {
      const args = {
        apiKey: provider.apiKey,
        model: videoModelForProvider(provider.id, model, env),
        prompt: text,
        referenceImage: ref,
        aspectRatio: ar,
        durationSeconds: duration,
        fetchImpl,
        sleep: sleepImpl,
        maxWaitMs,
        pollIntervalMs,
      };
      const attempt =
        provider.id === 'openrouter' ? await openRouterGenerate(args) : await veoGenerate(args);
      if (attempt.ok) {
        gen = attempt;
        break;
      }
      lastErr = attempt.error || lastErr;
      console.warn(`🎬 video-gen: ${provider.id} failed (${lastErr})`);
    }
    if (!gen) {
      return {
        ok: false,
        error: lastErr,
        hint:
          'For transient errors (timeout, 5xx) retry once. If the error mentions safety/policy, ' +
          'rephrase the prompt. Otherwise report the failure plainly — never pretend a video exists.',
      };
    }

    // Provider URLs are key-gated and short-lived — download and persist NOW.
    const dl = await fetchImpl(gen.download.url, {
      headers: gen.download.headers,
      redirect: 'follow',
    });
    if (!dl.ok) return { ok: false, error: `video_download_failed_${dl.status}` };
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_VIDEO_BYTES) {
      return { ok: false, error: 'video_download_bad_size' };
    }

    // Local delivery: hand the MP4 back as base64 and skip cloud storage
    // entirely — the desktop client writes it into the local vault store.
    // Oversized clips fall back to storage persist rather than failing.
    const deliverAsBytes = deliverBytes === true && buf.length <= MAX_BYTES_DELIVERY;
    const stored = deliverAsBytes ? null : await persistGeneratedVideo(supabaseAdmin, userId, buf);
    if (stored && !stored.ok) return stored;

    await settle({ provider: gen.provider, model: gen.model });
    if (typeof logUsage === 'function') {
      try {
        await logUsage({
          userId,
          actionType: 'video_gen',
          model: gen.model,
          provider: gen.provider,
          inputTokens: Math.ceil(text.length / 4),
          outputTokens: 0,
          metadata: {
            surface: 'studio_imagine',
            storage_path: stored ? stored.storage_path : null,
            delivery: deliverAsBytes ? 'bytes' : 'storage',
            duration_seconds: duration || 'default',
            has_reference: Boolean(ref),
            // OpenRouter reports the real job cost — kept for margin review
            // against the fixed video_gen raw-cost assumption.
            provider_cost_usd: gen.reportedCostUsd ?? null,
          },
        });
      } catch {
        /* telemetry non-critical */
      }
    }

    return {
      ok: true,
      prompt: text,
      provider: gen.provider,
      model: gen.model,
      video_url: stored ? stored.url : null,
      storage_path: stored ? stored.storage_path : null,
      video_base64: deliverAsBytes ? buf.toString('base64') : null,
      mime_type: 'video/mp4',
      video_bytes: buf.length,
      aspect_ratio: ar || 'default',
      duration_seconds: duration || 'default',
      provider_cost_usd: gen.reportedCostUsd ?? null,
      filtered_reasons: gen.filteredReasons || null,
    };
  });
}

export const __test = { openRouterGenerate, veoGenerate, loadReferenceImage };
