/**
 * The brief — the day's rundown — and the two ways it opens.
 *
 * "Brief on startup" (Settings → Notifications) slides a card in on the right
 * once per launch. The switch rides on the same `lykinsai_settings` blob as
 * theme and the home widgets, so it stays per-install: whether opening LYKN
 * greets you with a brief is a property of this machine, not the account.
 *
 * Studio's top bar can also ask for it any time, which is a window event
 * rather than shared state so the button doesn't care where the popup is
 * mounted (same arrangement as `lykn_open_calendar`).
 */

const SETTINGS_KEY = 'lykinsai_settings';
const SETTINGS_EVENT = 'lykinsai_settings_changed';
const OPEN_EVENT = 'lykn_open_brief';

/* One notification per launch. sessionStorage is scoped to the window, so a
 * reload keeps the guard (no second brief) while a fresh launch clears it. */
const SHOWN_KEY = 'lykn:startup-brief-shown';

export const STARTUP_BRIEF_DEFAULT = false;

export function readStartupBriefEnabled() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof saved.startupBrief === 'boolean') return saved.startupBrief;
  } catch {
    /* fall through to the default */
  }
  return STARTUP_BRIEF_DEFAULT;
}

/** Follow the switch from Settings, in this window or another one. */
export function subscribeStartupBrief(onChange) {
  if (typeof window === 'undefined') return () => {};
  const sync = () => onChange(readStartupBriefEnabled());
  window.addEventListener(SETTINGS_EVENT, sync);
  window.addEventListener('storage', sync);
  return () => {
    window.removeEventListener(SETTINGS_EVENT, sync);
    window.removeEventListener('storage', sync);
  };
}

export function startupBriefWasShown() {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markStartupBriefShown() {
  try {
    sessionStorage.setItem(SHOWN_KEY, '1');
  } catch {
    /* best-effort — worst case the brief arrives again on the next navigation */
  }
}

/** Open the brief now, whatever the startup switch says. */
export function openBrief() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function subscribeOpenBrief(onOpen) {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(OPEN_EVENT, onOpen);
  return () => window.removeEventListener(OPEN_EVENT, onOpen);
}
