'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  needsLiveFreshnessSearch,
  hasExplicitWebSearchIntent,
  shouldForceWebSearch,
} = require('./webSearchIntent.cjs');

test('explicit search verbs still match', () => {
  assert.equal(hasExplicitWebSearchIntent('search the web for GPT-5.6 Terra pricing'), true);
  assert.equal(hasExplicitWebSearchIntent('google the weather in Austin'), true);
  assert.equal(hasExplicitWebSearchIntent('look this up online'), true);
  assert.equal(hasExplicitWebSearchIntent('make a chart comparing models'), false);
});

test('AI model landscape asks need freshness', () => {
  assert.equal(
    needsLiveFreshnessSearch('build a chart comparing all the AI models'),
    true,
  );
  assert.equal(
    needsLiveFreshnessSearch('compare GPT-5.6 Terra vs Sol vs Luna'),
    true,
  );
  assert.equal(
    needsLiveFreshnessSearch('what are the latest frontier models in 2026?'),
    true,
  );
  assert.equal(
    needsLiveFreshnessSearch('list the current top LLMs'),
    true,
  );
});

test('live world asks need freshness', () => {
  assert.equal(needsLiveFreshnessSearch("what's today's news on OpenAI"), true);
  assert.equal(needsLiveFreshnessSearch('who won the election yesterday'), true);
  assert.equal(needsLiveFreshnessSearch('current price of bitcoin'), true);
});

test('general / vault asks do NOT auto-search', () => {
  assert.equal(needsLiveFreshnessSearch('explain how transformers work'), false);
  assert.equal(needsLiveFreshnessSearch('how do I write a better prompt'), false);
  assert.equal(needsLiveFreshnessSearch('compare my models in model builder'), false);
  assert.equal(needsLiveFreshnessSearch('what is in my vault about Claude'), false);
  assert.equal(needsLiveFreshnessSearch('hi'), false);
  assert.equal(needsLiveFreshnessSearch('thanks'), false);
});

test('shouldForceWebSearch unions both intents', () => {
  assert.equal(shouldForceWebSearch('search online for Terra pricing'), true);
  assert.equal(shouldForceWebSearch('chart comparing all AI models'), true);
  assert.equal(shouldForceWebSearch('rewrite this paragraph more clearly'), false);
});
