import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODELS_DEV_LOGO_PREFIX,
  listPublicMarketingModels,
  logoUrlForProvider,
} from './publicCatalog.js';

test('lab logos resolve to the models.dev host', () => {
  assert.equal(logoUrlForProvider('openai'), `${MODELS_DEV_LOGO_PREFIX}openai.svg`);
  assert.equal(logoUrlForProvider('google'), `${MODELS_DEV_LOGO_PREFIX}gemini.svg`);
  assert.equal(logoUrlForProvider('x-ai'), `${MODELS_DEV_LOGO_PREFIX}xai.svg`);
  assert.equal(logoUrlForProvider('meta-llama'), `${MODELS_DEV_LOGO_PREFIX}meta.svg`);
  assert.equal(logoUrlForProvider('../evil'), null);
});

test('public marketing catalog is names and logos only', () => {
  const { models } = listPublicMarketingModels();
  assert.ok(models.length >= 8);
  assert.ok(models.some((m) => m.name === 'GPT-5.6 Sol'));
  assert.ok(models.some((m) => m.name === 'Claude Fable 5'));
  assert.ok(models.some((m) => /DeepSeek|Llama|Mistral|Qwen/.test(m.name)));
  const ids = models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const model of models) {
    assert.equal(typeof model.id, 'string');
    assert.equal(typeof model.name, 'string');
    assert.ok(model.logoUrl.startsWith(MODELS_DEV_LOGO_PREFIX));
    assert.ok(model.logoUrl.endsWith('.svg'));
    assert.equal('pricing' in model, false);
    assert.equal('capabilities' in model, false);
    assert.equal('provider' in model, false);
  }
});

test('public marketing catalog respects a tight limit', () => {
  const { models } = listPublicMarketingModels({ limit: 6 });
  assert.equal(models.length, 6);
});
