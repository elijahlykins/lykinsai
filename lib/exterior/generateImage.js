import crypto from 'node:crypto';
import {
  GENERATED_IMAGE_BUCKET,
  GENERATED_IMAGE_SIGNED_TTL_SEC,
  NANO_BANANA_MODEL_FALLBACKS,
} from './constants.js';
import { assertImageGenQuota } from './imageGenQuota.js';

const MAX_PROMPT_LEN = 2000;
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

async function callNanoBananaOnce({ apiKey, model, prompt, configAttempt }) {
  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    ...configAttempt,
  };

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
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

async function callNanoBanana({ apiKey, model, prompt, aspectRatio, imageSize }) {
  const attempts = buildImageGenerationAttempts(aspectRatio, imageSize);
  let lastErr = 'nano_banana_failed';

  for (const configAttempt of attempts) {
    const result = await callNanoBananaOnce({ apiKey, model, prompt, configAttempt });
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

  return {
    ok: true,
    storage_path: storagePath,
    image_url: data.signedUrl,
    mime_type: mimeType,
    bytes: buffer.length,
  };
}

/**
 * Generate an image with Gemini Nano Banana, enforce monthly quota, persist to storage.
 */
export async function generateNanoBananaImage({
  prompt,
  aspectRatio,
  imageSize,
  userId,
  supabaseAdmin,
  logUsage,
}) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: 'prompt is required' };
  if (text.length > MAX_PROMPT_LEN) return { ok: false, error: 'prompt_too_long' };

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return { ok: false, error: 'GOOGLE_API_KEY not configured' };
  if (!supabaseAdmin || !userId) return { ok: false, error: 'unauthenticated' };

  const quota = await assertImageGenQuota(supabaseAdmin, userId);
  if (!quota.ok) return quota;

  const ar = normalizeAspectRatio(aspectRatio);
  const size = normalizeImageSize(imageSize);

  let lastErr = 'nano_banana_failed';
  for (const model of pickModels(process.env.NANO_BANANA_MODEL)) {
    const gen = await callNanoBanana({
      apiKey,
      model,
      prompt: text,
      aspectRatio: ar,
      imageSize: size,
    });
    if (!gen.ok) {
      lastErr = gen.error || lastErr;
      continue;
    }

    const stored = await persistGeneratedImage(supabaseAdmin, userId, gen.image);
    if (!stored.ok) return stored;

    if (typeof logUsage === 'function') {
      try {
        await logUsage({
          userId,
          actionType: 'image_gen',
          model: gen.model,
          provider: 'google',
          inputTokens: gen.usage?.promptTokenCount || estimateTokens(text),
          outputTokens: gen.usage?.candidatesTokenCount || 1290,
          metadata: {
            tool: 'lykn_generate_image',
            storage_path: stored.storage_path,
            aspect_ratio: ar || 'default',
            image_size: size || 'default',
            config_fallback: !gen.configAttempt?.imageConfig,
          },
        });
      } catch {
        /* telemetry non-critical */
      }
    }

    const remaining = Math.max(0, (quota.remaining ?? 1) - 1);
    return {
      ok: true,
      prompt: text,
      model: gen.model,
      aspect_ratio: ar || 'default',
      image_size: size || 'default',
      image_url: stored.image_url,
      storage_path: stored.storage_path,
      mime_type: stored.mime_type,
      caption: gen.caption || null,
      monthly_used: (quota.used || 0) + 1,
      monthly_limit: quota.limit,
      monthly_remaining: remaining,
      resets_at: quota.resets_at,
      usage_hint:
        'The image is ALREADY shown to the user as an inline card in the chat. Do NOT paste image_url, storage_path, any URL, or a markdown image/link into your reply — just briefly acknowledge the image in plain words.',
    };
  }

  return { ok: false, error: lastErr };
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
