/**
 * Welcome walkthrough design picks — theme, accent, response length, and
 * chat inks. The splash stores them on the welcome profile; the studio
 * (loading behind it) applies them once into `lykinsai_settings` so Settings
 * and chat read the same values.
 */

import { useEffect } from 'react';

import {
  ACCENTS,
  CHAT_BAR_SHAPES,
  CHAT_BAR_SIZES,
  CHAT_BUBBLE_SHAPES,
  CHAT_SEND_ICONS,
  CHAT_SEND_SHAPES,
  CHAT_TEXT_SIZES,
  INKS,
  applyAppearance,
  normalizeAppearance,
} from '@/lib/appearance';
import { applyTheme, normalizeTheme } from '@/lib/theme';

const STORAGE_KEY = 'lykinsai_settings';
const STAMP_KEY = 'lykn_welcome_design_stamp';
const RESPONSE_LENGTHS = new Set(['concise', 'medium', 'detailed']);
const ACCENT_IDS = new Set(ACCENTS.map((accent) => accent.id));
const INK_IDS = new Set(INKS.map((ink) => ink.id));
const TEXT_SIZE_IDS = new Set(CHAT_TEXT_SIZES.map((item) => item.id));
const BAR_SIZE_IDS = new Set(CHAT_BAR_SIZES.map((item) => item.id));
const BAR_SHAPE_IDS = new Set(CHAT_BAR_SHAPES.map((item) => item.id));
const BUBBLE_SHAPE_IDS = new Set(CHAT_BUBBLE_SHAPES.map((item) => item.id));
const SEND_ICON_IDS = new Set(CHAT_SEND_ICONS.map((item) => item.id));
const SEND_SHAPE_IDS = new Set(CHAT_SEND_SHAPES.map((item) => item.id));

/** Map the walkthrough's appearance pick onto Settings' theme ids. */
export function welcomeAppearanceToTheme(value) {
  if (value === 'auto') return 'system';
  return normalizeTheme(value);
}

export function sanitizeWelcomeDesignPrefs(raw = {}) {
  const prefs = raw && typeof raw === 'object' ? raw : {};
  const next = {};

  if (ACCENT_IDS.has(prefs.accent)) next.accent = prefs.accent;
  if (['dark', 'light', 'system', 'auto'].includes(prefs.appearance)) {
    next.appearance = welcomeAppearanceToTheme(prefs.appearance);
  }
  if (RESPONSE_LENGTHS.has(prefs.responseLength)) next.responseLength = prefs.responseLength;
  if (typeof prefs.userPrompt === 'string') next.userPrompt = prefs.userPrompt.slice(0, 1500);
  if (INK_IDS.has(prefs.chatUserTextColor)) next.chatUserTextColor = prefs.chatUserTextColor;
  if (INK_IDS.has(prefs.chatBubbleColor)) next.chatBubbleColor = prefs.chatBubbleColor;
  if (INK_IDS.has(prefs.chatAiTextColor)) next.chatAiTextColor = prefs.chatAiTextColor;
  if (TEXT_SIZE_IDS.has(prefs.chatUserTextSize)) next.chatUserTextSize = prefs.chatUserTextSize;
  if (TEXT_SIZE_IDS.has(prefs.chatAiTextSize)) next.chatAiTextSize = prefs.chatAiTextSize;
  if (BAR_SIZE_IDS.has(prefs.chatBarSize)) next.chatBarSize = prefs.chatBarSize;
  if (BUBBLE_SHAPE_IDS.has(prefs.chatBubbleShape)) next.chatBubbleShape = prefs.chatBubbleShape;
  if (BAR_SHAPE_IDS.has(prefs.chatBarShape)) next.chatBarShape = prefs.chatBarShape;
  if (SEND_ICON_IDS.has(prefs.chatSendIcon)) next.chatSendIcon = prefs.chatSendIcon;
  if (SEND_SHAPE_IDS.has(prefs.chatSendShape)) next.chatSendShape = prefs.chatSendShape;

  return next;
}

function readSettingsBlob() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/** Write sanitized walkthrough picks into the same blob Settings uses. */
export function applyWelcomeDesignPrefs(raw) {
  const prefs = sanitizeWelcomeDesignPrefs(raw);
  if (!Object.keys(prefs).length) return null;

  const saved = readSettingsBlob();
  const appearancePatch = {};
  if (prefs.accent) appearancePatch.accent = prefs.accent;
  if (prefs.chatUserTextColor) appearancePatch.chatUserTextColor = prefs.chatUserTextColor;
  if (prefs.chatBubbleColor) appearancePatch.chatBubbleColor = prefs.chatBubbleColor;
  if (prefs.chatAiTextColor) appearancePatch.chatAiTextColor = prefs.chatAiTextColor;
  if (prefs.chatUserTextSize) appearancePatch.chatUserTextSize = prefs.chatUserTextSize;
  if (prefs.chatAiTextSize) appearancePatch.chatAiTextSize = prefs.chatAiTextSize;
  if (prefs.chatBarSize) appearancePatch.chatBarSize = prefs.chatBarSize;
  if (prefs.chatBubbleShape) appearancePatch.chatBubbleShape = prefs.chatBubbleShape;
  if (prefs.chatBarShape) appearancePatch.chatBarShape = prefs.chatBarShape;
  if (prefs.chatSendIcon) appearancePatch.chatSendIcon = prefs.chatSendIcon;
  if (prefs.chatSendShape) appearancePatch.chatSendShape = prefs.chatSendShape;

  const appearance = normalizeAppearance({
    ...normalizeAppearance(saved.appearance),
    ...appearancePatch,
  });

  const blob = {
    ...saved,
    appearance,
  };
  if (prefs.appearance) blob.theme = prefs.appearance;
  if (prefs.responseLength) blob.responseLength = prefs.responseLength;
  if (typeof prefs.userPrompt === 'string') blob.userPrompt = prefs.userPrompt;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* picks just won't survive a reload */
  }

  if (blob.theme) applyTheme(blob.theme);
  applyAppearance(appearance);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lykinsai_settings_changed'));
    window.dispatchEvent(new Event('storage'));
  }
  return blob;
}

/**
 * Pull the welcome walkthrough's design picks into settings (desktop app
 * only). The studio loads behind the walkthrough, so this both listens for
 * the live pick and reads whatever was stored before it mounted.
 */
export function useWelcomeDesignSync() {
  useEffect(() => {
    const apply = (payload) => {
      const stamp = Number(payload?.stamp) || 0;
      if (!stamp || !payload?.prefs) return;
      try {
        const applied = Number(localStorage.getItem(STAMP_KEY)) || 0;
        if (applied >= stamp) return;
        localStorage.setItem(STAMP_KEY, String(stamp));
      } catch {
        return;
      }
      applyWelcomeDesignPrefs(payload.prefs);
    };
    window.lykn?.welcomeDesignGet?.().then(apply).catch(() => {});
    return window.lykn?.onWelcomeDesignChanged?.(apply);
  }, []);
}
