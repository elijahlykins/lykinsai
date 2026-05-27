export const DEFAULT_BG_DARK = '#1e1e1e';

/** Light mode is not shipped yet — always dark until it is. */
export function normalizeTheme(_theme) {
  return 'dark';
}

export function isDarkTheme(_theme) {
  return true;
}

export function applyTheme(_theme) {
  document.documentElement.classList.add('dark');
  document.documentElement.style.setProperty('--app-background', DEFAULT_BG_DARK);
}

export function readSavedTheme() {
  return 'dark';
}
