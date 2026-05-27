export const DEFAULT_BG_DARK = '#1e1e1e';

/** Dark is the default; only an explicit `light` choice opts out. */
export function normalizeTheme(theme) {
  return theme === 'light' ? 'light' : 'dark';
}

export function isDarkTheme(theme) {
  return normalizeTheme(theme) === 'dark';
}

export function applyTheme(theme) {
  const isDark = isDarkTheme(theme);
  document.documentElement.classList.toggle('dark', isDark);
  if (isDark) {
    document.documentElement.style.setProperty('--app-background', DEFAULT_BG_DARK);
  } else {
    document.documentElement.style.removeProperty('--app-background');
  }
}

export function readSavedTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem('lykinsai_settings') || '{}');
    return normalizeTheme(saved.theme);
  } catch {
    return 'dark';
  }
}
