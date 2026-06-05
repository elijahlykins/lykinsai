/** Monthly cap per user for in-chat Nano Banana image generation. */
export const IMAGE_GEN_MONTHLY_LIMIT = Math.max(
  1,
  Number(process.env.IMAGE_GEN_MONTHLY_LIMIT || 5),
);

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
