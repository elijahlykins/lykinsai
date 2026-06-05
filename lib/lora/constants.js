/** Minimum valid chat examples required to start a LoRA job on Together. */
export const MIN_LORA_TRAINING_PAIRS = 16;

/** Recommended for stable LoRA runs (Together "max" batch fails on tiny sets). */
export const RECOMMENDED_LORA_TRAINING_PAIRS = 50;

/** Together LoRA hyperparameters (see fine-tuning quickstart). */
export const LORA_LEARNING_RATE = Number(process.env.LORA_LEARNING_RATE) || 1e-5;
export const LORA_WARMUP_RATIO = 0;

export const LORA_PROVIDER = 'together';

export const LORA_JOB_STATUSES = new Set([
  'queued',
  'uploading',
  'running',
  'ready',
  'failed',
  'cancelled',
]);
