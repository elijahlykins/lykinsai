/**
 * OpenAI image model — GPT Image 2 (released 2026-04-21) is the current
 * flagship. Primary provider for lykn_generate_image; Gemini Nano Banana
 * below stays as the fallback chain when OpenAI is unavailable.
 */
export const OPENAI_IMAGE_MODEL = String(
  process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
).trim();

/** Gemini Nano Banana model ids (see ai.google.dev/gemini-api/docs/image-generation). */
export const NANO_BANANA_MODEL = String(
  process.env.NANO_BANANA_MODEL || 'gemini-2.5-flash-image',
).trim();

export const NANO_BANANA_MODEL_FALLBACKS = [
  NANO_BANANA_MODEL,
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-image',
].filter((m, i, arr) => m && arr.indexOf(m) === i);

export const GENERATED_IMAGE_BUCKET = 'user-files';
export const GENERATED_IMAGE_SIGNED_TTL_SEC = 60 * 60 * 24 * 7; // 7 days
