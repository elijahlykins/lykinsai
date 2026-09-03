import { canonicalizeModelId, LYKN_ID } from './modelTiers';

const DEFAULT_AI_MODEL = LYKN_ID;

// Migrate retired ids (lykn-lite / lykn-fast / lykn-deep) to a current
// LYKN id, falling back to the provided default if the saved value is
// unrecognised. Still-served provider ids pass through unchanged.
export const normalizeModelValue = (model, fallback = DEFAULT_AI_MODEL) => {
  const fallbackModel = canonicalizeModelId(fallback) || DEFAULT_AI_MODEL;
  const canonical = canonicalizeModelId(model);
  return canonical || fallbackModel;
};

export const getSelectedAiModel = (fallback = DEFAULT_AI_MODEL) => {
  const fallbackModel = normalizeModelValue(fallback);
  try {
    const raw = localStorage.getItem('lykinsai_settings');
    if (!raw) return fallbackModel;
    const parsed = JSON.parse(raw);
    return normalizeModelValue(parsed?.aiModel, fallbackModel);
  } catch {
    return fallbackModel;
  }
};

export const DEFAULT_MODEL = DEFAULT_AI_MODEL;
