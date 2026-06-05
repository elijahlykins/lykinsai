const STORAGE_KEY = 'lykn_active_custom_model_id';

export function loadActiveCustomModelId() {
  try {
    const id = localStorage.getItem(STORAGE_KEY);
    return id && id.length > 8 ? id : null;
  } catch {
    return null;
  }
}

export function saveActiveCustomModelId(modelId) {
  try {
    if (!modelId) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, modelId);
    window.dispatchEvent(new CustomEvent('lykn_active_custom_model_changed'));
  } catch {
    /* ignore */
  }
}
