export const DEFAULT_BG_DARK = '#1e1e1e';
export const DEFAULT_BG_LIGHT = '#ffffff';

const STORAGE_KEY = 'lykinsai_settings';
const VALID_THEMES = new Set(['light', 'dark', 'system']);

/**
 * Theme can be 'light', 'dark', or 'system'. Anything unrecognized falls
 * back to 'dark' — LYKN has always shipped dark-first, so that stays the
 * default for brand-new sessions with no saved preference.
 */
export function normalizeTheme(theme) {
  return VALID_THEMES.has(theme) ? theme : 'dark';
}

function systemPrefersDark() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Collapse 'system' to the concrete 'light' | 'dark' it currently maps to. */
export function resolveTheme(theme) {
  const normalized = normalizeTheme(theme);
  if (normalized === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return normalized;
}

export function isDarkTheme(theme) {
  return resolveTheme(theme) === 'dark';
}

export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const dark = isDarkTheme(theme);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  // The body reads --app-background (src/index.css). The CSS variable already
  // cascades correctly via :root / .dark, but we also set it inline so any
  // surface reading var(--app-background) directly stays in sync immediately.
  root.style.setProperty('--app-background', dark ? DEFAULT_BG_DARK : DEFAULT_BG_LIGHT);
  // Tell the UA to render native controls (scrollbars, form widgets) to match.
  root.style.colorScheme = dark ? 'dark' : 'light';
}

export function readSavedTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return normalizeTheme(saved.theme);
  } catch {
    return 'dark';
  }
}

/**
 * Keep the app in sync with OS appearance changes while the user's
 * preference is 'system'. Returns an unsubscribe fn. No-op off the main
 * thread or when matchMedia is unavailable.
 */
export function initThemeWatcher() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (readSavedTheme() === 'system') applyTheme('system');
  };
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }
  // Safari < 14 fallback.
  media.addListener(handler);
  return () => media.removeListener(handler);
}
