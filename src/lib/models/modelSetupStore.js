const STORAGE_KEY = 'lykn_model_setup_v1';

export function emptyModelSetup() {
  return { mode: 'lykn', categories: {} };
}

export function readLocalModelSetup() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyModelSetup();
    const parsed = JSON.parse(raw);
    const categories = parsed?.categories && typeof parsed.categories === 'object' && !Array.isArray(parsed.categories)
      ? parsed.categories
      : {};
    return {
      mode: parsed?.mode === 'my_setup' ? 'my_setup' : 'lykn',
      categories,
    };
  } catch {
    return emptyModelSetup();
  }
}

export function writeLocalModelSetup(setup) {
  const next = {
    mode: setup?.mode === 'my_setup' ? 'my_setup' : 'lykn',
    categories: setup?.categories && typeof setup.categories === 'object' ? setup.categories : {},
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lykn_model_setup_changed', { detail: next }));
  }
  return next;
}
