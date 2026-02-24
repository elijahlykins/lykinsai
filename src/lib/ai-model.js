const DEFAULT_AI_MODEL = 'gemini-flash-latest';

export const normalizeModelValue = (model) => {
  const value = String(model || '').trim();
  if (!value) return DEFAULT_AI_MODEL;
  return value;
};

export const getSelectedAiModel = (fallback = DEFAULT_AI_MODEL) => {
  const fallbackModel = normalizeModelValue(fallback);
  try {
    const raw = localStorage.getItem('lykinsai_settings');
    if (!raw) return fallbackModel;
    const parsed = JSON.parse(raw);
    return normalizeModelValue(parsed?.aiModel || fallbackModel);
  } catch {
    return fallbackModel;
  }
};

export const DEFAULT_MODEL = DEFAULT_AI_MODEL;
