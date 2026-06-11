import crypto from 'node:crypto';
import { NANO_BANANA_MODEL_FALLBACKS } from '../constants.js';
import { buildImageGenerationAttempts } from '../generateImage.js';
import { persistCapabilityArtifact } from '../capabilityStorage.js';

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

async function callGeminiImageEdit({ apiKey, model, prompt, referenceBase64, mimeType, configAttempt }) {
  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    ...configAttempt,
  };
  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { data: referenceBase64, mimeType } },
          { text: prompt },
        ],
      },
    ],
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
    if (!res.ok) continue;
    const image = extractImagePart(json);
    if (image) return { ok: true, model, image, apiVersion };
  }
  return { ok: false, error: 'image_edit_failed' };
}

/**
 * Edit an image using Gemini image generation with a reference image input.
 */
export async function editImageWithGemini({
  prompt,
  referenceBase64,
  mimeType,
  userId,
  supabaseAdmin,
  aspectRatio,
  imageSize,
}) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return { ok: false, error: 'GOOGLE_API_KEY not configured' };
  if (!userId || !supabaseAdmin) return { ok: false, error: 'unauthenticated' };

  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: 'prompt is required' };
  if (!referenceBase64) return { ok: false, error: 'reference_image_required' };

  const attempts = buildImageGenerationAttempts(aspectRatio, imageSize);
  let lastErr = 'image_edit_failed';

  for (const model of NANO_BANANA_MODEL_FALLBACKS) {
    for (const configAttempt of attempts) {
      const gen = await callGeminiImageEdit({
        apiKey,
        model,
        prompt: `Edit this image as requested. Preserve composition where appropriate unless the user asks otherwise.\n\nEdit request: ${text}`,
        referenceBase64,
        mimeType: mimeType || 'image/png',
        configAttempt,
      });
      if (!gen.ok) {
        lastErr = gen.error || lastErr;
        continue;
      }

      const buffer = Buffer.from(gen.image.base64, 'base64');
      const stored = await persistCapabilityArtifact(supabaseAdmin, userId, {
        buffer,
        filename: `edited-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.png`,
        mimeType: gen.image.mimeType,
        category: 'images',
      });
      if (!stored.ok) return stored;

      return {
        ok: true,
        operation: 'edit',
        model: gen.model,
        image_url: stored.file_url,
        storage_path: stored.storage_path,
        download_url: stored.file_url,
        usage_hint:
          'The edited image is ALREADY shown to the user as an inline card in the chat. Do NOT paste image_url, storage_path, any URL, or a markdown image/link into your reply — just briefly acknowledge the edit in plain words.',
      };
    }
  }

  return { ok: false, error: lastErr };
}
