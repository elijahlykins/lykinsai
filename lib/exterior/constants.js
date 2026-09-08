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

/**
 * Ephemeral generated assets (3D GLBs + their previews): the deliverable is
 * meant to land on the user's machine (downloaded in chat, or curled into a
 * build-workspace project the same turn). Cloud storage is transit only —
 * objects live under `<userId>/ephemeral/` and the vault reconciler deletes
 * anything there older than EPHEMERAL_OBJECT_TTL_MINUTES, so the signed URL
 * matches that window instead of pretending to be durable.
 */
export const EPHEMERAL_SIGNED_TTL_SEC = 60 * 60 * 24; // 24 hours
export const EPHEMERAL_OBJECT_TTL_MINUTES = 60 * 24; // swept after 24 hours
