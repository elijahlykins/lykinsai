import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyWelcomeDesignPrefs,
  sanitizeWelcomeDesignPrefs,
  welcomeAppearanceToTheme,
} from '@/lib/welcomeDesignPrefs';

test('welcomeAppearanceToTheme maps auto to Settings system', () => {
  assert.equal(welcomeAppearanceToTheme('auto'), 'system');
  assert.equal(welcomeAppearanceToTheme('dark'), 'dark');
  assert.equal(welcomeAppearanceToTheme('light'), 'light');
  assert.equal(welcomeAppearanceToTheme('system'), 'system');
});

test('sanitizeWelcomeDesignPrefs keeps Settings ids and drops unknown values', () => {
  const clean = sanitizeWelcomeDesignPrefs({
    accent: 'orchid',
    appearance: 'auto',
    responseLength: 'concise',
    userPrompt: 'Be direct.',
    chatUserTextColor: 'pink',
    chatBubbleColor: 'navy',
    chatAiTextColor: 'default',
    chatUserTextSize: 'large',
    chatAiTextSize: 'small',
    chatBarSize: 'xlarge',
    chatBubbleShape: 'pill',
    chatBarShape: 'slate',
    chatSendIcon: 'plane',
    chatSendShape: 'circle',
    tabLayout: 'sidebar',
    startView: 'chat',
  });
  assert.deepEqual(clean, {
    accent: 'orchid',
    appearance: 'system',
    responseLength: 'concise',
    userPrompt: 'Be direct.',
    chatUserTextColor: 'pink',
    chatBubbleColor: 'navy',
    chatAiTextColor: 'default',
    chatUserTextSize: 'large',
    chatAiTextSize: 'small',
    chatBarSize: 'xlarge',
    chatBubbleShape: 'pill',
    chatBarShape: 'slate',
    chatSendIcon: 'plane',
    chatSendShape: 'circle',
  });
});

test('sanitizeWelcomeDesignPrefs ignores hex accents and bad inks', () => {
  const clean = sanitizeWelcomeDesignPrefs({
    accent: '#0e6fff',
    appearance: 'midnight',
    responseLength: 'long',
    chatUserTextColor: 'hotpink',
    chatBubbleColor: 'custom',
  });
  assert.deepEqual(clean, {});
});

test('sanitizeWelcomeDesignPrefs drops the retired aurora accent', () => {
  const clean = sanitizeWelcomeDesignPrefs({ accent: 'aurora' });
  assert.deepEqual(clean, {});
});

test('applyWelcomeDesignPrefs writes the same keys Settings reads', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  globalThis.document = {
    documentElement: {
      style: { setProperty() {} },
      classList: { toggle() {} },
      dataset: {},
    },
  };
  globalThis.window = {
    dispatchEvent() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, addListener() {} }),
  };

  const blob = applyWelcomeDesignPrefs({
    accent: 'ocean',
    appearance: 'dark',
    responseLength: 'detailed',
    userPrompt: 'Skip the preamble.',
    chatUserTextColor: 'white',
    chatBubbleColor: 'blue',
    chatAiTextColor: 'silver',
    chatUserTextSize: 'large',
    chatAiTextSize: 'xlarge',
    chatBarSize: 'small',
    chatBubbleShape: 'leaf',
    chatBarShape: 'rectangle',
    chatSendIcon: 'sparkle',
    chatSendShape: 'square',
  });

  assert.equal(blob.theme, 'dark');
  assert.equal(blob.responseLength, 'detailed');
  assert.equal(blob.userPrompt, 'Skip the preamble.');
  assert.equal(blob.appearance.accent, 'ocean');
  assert.equal(blob.appearance.chatUserTextColor, 'white');
  assert.equal(blob.appearance.chatBubbleColor, 'blue');
  assert.equal(blob.appearance.chatAiTextColor, 'silver');
  assert.equal(blob.appearance.chatUserTextSize, 'large');
  assert.equal(blob.appearance.chatAiTextSize, 'xlarge');
  assert.equal(blob.appearance.chatBarSize, 'small');
  assert.equal(blob.appearance.chatBubbleShape, 'leaf');
  assert.equal(blob.appearance.chatBarShape, 'rectangle');
  assert.equal(blob.appearance.chatSendIcon, 'sparkle');
  assert.equal(blob.appearance.chatSendShape, 'square');

  const saved = JSON.parse(store.get('lykinsai_settings'));
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.appearance.accent, 'ocean');
});
