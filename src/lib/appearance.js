/**
 * Appearance tokens — the Settings › Appearance pane writes here and every
 * surface reads the resulting CSS variables. Values live inside the existing
 * `lykinsai_settings` blob under `appearance` so nothing that already reads
 * that key (theme, fontSize) changes shape.
 */

const STORAGE_KEY = 'lykinsai_settings';

/** Accent swatches, in the order they render in the pane. */
export const ACCENTS = [
  { id: 'aurora', name: 'Aurora', hsl: '265 62% 70%', iridescent: true },
  { id: 'snow', name: 'Snow', hsl: '210 16% 76%' },
  { id: 'sand', name: 'Sand', hsl: '34 44% 74%' },
  { id: 'sage', name: 'Sage', hsl: '148 24% 66%' },
  { id: 'mist', name: 'Mist', hsl: '196 32% 70%' },
  { id: 'ocean', name: 'Ocean', hsl: '210 92% 56%' },
  { id: 'periwinkle', name: 'Periwinkle', hsl: '240 68% 70%' },
  { id: 'orchid', name: 'Orchid', hsl: '286 52% 66%' },
  { id: 'clay', name: 'Clay', hsl: '14 38% 62%' },
  { id: 'graphite', name: 'Graphite', hsl: '220 8% 42%' },
];

/**
 * Chat ink — the color of the words inside the AI chat, and nowhere else. The
 * same palette backs three separate choices: the user's text, LYKN's replies,
 * and the fill of the user's message bubble.
 *
 * 'default' means "whatever the theme already does" (black in light, white in
 * dark — or, for the bubble, the stock surface) and paints nothing; every other
 * preset is one literal color, used as-is in both themes, so a deep ink stays
 * deep instead of being flipped to a pale one behind the user's back.
 *
 * `accentDerived` follows the swatch instead of shipping one entry per color.
 */
export const INK_DEFAULT_ID = 'default';
export const INK_CUSTOM_ID = 'custom';

export const INKS = [
  { id: INK_DEFAULT_ID, name: 'Default' },
  { id: 'accent', name: 'My accent', accentDerived: true },

  // Neutrals, lightest to darkest.
  { id: 'white', name: 'White', hsl: '0 0% 100%' },
  { id: 'ivory', name: 'Ivory', hsl: '38 44% 92%' },
  { id: 'silver', name: 'Silver', hsl: '214 14% 74%' },
  { id: 'graphite', name: 'Graphite', hsl: '220 9% 46%' },
  { id: 'charcoal', name: 'Charcoal', hsl: '220 14% 18%' },

  // Bright enough to read on a dark chat.
  { id: 'blue', name: 'Blue', hsl: '212 92% 58%' },
  { id: 'sky', name: 'Sky', hsl: '196 88% 62%' },
  { id: 'teal', name: 'Teal', hsl: '174 68% 44%' },
  { id: 'green', name: 'Green', hsl: '146 62% 45%' },
  { id: 'yellow', name: 'Yellow', hsl: '46 94% 56%' },
  { id: 'orange', name: 'Orange', hsl: '28 92% 55%' },
  { id: 'red', name: 'Red', hsl: '2 80% 57%' },
  { id: 'pink', name: 'Pink', hsl: '334 82% 66%' },
  { id: 'purple', name: 'Purple', hsl: '266 78% 68%' },

  // Deep, for a light chat.
  { id: 'navy', name: 'Navy', hsl: '218 76% 34%' },
  { id: 'forest', name: 'Forest', hsl: '152 56% 26%' },
  { id: 'crimson', name: 'Crimson', hsl: '352 70% 38%' },
  { id: 'rust', name: 'Rust', hsl: '18 74% 38%' },
  { id: 'plum', name: 'Plum', hsl: '284 48% 34%' },
];

export const WALLPAPER_DIM_MAX = 80;
export const WALLPAPER_BLUR_MAX = 40;
export const GLASS_BLUR_MIN = 4;
export const GLASS_BLUR_MAX = 64;

export const TYPEFACES = [
  { id: 'inter', name: 'Inter', stack: "'Inter', ui-sans-serif, system-ui, sans-serif" },
  { id: 'system', name: 'System', stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" },
  { id: 'montserrat', name: 'Montserrat', stack: "'Montserrat', ui-sans-serif, system-ui, sans-serif" },
  { id: 'serif', name: 'Serif', stack: "'Iowan Old Style', Georgia, 'Times New Roman', serif" },
  { id: 'mono', name: 'Mono', stack: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace" },
];

export const ACCENT_CUSTOM_ID = 'custom';
export const CUSTOM_ACCENT_HUE_DEFAULT = 268;
export const CUSTOM_INK_HUE_DEFAULT = 212;

// 40px matches the --lg-blur-* the app ships with.
export const DEFAULT_APPEARANCE = {
  accent: 'ocean',
  accentHue: CUSTOM_ACCENT_HUE_DEFAULT,
  chatUserTextColor: INK_DEFAULT_ID,
  chatUserTextHue: CUSTOM_INK_HUE_DEFAULT,
  chatAiTextColor: INK_DEFAULT_ID,
  chatAiTextHue: CUSTOM_INK_HUE_DEFAULT,
  chatBubbleColor: INK_DEFAULT_ID,
  chatBubbleHue: CUSTOM_INK_HUE_DEFAULT,
  typeface: 'inter',
  // 45 with the light multiplier below reproduces the scrim the Home desktop
  // shipped with, so an untouched install looks unchanged.
  wallpaperDim: 45,
  wallpaperBlur: 0,
  glassBlur: 40,
  reduceMotion: false,
  highContrast: false,
  rowDividers: true,
  largeSidebarIcons: false,
};

/** The hand-picked hue reads as a real swatch so every consumer can treat
 *  custom accents like the built-in ones. */
export function customAccent(hue) {
  const h = clampHue(hue);
  return { id: ACCENT_CUSTOM_ID, name: 'Custom', hsl: `${h} 72% 56%`, hue: h };
}

export function accentById(id, hue) {
  if (id === ACCENT_CUSTOM_ID) return customAccent(hue);
  return ACCENTS.find((a) => a.id === id) || ACCENTS.find((a) => a.id === DEFAULT_APPEARANCE.accent);
}

export function inkById(id, hue) {
  if (id === INK_CUSTOM_ID) {
    return { id: INK_CUSTOM_ID, name: 'Custom', hsl: `${clampHue(hue)} 80% 58%` };
  }
  return INKS.find((i) => i.id === id) || INKS[0];
}

/** The color a preset resolves to, empty for Default (which is the theme's own
 *  ink — black or white — and so has nothing to override). */
export function inkColor(ink, appearance = {}) {
  if (!ink || ink.id === INK_DEFAULT_ID) return '';
  if (ink.accentDerived) return accentById(appearance.accent, appearance.accentHue).hsl;
  return ink.hsl || '';
}

/** Black or white, whichever stays legible on top of an ink. Mirrors the
 *  --lykn-accent-fg rule so a tinted bubble is never unreadable. */
export function readableInkOn(hsl) {
  const lightness = Number(String(hsl).split(' ')[2]?.replace('%', ''));
  return Number.isFinite(lightness) && lightness > 62 ? '0 0% 12%' : '0 0% 100%';
}

export function typefaceById(id) {
  return TYPEFACES.find((t) => t.id === id) || TYPEFACES[0];
}

/** CSS background for a swatch chip / accent fill. */
export function accentSwatchBackground(accent) {
  if (accent?.iridescent) {
    return 'conic-gradient(from 210deg, #7cd4ff, #b69cff, #ff9ecb, #ffd280, #7fe3ad, #7cd4ff)';
  }
  return `hsl(${accent?.hsl || DEFAULT_APPEARANCE.accent})`;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampHue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CUSTOM_ACCENT_HUE_DEFAULT;
  return ((Math.round(n) % 360) + 360) % 360;
}

/** A stored ink id, or null when it's missing or no longer in the palette. */
function inkIdOrNull(value) {
  if (value === INK_CUSTOM_ID || INKS.some((i) => i.id === value)) return value;
  return null;
}

export function normalizeAppearance(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const accent =
    source.accent === ACCENT_CUSTOM_ID || ACCENTS.some((a) => a.id === source.accent)
      ? source.accent
      : DEFAULT_APPEARANCE.accent;

  // Installs from before the split stored one ink for the whole transcript;
  // hand it to both sides so nobody's chat changes color on upgrade.
  const legacyInk = inkIdOrNull(source.chatTextColor);
  const legacyHue = source.chatTextHue;
  const chatUserTextColor =
    inkIdOrNull(source.chatUserTextColor) ?? legacyInk ?? DEFAULT_APPEARANCE.chatUserTextColor;
  const chatAiTextColor =
    inkIdOrNull(source.chatAiTextColor) ?? legacyInk ?? DEFAULT_APPEARANCE.chatAiTextColor;
  const chatBubbleColor = inkIdOrNull(source.chatBubbleColor) ?? DEFAULT_APPEARANCE.chatBubbleColor;

  return {
    accent,
    accentHue: clampHue(source.accentHue ?? DEFAULT_APPEARANCE.accentHue),
    chatUserTextColor,
    chatUserTextHue: clampHue(
      source.chatUserTextHue ?? legacyHue ?? DEFAULT_APPEARANCE.chatUserTextHue,
    ),
    chatAiTextColor,
    chatAiTextHue: clampHue(source.chatAiTextHue ?? legacyHue ?? DEFAULT_APPEARANCE.chatAiTextHue),
    chatBubbleColor,
    chatBubbleHue: clampHue(source.chatBubbleHue ?? DEFAULT_APPEARANCE.chatBubbleHue),
    typeface: TYPEFACES.some((t) => t.id === source.typeface) ? source.typeface : DEFAULT_APPEARANCE.typeface,
    wallpaperDim: clampNumber(source.wallpaperDim, 0, WALLPAPER_DIM_MAX, DEFAULT_APPEARANCE.wallpaperDim),
    wallpaperBlur: clampNumber(source.wallpaperBlur, 0, WALLPAPER_BLUR_MAX, DEFAULT_APPEARANCE.wallpaperBlur),
    glassBlur: clampNumber(source.glassBlur, GLASS_BLUR_MIN, GLASS_BLUR_MAX, DEFAULT_APPEARANCE.glassBlur),
    reduceMotion: !!source.reduceMotion,
    highContrast: !!source.highContrast,
    rowDividers: source.rowDividers === undefined ? DEFAULT_APPEARANCE.rowDividers : !!source.rowDividers,
    largeSidebarIcons: !!source.largeSidebarIcons,
  };
}

export function readAppearance() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return normalizeAppearance(saved.appearance);
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

/**
 * Paint the tokens onto <html>, where every surface in the app can read them —
 * an appearance choice that only restyled the settings window would be a lie.
 */
export function applyAppearance(raw) {
  if (typeof document === 'undefined') return;
  const appearance = normalizeAppearance(raw);
  const root = document.documentElement;
  const accent = accentById(appearance.accent, appearance.accentHue);

  root.style.setProperty('--lykn-accent', accent.hsl);
  // Bare hue, so gradients can derive an analogous second color with calc().
  root.style.setProperty('--lykn-accent-h', accent.hsl.split(' ')[0]);
  root.style.setProperty('--lykn-accent-fg', Number(accent.hsl.split(' ')[2]?.replace('%', '')) > 62 ? '0 0% 12%' : '0 0% 100%');
  root.style.setProperty('--lykn-accent-swatch', accentSwatchBackground(accent));
  root.style.setProperty('--lykn-font-body', typefaceById(appearance.typeface).stack);

  // Chat ink. Published at the root because that's where the flag and the color
  // can live together, but inert until a `.lykn-chat-ink` surface picks it up
  // (index.css) — which is what keeps this out of the rest of the app.
  const aiInk = inkColor(inkById(appearance.chatAiTextColor, appearance.chatAiTextHue), appearance);
  root.style.setProperty('--lykn-chat-ink', aiInk || '0 0% 0%');
  root.dataset.chatInk = aiInk ? 'on' : 'off';

  // The user's bubble carves itself back out of that surface, so its words and
  // its fill are chosen separately from LYKN's.
  const userInk = inkColor(
    inkById(appearance.chatUserTextColor, appearance.chatUserTextHue),
    appearance,
  );
  const bubble = inkColor(inkById(appearance.chatBubbleColor, appearance.chatBubbleHue), appearance);
  // A tinted bubble with the ink left at Default would otherwise keep the
  // theme's black or white and could land invisible on its own fill.
  const bubbleInk = userInk || (bubble ? readableInkOn(bubble) : '');
  root.style.setProperty('--lykn-chat-ink-user-light', bubbleInk || '0 0% 0%');
  root.style.setProperty('--lykn-chat-ink-user-dark', bubbleInk || '0 0% 100%');
  root.style.setProperty('--lykn-chat-bubble', bubble || '0 0% 100%');
  root.dataset.chatInkUser = userInk ? 'on' : 'off';
  root.dataset.chatBubble = bubble ? 'on' : 'off';

  // Wallpaper knobs, for surfaces that would rather read a token than the
  // appearance blob. The Home desktop draws from the blob directly.
  root.style.setProperty('--lykn-wallpaper-dim', String(appearance.wallpaperDim / 100));
  root.style.setProperty('--lykn-wallpaper-blur', `${appearance.wallpaperBlur}px`);

  // Glass depth — every frosted layer in index.css blurs through these.
  root.style.setProperty('--lg-blur-tip', `${appearance.glassBlur}px`);
  root.style.setProperty('--lg-blur-menu', `${appearance.glassBlur}px`);
  root.style.setProperty('--lg-blur-window', `${appearance.glassBlur}px`);

  root.dataset.accent = appearance.accent;
  root.dataset.reduceMotion = appearance.reduceMotion ? 'true' : 'false';
  root.dataset.contrast = appearance.highContrast ? 'high' : 'normal';
  root.dataset.rowDividers = appearance.rowDividers ? 'on' : 'off';
  root.dataset.sidebarIcons = appearance.largeSidebarIcons ? 'large' : 'regular';

  return appearance;
}

/** Merge a partial change into the stored blob, apply it, and notify listeners. */
export function saveAppearance(patch) {
  let next = { ...DEFAULT_APPEARANCE };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    next = normalizeAppearance({ ...normalizeAppearance(saved.appearance), ...patch });
    const blob = { ...saved, appearance: next };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    next = normalizeAppearance(patch);
  }
  applyAppearance(next);
  window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
  return next;
}

/** Back to the shipped look, leaving the rest of the settings blob alone. */
export function resetAppearance() {
  return saveAppearance({ ...DEFAULT_APPEARANCE });
}

/** Follow appearance edits from anywhere — this pane, another window, or a
 *  reset. Returns the unsubscribe. */
export function subscribeAppearance(onChange) {
  if (typeof window === 'undefined') return () => {};
  const sync = () => onChange(readAppearance());
  window.addEventListener('lykinsai_settings_changed', sync);
  window.addEventListener('storage', sync);
  return () => {
    window.removeEventListener('lykinsai_settings_changed', sync);
    window.removeEventListener('storage', sync);
  };
}
