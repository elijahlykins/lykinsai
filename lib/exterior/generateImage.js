import crypto from 'node:crypto';
import {
  GENERATED_IMAGE_BUCKET,
  GENERATED_IMAGE_SIGNED_TTL_SEC,
  NANO_BANANA_MODEL_FALLBACKS,
  OPENAI_IMAGE_MODEL,
} from './constants.js';
import { assertImageGenQuota } from './imageGenQuota.js';
import { buildFileProxyUrl, isFileProxyUrl, verifyFileToken } from './fileProxy.js';
import { safeFetch } from './ssrfGuard.js';

const MAX_PROMPT_LEN = 4000;
const MAX_REFERENCE_IMAGES = 4;
const MAX_REFERENCE_BYTES = 12 * 1024 * 1024;
const ALLOWED_ASPECT_RATIOS = new Set([
  '1:1', '1:4', '1:8', '2:3', '3:2', '3:4', '4:1', '4:3', '4:5', '5:4', '8:1', '9:16', '16:9', '21:9',
]);
const ALLOWED_IMAGE_SIZES = new Set(['512', '1K', '2K']);

const CONFIG_ERROR_RE = /response_format|image_config|aspect_ratio|image_size|generation_config|invalid value/i;

function pickModels(requested) {
  const primary = String(requested || '').trim();
  const chain = primary ? [primary, ...NANO_BANANA_MODEL_FALLBACKS] : [...NANO_BANANA_MODEL_FALLBACKS];
  return [...new Set(chain.filter(Boolean))];
}

function normalizeAspectRatio(value) {
  const ar = String(value || '').trim();
  return ALLOWED_ASPECT_RATIOS.has(ar) ? ar : null;
}

function normalizeImageSize(value) {
  const size = String(value || '').trim();
  return ALLOWED_IMAGE_SIZES.has(size) ? size : null;
}

/**
 * Gemini REST expects image sizing under generationConfig.imageConfig — NOT
 * generationConfig.responseFormat (that path 400s on the public API).
 */
export function buildImageGenerationAttempts(aspectRatio, imageSize) {
  const ar = normalizeAspectRatio(aspectRatio);
  const size = normalizeImageSize(imageSize);
  const attempts = [];

  if (ar || size) {
    const full = {};
    if (ar) full.aspectRatio = ar;
    if (size) full.imageSize = size;
    attempts.push({ imageConfig: full });
    if (ar && size) {
      attempts.push({ imageConfig: { aspectRatio: ar } });
    }
  }

  // Plain modalities — model defaults to ~1:1 when no imageConfig is set.
  attempts.push({});
  return attempts;
}

function extractImagePart(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      return {
        mimeType: inline.mimeType || inline.mime_type || 'image/png',
        base64: inline.data,
      };
    }
  }
  return null;
}

function extractTextPart(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text.trim() : ''))
    .filter(Boolean)
    .join('\n');
}

async function callNanoBananaOnce({ apiKey, model, prompt, configAttempt, referenceImages }) {
  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    ...configAttempt,
  };

  // Reference images (user attachments) ride as inline parts ahead of the
  // text so the model treats them as the subject being edited/composed.
  const parts = [
    ...(Array.isArray(referenceImages) ? referenceImages : []).map((img) => ({
      inline_data: { mime_type: img.mimeType || 'image/png', data: img.base64 },
    })),
    { text: prompt },
  ];

  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };

  for (const apiVersion of ['v1beta', 'v1']) {
    const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      const image = extractImagePart(json);
      if (image) {
        return {
          ok: true,
          model,
          apiVersion,
          image,
          caption: extractTextPart(json),
          usage: json.usageMetadata || null,
          configAttempt,
        };
      }
      return {
        ok: false,
        error: 'model_returned_no_image',
        model,
        retryable: false,
        detail: json?.promptFeedback || json?.error || null,
      };
    }
    const msg = json?.error?.message || res.statusText;
    if (res.status === 404 || /not found|invalid model/i.test(msg)) {
      continue;
    }
    return {
      ok: false,
      error: msg || `gemini_http_${res.status}`,
      model,
      retryable: CONFIG_ERROR_RE.test(msg) || res.status === 400,
    };
  }

  return { ok: false, error: 'nano_banana_model_unavailable', model, retryable: false };
}

// ── OpenAI GPT Image (primary provider) ─────────────────────────────────────

/**
 * GPT Image only accepts a fixed set of sizes — map the tool's free-form
 * aspect_ratio enum onto square / portrait / landscape.
 */
function openAiSizeForAspect(aspectRatio) {
  const ar = normalizeAspectRatio(aspectRatio);
  if (!ar) return null;
  const [w, h] = ar.split(':').map(Number);
  if (!w || !h || w === h) return '1024x1024';
  return w > h ? '1536x1024' : '1024x1536';
}

/** The tool's image_size enum ('512'|'1K'|'2K') maps onto GPT Image quality tiers. */
function openAiQualityForSize(imageSize) {
  const size = normalizeImageSize(imageSize);
  if (size === '512') return 'low';
  if (size === '2K') return 'high';
  return null; // default quality
}

async function callOpenAiImage({ apiKey, prompt, aspectRatio, imageSize, referenceImages }) {
  const model = OPENAI_IMAGE_MODEL;
  const size = openAiSizeForAspect(aspectRatio);
  const quality = openAiQualityForSize(imageSize);
  const refs = Array.isArray(referenceImages) ? referenceImages : [];

  // Reference images (user attachments / previous generations) → the edits
  // endpoint, which grounds generation in the actual pixels instead of a text
  // description of them. GPT Image accepts multiple image[] inputs.
  // `input_fidelity: high` preserves faces, logos, and fine detail from the
  // reference instead of a loose re-imagining; if the configured model
  // rejects the param, retry once without it rather than losing the whole
  // reference-grounded path to the Gemini fallback.
  const buildEditsForm = (withFidelity) => {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('n', '1');
    if (withFidelity) form.append('input_fidelity', 'high');
    if (size) form.append('size', size);
    if (quality) form.append('quality', quality);
    for (let i = 0; i < refs.length; i++) {
      const { base64, mimeType } = refs[i];
      const mime = mimeType || 'image/png';
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
        : mime.includes('webp') ? 'webp' : 'png';
      form.append(
        'image[]',
        new Blob([Buffer.from(base64, 'base64')], { type: mime }),
        `reference-${i + 1}.${ext}`,
      );
    }
    return form;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTransientHttp = (status) => status === 429 || status === 500 || status === 502 || status === 503 || status === 504;

  const doRequest = async () => {
    if (refs.length) {
      let res = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: buildEditsForm(true),
      });
      if (res.status === 400) {
        const errJson = await res.clone().json().catch(() => ({}));
        if (/input_fidelity/i.test(String(errJson?.error?.message || ''))) {
          res = await fetch('https://api.openai.com/v1/images/edits', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}` },
            body: buildEditsForm(false),
          });
        }
      }
      return res;
    }
    const body = {
      model,
      prompt,
      n: 1,
      ...(size ? { size } : {}),
      ...(quality ? { quality } : {}),
    };
    return fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  };

  let res;
  try {
    res = await doRequest();
    // Studio Imagine fires 4 concurrent gens — OpenAI often 429s one of them.
    // One short backoff retry absorbs that before we fall through to Gemini.
    if (isTransientHttp(res.status)) {
      await sleep(700 + Math.floor(Math.random() * 500));
      res = await doRequest();
    }
  } catch (e) {
    try {
      await sleep(700 + Math.floor(Math.random() * 500));
      res = await doRequest();
    } catch (e2) {
      return { ok: false, error: e2?.message || e?.message || 'openai_network_error', model, retryable: true };
    }
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText || `openai_http_${res.status}`;
    return { ok: false, error: msg, model, retryable: isTransientHttp(res.status) };
  }

  const item = Array.isArray(json?.data) ? json.data[0] : null;
  if (item?.b64_json) {
    const mimeType = json?.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
    return {
      ok: true,
      provider: 'openai',
      model,
      image: { mimeType, base64: item.b64_json },
      caption: item.revised_prompt || '',
      usage: json.usage || null,
    };
  }
  // Some responses ship a short-lived hosted URL instead of inline bytes —
  // pull it down immediately so we can persist a durable copy in storage.
  if (item?.url) {
    try {
      const imgRes = await fetch(item.url);
      if (imgRes.ok) {
        const arrayBuf = await imgRes.arrayBuffer();
        const mimeType = imgRes.headers.get('content-type') || 'image/png';
        return {
          ok: true,
          provider: 'openai',
          model,
          image: { mimeType, base64: Buffer.from(arrayBuf).toString('base64') },
          caption: item.revised_prompt || '',
          usage: json.usage || null,
        };
      }
    } catch {
      /* fall through to error below */
    }
  }
  return { ok: false, error: 'model_returned_no_image', model, retryable: true };
}

async function callNanoBanana({ apiKey, model, prompt, aspectRatio, imageSize, referenceImages }) {
  const attempts = buildImageGenerationAttempts(aspectRatio, imageSize);
  let lastErr = 'nano_banana_failed';

  for (const configAttempt of attempts) {
    const result = await callNanoBananaOnce({ apiKey, model, prompt, configAttempt, referenceImages });
    if (result.ok) return result;
    lastErr = result.error || lastErr;
    if (!result.retryable) break;
  }

  return { ok: false, error: lastErr, model };
}

async function persistGeneratedImage(supabaseAdmin, userId, { base64, mimeType }) {
  const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
  const id = crypto.randomBytes(8).toString('hex');
  const storagePath = `${userId}/generated/${Date.now()}-${id}.${ext}`;
  const buffer = Buffer.from(base64, 'base64');

  const { error: uploadErr } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: false });

  if (uploadErr) {
    return { ok: false, error: uploadErr.message || 'storage_upload_failed' };
  }

  const { data, error: signErr } = await supabaseAdmin.storage
    .from(GENERATED_IMAGE_BUCKET)
    .createSignedUrl(storagePath, GENERATED_IMAGE_SIGNED_TTL_SEC);

  if (signErr || !data?.signedUrl) {
    return { ok: false, error: signErr?.message || 'signed_url_failed', storage_path: storagePath };
  }

  let imageUrl = data.signedUrl;
  try {
    imageUrl = buildFileProxyUrl({
      bucket: GENERATED_IMAGE_BUCKET,
      path: storagePath,
      filename: `generated-image.${ext}`,
      ttlSec: GENERATED_IMAGE_SIGNED_TTL_SEC,
    });
  } catch {
    // No proxy secret configured — fall back to the raw signed URL.
  }

  return {
    ok: true,
    storage_path: storagePath,
    image_url: imageUrl,
    mime_type: mimeType,
    bytes: buffer.length,
  };
}

/**
 * Try every configured image provider in order: OpenAI GPT Image first
 * (the flagship model), then the Gemini Nano Banana fallback chain.
 */
async function runImageProviders({ prompt, aspectRatio, imageSize, referenceImages }) {
  let lastErr = 'image_generation_failed';
  let hadProvider = false;

  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    hadProvider = true;
    const gen = await callOpenAiImage({ apiKey: openAiKey, prompt, aspectRatio, imageSize, referenceImages });
    if (gen.ok) return gen;
    lastErr = gen.error || lastErr;
    console.warn(`[image-gen] OpenAI ${gen.model} failed (${lastErr}) — falling back to Gemini`);
  }

  const googleKey = process.env.GOOGLE_API_KEY;
  if (googleKey) {
    hadProvider = true;
    for (const model of pickModels(process.env.NANO_BANANA_MODEL)) {
      const gen = await callNanoBanana({ apiKey: googleKey, model, prompt, aspectRatio, imageSize, referenceImages });
      if (gen.ok) return { ...gen, provider: 'google' };
      lastErr = gen.error || lastErr;
    }
  }

  return { ok: false, error: hadProvider ? lastErr : 'image_generation_not_configured' };
}

/**
 * Our own file-proxy URLs (previous generations handed back for iterative
 * refinement) are read straight from storage instead of fetched over HTTP:
 * the token IS the authorization, and in local dev the proxy host is
 * localhost, which the SSRF guard would (correctly) refuse to fetch.
 */
async function loadFileProxyReference(url, supabaseAdmin) {
  if (!supabaseAdmin) return null;
  // Accept both artifacts.lykn.io and the API host so iterative refinement
  // still works for links minted before the artifacts subdomain cutover.
  if (!isFileProxyUrl(url)) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const m = /^\/f\/([^/]+)$/.exec(parsed.pathname);
  if (!m) return null;
  const token = verifyFileToken(decodeURIComponent(m[1]));
  if (!token) return null;
  const { data, error } = await supabaseAdmin.storage.from(token.bucket).download(token.path);
  if (error || !data) return null;
  const buf = Buffer.from(await data.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_REFERENCE_BYTES) return null;
  const ext = (token.path.split('.').pop() || 'png').toLowerCase();
  const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return { mimeType, base64: buf.toString('base64') };
}

/**
 * Normalize caller-supplied reference images into { mimeType, base64 }.
 * Accepts data: URLs, http(s) URLs (fetched via the SSRF-safe fetch; our own
 * file-proxy URLs are read directly from storage), and pre-decoded
 * { mimeType, base64 } objects. Unusable entries are dropped silently — a
 * bad reference should degrade to text-only generation, not fail the turn.
 */
async function normalizeReferenceImages(inputs, supabaseAdmin) {
  const list = Array.isArray(inputs) ? inputs.slice(0, MAX_REFERENCE_IMAGES) : [];
  const out = [];
  for (const item of list) {
    try {
      if (item && typeof item === 'object' && typeof item.base64 === 'string' && item.base64) {
        out.push({ mimeType: item.mimeType || 'image/png', base64: item.base64 });
        continue;
      }
      const url = String(item || '').trim();
      if (!url) continue;
      if (url.startsWith('data:image/')) {
        const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match && match[2].length <= MAX_REFERENCE_BYTES) {
          out.push({ mimeType: match[1], base64: match[2] });
        }
        continue;
      }
      if (/^https?:\/\//i.test(url)) {
        const proxied = await loadFileProxyReference(url, supabaseAdmin);
        if (proxied) {
          out.push(proxied);
          continue;
        }
        const res = await safeFetch(url);
        if (!res.ok) continue;
        const mime = res.headers.get('content-type') || 'image/png';
        if (!mime.startsWith('image/')) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_REFERENCE_BYTES) continue;
        out.push({ mimeType: mime.split(';')[0], base64: buf.toString('base64') });
      }
    } catch {
      // Skip unusable references — generation proceeds without them.
    }
  }
  return out;
}

/**
 * Generate an image (OpenAI GPT Image 2, Gemini fallback), enforce the
 * monthly quota, persist the result to storage. `referenceImages` (user
 * attachments this turn) ground the generation in real pixels — OpenAI
 * routes through /v1/images/edits, Gemini through inline image parts.
 *
 * `deliverBytes` hands the caller the raw base64 instead of uploading to the
 * bucket, for a desktop client keeping its vault on disk: the bytes are
 * already in memory here, and a round trip through cloud storage would only
 * create an object that client is about to duplicate locally and abandon.
 * Off by default, so the chat tool and processImage keep the hosted URL they
 * hand to the model.
 */
export async function generateChatImage({
  prompt,
  aspectRatio,
  imageSize,
  referenceImages,
  maskImage,
  userId,
  supabaseAdmin,
  logUsage,
  deliverBytes = false,
}) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: 'prompt is required' };
  if (text.length > MAX_PROMPT_LEN) return { ok: false, error: 'prompt_too_long' };

  if (!process.env.OPENAI_API_KEY && !process.env.GOOGLE_API_KEY) {
    return { ok: false, error: 'image_generation_not_configured' };
  }
  if (!supabaseAdmin || !userId) return { ok: false, error: 'unauthenticated' };

  const quota = await assertImageGenQuota(supabaseAdmin, userId);
  if (!quota.ok) return quota;

  const ar = normalizeAspectRatio(aspectRatio);
  const size = normalizeImageSize(imageSize);
  const refs = await normalizeReferenceImages(referenceImages, supabaseAdmin);
  // A mask is a fifth slot after the user references — white = edit region.
  // It rides as the last image so the prompt can say "the last image is the mask".
  const maskRefs = maskImage
    ? await normalizeReferenceImages([maskImage], supabaseAdmin)
    : [];
  if (maskRefs[0]) refs.push(maskRefs[0]);
  if (Array.isArray(referenceImages) && referenceImages.length > 0) {
    console.log(
      `🖼 image-gen: ${refs.length}/${referenceImages.length} reference image(s) usable` +
        (maskRefs[0] ? ' + mask' : ''),
    );
  }

  const gen = await runImageProviders({
    prompt: text,
    aspectRatio: ar,
    imageSize: size,
    referenceImages: refs,
  });
  if (!gen.ok) {
    console.error(
      `🖼 image-gen FAILED: ${gen.error} (refs=${refs.length}, ar=${ar || 'default'}, ` +
      `prompt[0..120]=${JSON.stringify(text.slice(0, 120))})`,
    );
    return {
      ok: false,
      error: gen.error,
      hint:
        'Image generation failed at the provider. If the error mentions moderation/safety, rephrase the ' +
        'prompt and retry once. For transient errors (timeout, 5xx, network), retry the tool once as-is. ' +
        'Otherwise tell the user what failed in plain words — do not invent an image.',
    };
  }

  const stored = deliverBytes
    ? {
        ok: true,
        storage_path: null,
        image_url: null,
        image_base64: gen.image.base64,
        mime_type: gen.image.mimeType,
        bytes: Buffer.byteLength(gen.image.base64, 'base64'),
      }
    : await persistGeneratedImage(supabaseAdmin, userId, gen.image);
  if (!stored.ok) return stored;

  if (typeof logUsage === 'function') {
    try {
      await logUsage({
        userId,
        actionType: 'image_gen',
        model: gen.model,
        provider: gen.provider || 'google',
        inputTokens:
          gen.usage?.input_tokens || gen.usage?.promptTokenCount || estimateTokens(text),
        outputTokens:
          gen.usage?.output_tokens || gen.usage?.candidatesTokenCount || 1290,
        metadata: {
          tool: 'lykn_generate_image',
          storage_path: stored.storage_path || 'local',
          aspect_ratio: ar || 'default',
          image_size: size || 'default',
          provider: gen.provider || 'google',
        },
      });
    } catch {
      /* telemetry non-critical */
    }
  }

  // Unlimited mode (cap temporarily lifted): quota.limit is Infinity, which
  // would JSON-serialize to null in the tool result — report it as the
  // string 'unlimited' instead so the model doesn't misread the quota.
  const remaining = Math.max(0, (quota.remaining ?? 1) - 1);
  return {
    ok: true,
    prompt: text,
    model: gen.model,
    provider: gen.provider || 'google',
    aspect_ratio: ar || 'default',
    image_size: size || 'default',
    image_url: stored.image_url,
    storage_path: stored.storage_path,
    image_base64: stored.image_base64 || null,
    mime_type: stored.mime_type,
    caption: gen.caption || null,
    monthly_used: (quota.used || 0) + 1,
    monthly_limit: quota.unlimited ? 'unlimited' : quota.limit,
    monthly_remaining: quota.unlimited ? 'unlimited' : remaining,
    resets_at: quota.resets_at,
    usage_hint:
      'The image is ALREADY shown to the user as an inline card in the chat. Do NOT paste image_url, storage_path, any URL, or a markdown image/link into your reply — just briefly acknowledge the image in plain words.',
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
