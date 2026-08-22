'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  needsLiveFreshnessSearch,
  hasExplicitWebSearchIntent,
  shouldForceWebSearch,
  isLiveWebCapabilityAsk,
  isReadSourceCapabilityAsk,
  messageWantsWebTools,
  needsNamedSourceRead,
  resolveWebSearchQuery,
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

test('research-on-topic is explicit search; vault-scoped is not', () => {
  assert.equal(hasExplicitWebSearchIntent('do live research on GPT-5 pricing'), true);
  assert.equal(shouldForceWebSearch('do live research on GPT-5 pricing'), true);
  assert.equal(shouldForceWebSearch('research the latest Anthropic release'), true);
  assert.equal(shouldForceWebSearch('research my vault notes about Claude'), false);
});

test('capability questions do not pre-fetch, but keep web tools on', () => {
  assert.equal(isLiveWebCapabilityAsk('can you do live research?'), true);
  assert.equal(isLiveWebCapabilityAsk('do you have live web access'), true);
  assert.equal(isLiveWebCapabilityAsk('can you search the web?'), true);
  assert.equal(isLiveWebCapabilityAsk('can you do live research on OpenAI?'), false);
  assert.equal(shouldForceWebSearch('can you do live research?'), false);
  assert.equal(shouldForceWebSearch('can you do live research on OpenAI?'), true);
  assert.equal(messageWantsWebTools('can you do live research?'), true);
  assert.equal(messageWantsWebTools('what is the latest news on OpenAI'), true);
});

test('named outlets and headlines force a fetch — no pasted URL required', () => {
  assert.equal(needsNamedSourceRead('fox news'), true);
  assert.equal(needsNamedSourceRead('top headlines'), true);
  assert.equal(shouldForceWebSearch('fox news'), true);
  assert.equal(shouldForceWebSearch('top headlines'), true);
  assert.equal(shouldForceWebSearch('CNN top headlines'), true);
  assert.equal(isReadSourceCapabilityAsk('can you read from a specific source I ask you'), true);
  assert.equal(shouldForceWebSearch('can you read from a specific source I ask you'), false);
  assert.equal(
    resolveWebSearchQuery('fox news'),
    'Fox News top headlines',
  );
  assert.equal(
    resolveWebSearchQuery('top headlines', [
      { role: 'user', content: 'fox news' },
      { role: 'assistant', content: 'Yes — I can read Fox News specifically.' },
    ]),
    'Fox News top headlines',
  );
  assert.equal(
    resolveWebSearchQuery("what's the latest news on OpenAI"),
    "what's the latest news on OpenAI",
  );
});
