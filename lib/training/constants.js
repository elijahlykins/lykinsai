export const TRAINING_SET_MODEL = process.env.TRAINING_SET_MODEL || 'claude-sonnet-4-6';

export const SYNTHESIS_PAIRS_PER_CALL = Math.min(
  30,
  Math.max(5, Number(process.env.TRAINING_SET_PAIRS_PER_CALL) || 20),
);

export const DOCUMENT_PAIRS_PER_CHUNK = Math.min(
  25,
  Math.max(5, Number(process.env.TRAINING_SET_PAIRS_PER_CHUNK) || 20),
);

/** Max vault text segments sent to Claude per job (cost guard). */
export const MAX_VAULT_CHUNKS_PER_JOB = Math.min(
  20,
  Math.max(1, Number(process.env.TRAINING_SET_MAX_VAULT_CHUNKS) || 8),
);

export const MAX_CONCURRENT_CLAUDE = Math.min(
  5,
  Math.max(1, Number(process.env.TRAINING_SET_MAX_CONCURRENCY) || 3),
);

export const MAX_PAIRS_V1 = Math.min(
  2000,
  Math.max(50, Number(process.env.TRAINING_SET_MAX_PAIRS) || 200),
);

/** Daily training-set starts per user. Set TRAINING_SET_DAILY_LIMIT=0 for unlimited (dev). */
export const MAX_GENERATIONS_PER_USER_PER_DAY = (() => {
  const raw = Number(process.env.TRAINING_SET_DAILY_LIMIT);
  if (Number.isFinite(raw) && raw <= 0) return Infinity;
  return Math.min(50, Math.max(1, Number.isFinite(raw) ? raw : 10));
})();

export const MIN_RESPONSE_CHARS = 20;

export const MIN_CONVERSATION_USER_CHARS = 12;
export const MIN_CONVERSATION_ASSISTANT_CHARS = 40;

/** Max stored exchanges turned into direct prompt/response pairs per job. */
export const MAX_CONVERSATION_PAIRS_PER_JOB = Math.min(
  120,
  Math.max(5, Number(process.env.TRAINING_SET_MAX_CONVERSATION_PAIRS) || 60),
);

export const MAX_CONVERSATION_EXCHANGES_FETCH = Math.min(
  120,
  Math.max(10, Number(process.env.TRAINING_SET_MAX_CONVERSATION_FETCH) || 80),
);

/**
 * Main /app chat. `grid` is the legacy DB label for the same surface (pre-075);
 * excluded from UI copy — not the old Omnia canvas.
 */
export const TRAINING_CHAT_SURFACES = ['chat', 'grid'];

export const GENERIC_RESPONSE_PATTERNS = [
  /as an ai language model/i,
  /i(?:'m| am) (?:just )?an ai/i,
  /i cannot help with that/i,
];
