/** Select value prefix for published custom models in the shared model picker. */
export const CUSTOM_MODEL_VALUE_PREFIX = 'custom:';

export function customModelSelectValue(modelId) {
  return `${CUSTOM_MODEL_VALUE_PREFIX}${modelId}`;
}

export function parseCustomModelSelectValue(value) {
  const raw = String(value || '');
  if (!raw.startsWith(CUSTOM_MODEL_VALUE_PREFIX)) return null;
  const id = raw.slice(CUSTOM_MODEL_VALUE_PREFIX.length).trim();
  return id.length > 8 ? id : null;
}

export function isCustomModelSelectValue(value) {
  return !!parseCustomModelSelectValue(value);
}
