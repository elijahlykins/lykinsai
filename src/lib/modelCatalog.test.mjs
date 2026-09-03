import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FRONTIER_ANTHROPIC_ID,
  FRONTIER_GOOGLE_ID,
  FRONTIER_OPENAI_ID,
  FRONTIER_XAI_ID,
  KNOWN_MODEL_IDS,
  LYKN_ID,
  MODEL_GROUPS,
} from './modelCatalog.js';
import {
  canonicalizeModelId,
  isModelAllowedForPlan,
} from './modelTiers.js';

test('picker ids are unique across groups', () => {
  const values = MODEL_GROUPS.flatMap((group) => group.items.map((item) => item.value));
  assert.equal(new Set(values).size, values.length);
});

test('top models are the current flagships', () => {
  const top = MODEL_GROUPS.find((group) => group.id === 'frontier');
  assert.deepEqual(top.items.map((item) => item.value), [
    FRONTIER_OPENAI_ID,
    FRONTIER_ANTHROPIC_ID,
    FRONTIER_GOOGLE_ID,
    FRONTIER_XAI_ID,
  ]);
  assert.equal(FRONTIER_OPENAI_ID, 'gpt-5.6-sol');
  assert.equal(FRONTIER_ANTHROPIC_ID, 'claude-fable-5');
  assert.equal(FRONTIER_GOOGLE_ID, 'gemini-3.1-pro-preview');
  assert.equal(FRONTIER_XAI_ID, 'grok-4.6');
});

test('company groups cover still-served models', () => {
  const byId = Object.fromEntries(MODEL_GROUPS.map((group) => [group.id, group]));
  assert.ok(byId.openai.items.some((item) => item.value === 'gpt-5.6-terra'));
  assert.ok(byId.anthropic.items.some((item) => item.value === 'claude-opus-5'));
  assert.ok(byId.google.items.some((item) => item.value === 'gemini-3.6-flash'));
  assert.ok(byId.xai.items.some((item) => item.value === 'grok-4.5'));
});

test('saved still-served ids stay themselves', () => {
  assert.equal(canonicalizeModelId('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.equal(canonicalizeModelId('grok-4.5'), 'grok-4.5');
  assert.equal(canonicalizeModelId('gpt-5.5'), 'gpt-5.5');
  assert.equal(canonicalizeModelId('lykn-deep'), LYKN_ID);
});

test('free plans stay on LYKN; Pro can pick any catalog model', () => {
  assert.equal(isModelAllowedForPlan(LYKN_ID, 'basic'), true);
  assert.equal(isModelAllowedForPlan(FRONTIER_XAI_ID, 'basic'), false);
  assert.equal(isModelAllowedForPlan(FRONTIER_ANTHROPIC_ID, 'top'), true);
  assert.equal(isModelAllowedForPlan('gpt-4.1-nano', 'top+media'), true);
  assert.ok(KNOWN_MODEL_IDS.includes(FRONTIER_XAI_ID));
});
