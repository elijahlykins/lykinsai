/**
 * Appearance tokens — the Settings › Appearance pane writes here and every
 * surface reads the resulting CSS variables. Values live inside the existing
 * `lykinsai_settings` blob under `appearance` so nothing that already reads
 * that key (theme, fontSize) changes shape.
 */

const STORAGE_KEY = 'lykinsai_settings';

/** Accent swatches, in the order they render in the pane. */
export const ACCENTS = [
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

/**
 * Chat sizing and geometry — the rest of Settings › Appearance › AI chat.
 *
 * Each list leads with the size or shape the app shipped with, so "Default"
 * is a real entry rather than an absence, and applyAppearance() can hold the
 * corresponding CSS off entirely while it's selected. That's what keeps an
 * untouched install pixel-identical to what it had before these existed.
 *
 * The numbers are absolute px rather than multipliers because the chat's own
 * type is written in px; the app-wide `fontSize` scale still rides on top.
 */
export const CHAT_TEXT_SIZES = [
  { id: 'small', name: 'Small', px: 12.5 },
  { id: 'default', name: 'Default', px: 14 },
  { id: 'large', name: 'Large', px: 17 },
  // Largest is the accessibility end of the scale, not one more nudge — it's
  // meant to be readable across the room, so it steps well clear of Large.
  { id: 'xlarge', name: 'Largest', px: 25 },
];

/**
 * `minH` is the composer's floor in px — the empty bar's height before the
 * textarea grows. `padHome` is the Home desktop pill, which is a single row
 * and so wants far less breathing room than the page's stacked composer.
 */
export const CHAT_BAR_SIZES = [
  { id: 'small', name: 'Small', font: 11, pad: 8, padHome: 3, minH: 44 },
  { id: 'default', name: 'Default', font: 12, pad: 12, padHome: 6, minH: 52 },
  { id: 'large', name: 'Large', font: 14, pad: 15, padHome: 9, minH: 62 },
  { id: 'xlarge', name: 'Largest', font: 16.5, pad: 18, padHome: 12, minH: 72 },
];

/**
 * The composer's geometry. `radius` is worn by both the page composer and the
 * Home pill; the rest applies to the page composer, which is the only one with
 * a toolbar row under the field to give room to.
 *
 * Two of these are more than a corner. Rectangle carries a skin (see
 * index.css) — flat glass behind a single hairline instead of the raised
 * neumorphic shell, which is what makes it read as a box rather than a slab.
 * Slate keeps the shell and grows it: a deep radius over a tall, roomy field,
 * for people who write more than a line at a time.
 *
 * `chipRadius` is what the settings picker draws instead of the live radius.
 * Default's chip is a pill because that's the Home bar at rest — the page
 * composer stays 14px, but a 14px chip next to Rectangle's 10px is a wash.
 * Slate's chip is generously rounded and tall, not the 11px box that used
 * to make it look like Rectangle.
 */
export const CHAT_BAR_SHAPES = [
  { id: 'soft', name: 'Default', radius: '14px', chipRadius: '9999px' },
  { id: 'rectangle', name: 'Rectangle', radius: '10px', chipRadius: '5px' },
  { id: 'slate', name: 'Slate', radius: '28px', chipRadius: '16px', pad: 18, minH: 104 },
  { id: 'leaf', name: 'Leaf', radius: '22px 6px 22px 6px' },
];

/** The shipped bubble is a 15px box with its bottom-right corner pulled in to
 *  4px — the notch that points the message back at the person who sent it. */
export const CHAT_BUBBLE_SHAPES = [
  { id: 'tail', name: 'Default', radius: '15px 15px 4px 15px' },
  { id: 'round', name: 'Rounded', radius: '16px' },
  { id: 'pill', name: 'Pill', radius: '9999px' },
  { id: 'rectangle', name: 'Rectangle', radius: '0px' },
  { id: 'leaf', name: 'Leaf', radius: '18px 4px 18px 4px' },
];

/**
 * The send button's glyph. Only the ids and names live here — the token module
 * has no business importing components — and `sendGlyph` in lib/chatSendIcon
 * maps each id to the icon that draws it.
 */
export const CHAT_SEND_ICONS = [
  { id: 'arrow', name: 'Arrow' },
  { id: 'arrowRight', name: 'Forward' },
  { id: 'plane', name: 'Plane' },
  { id: 'return', name: 'Return' },
  { id: 'chevron', name: 'Chevron' },
  { id: 'sparkle', name: 'Sparkle' },
];

/**
 * The button the glyph sits in. The two chat bars disagree at rest — the page
 * composer is a 10px block, the Home pill is a circle — so Default is the one
 * entry that paints nothing and lets each keep its own. Every other choice is
 * a radius both of them wear, which is the only way to make the two match.
 *
 * The chips are square, so a percentage radius is a squircle rather than the
 * ellipse it would be on the wider bar/bubble chips.
 */
export const CHAT_SEND_SHAPES = [
  { id: 'default', name: 'Default', chipRadius: '10px' },
  { id: 'circle', name: 'Circle', radius: '9999px' },
  { id: 'squircle', name: 'Squircle', radius: '32%' },
  { id: 'rounded', name: 'Rounded', radius: '10px' },
  { id: 'square', name: 'Square', radius: '4px' },
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
  chatUserTextSize: 'default',
  chatAiTextSize: 'default',
  chatBarSize: 'default',
  chatBubbleShape: 'tail',
  chatBarShape: 'soft',
  chatSendIcon: 'arrow',
  chatSendShape: 'default',
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

/** 'custom' once a preset stops matching the shipped one — the switch every
 *  chat size/shape rule in index.css hangs off. */
function flagFor(id, defaultId) {
  return id === defaultId ? 'default' : 'custom';
}

/** Look one preset up, falling back to whichever entry the app ships with. */
function presetById(list, id, fallbackId) {
  return list.find((p) => p.id === id) || list.find((p) => p.id === fallbackId) || list[0];
}

export function chatTextSizeById(id) {
  return presetById(CHAT_TEXT_SIZES, id, DEFAULT_APPEARANCE.chatAiTextSize);
}

export function chatBarSizeById(id) {
  return presetById(CHAT_BAR_SIZES, id, DEFAULT_APPEARANCE.chatBarSize);
}

export function chatBarShapeById(id) {
  return presetById(CHAT_BAR_SHAPES, id, DEFAULT_APPEARANCE.chatBarShape);
}

export function chatBubbleShapeById(id) {
  return presetById(CHAT_BUBBLE_SHAPES, id, DEFAULT_APPEARANCE.chatBubbleShape);
}

export function chatSendIconById(id) {
  return presetById(CHAT_SEND_ICONS, id, DEFAULT_APPEARANCE.chatSendIcon);
}

export function chatSendShapeById(id) {
  return presetById(CHAT_SEND_SHAPES, id, DEFAULT_APPEARANCE.chatSendShape);
}

/**
 * The composer's height floor in px — also what its auto-grow measures
 * against, which is why this is the one part of the bar's geometry that can't
 * be a CSS token.
 *
 * The size preset sets it, except at the shipped size, where `fallback` (the
 * caller's own `composerMinH`) still has the say. A shape that asks for a
 * roomier bar raises that floor rather than replacing it, so Slate stays tall
 * even at Small, and a size taller than the shape would still win.
 */
export function chatBarMinHeight(appearance, fallback) {
  const { chatBarSize, chatBarShape } = normalizeAppearance(appearance);
  const size = chatBarSizeById(chatBarSize);
  const shape = chatBarShapeById(chatBarShape);
  const base =
    size.id === DEFAULT_APPEARANCE.chatBarSize && Number.isFinite(fallback) ? fallback : size.minH;
  return Math.max(base, shape.minH || 0);
}

/** CSS background for a swatch chip / accent fill. */
export function accentSwatchBackground(accent) {
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

/** A stored preset id, or the shipped default when it's missing or retired. */
function presetIdOrDefault(list, value, fallbackId) {
  return list.some((p) => p.id === value) ? value : fallbackId;
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
    chatUserTextSize: presetIdOrDefault(
      CHAT_TEXT_SIZES,
      source.chatUserTextSize,
      DEFAULT_APPEARANCE.chatUserTextSize,
    ),
    chatAiTextSize: presetIdOrDefault(
      CHAT_TEXT_SIZES,
      source.chatAiTextSize,
      DEFAULT_APPEARANCE.chatAiTextSize,
    ),
    chatBarSize: presetIdOrDefault(CHAT_BAR_SIZES, source.chatBarSize, DEFAULT_APPEARANCE.chatBarSize),
    chatBubbleShape: presetIdOrDefault(
      CHAT_BUBBLE_SHAPES,
      source.chatBubbleShape,
      DEFAULT_APPEARANCE.chatBubbleShape,
    ),
    chatBarShape: presetIdOrDefault(
      CHAT_BAR_SHAPES,
      source.chatBarShape,
      DEFAULT_APPEARANCE.chatBarShape,
    ),
    chatSendIcon: presetIdOrDefault(
      CHAT_SEND_ICONS,
      source.chatSendIcon,
      DEFAULT_APPEARANCE.chatSendIcon,
    ),
    chatSendShape: presetIdOrDefault(
      CHAT_SEND_SHAPES,
      source.chatSendShape,
      DEFAULT_APPEARANCE.chatSendShape,
    ),
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

  // Chat sizing and geometry. The tokens are always published so the settings
  // preview can read them, but each flag stays 'default' until the choice
  // actually differs from the shipped one — and index.css only overrides the
  // chat's own sizes and radii while a flag reads 'custom'.
  const userSize = chatTextSizeById(appearance.chatUserTextSize);
  const aiSize = chatTextSizeById(appearance.chatAiTextSize);
  const barSize = chatBarSizeById(appearance.chatBarSize);
  const bubbleShape = chatBubbleShapeById(appearance.chatBubbleShape);
  const barShape = chatBarShapeById(appearance.chatBarShape);
  const sendShape = chatSendShapeById(appearance.chatSendShape);

  root.style.setProperty('--lykn-chat-user-size', `${userSize.px}px`);
  root.style.setProperty('--lykn-chat-ai-size', `${aiSize.px}px`);
  root.style.setProperty('--lykn-chat-bar-font', `${barSize.font}px`);
  // A roomy shape and a large size both want a padded shell; the more generous
  // of the two wins so neither has to know about the other.
  root.style.setProperty('--lykn-chat-bar-pad', `${Math.max(barSize.pad, barShape.pad || 0)}px`);
  root.style.setProperty('--lykn-chat-bar-pad-home', `${barSize.padHome}px`);
  root.style.setProperty('--lykn-chat-bar-min-h', `${barSize.minH}px`);
  root.style.setProperty('--lykn-chat-bubble-radius', bubbleShape.radius);
  root.style.setProperty('--lykn-chat-bar-radius', barShape.radius);
  // Default carries no radius of its own — the flag below holds the CSS off
  // entirely — so the fallback here is only ever read by the settings preview.
  root.style.setProperty('--lykn-chat-send-radius', sendShape.radius || '10px');

  // Sizes publish a flag, because all a size does is carry numbers and the CSS
  // only needs to know whether to read them. Shapes publish their id instead:
  // a shape can bring a whole skin along, not just a radius — Rectangle
  // restores the old chat page's bar — so the stylesheet has to know which.
  root.dataset.chatUserSize = flagFor(userSize.id, DEFAULT_APPEARANCE.chatUserTextSize);
  root.dataset.chatAiSize = flagFor(aiSize.id, DEFAULT_APPEARANCE.chatAiTextSize);
  root.dataset.chatBarSize = flagFor(barSize.id, DEFAULT_APPEARANCE.chatBarSize);
  root.dataset.chatBubbleShape = bubbleShape.id;
  root.dataset.chatBarShape = barShape.id;
  root.dataset.chatSendShape = sendShape.id;

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
