import test from 'node:test';
import assert from 'node:assert/strict';
import { getCreditCost } from '../../../usageTracking.js';
import { calculateCost } from '../../../usageTracking.js';
import { splitPromptForProvider } from '../promptUtils.js';
import { compressConversation, messageMatchesCurrentTurn } from '../../../src/lib/ai/conversationFormat.js';
import {
  CHAT_ROUTE_MODELS,
  resolveBillableCredits,
  resolveChatRoute,
} from '../chatRouting/index.js';
import {
  LYKN_SYSTEM_PROMPT_VERSION,
  buildPromptCacheKey,
  cacheUsageMetrics,
  classifyPromptSections,
  contextUsageMetadata,
  conversationOptionsForTier,
  getCachedInputPricing,
  getPromptCacheConfiguration,
  personalizationFingerprint,
  shouldAttachRequestContext,
  splitStablePrefix,
  supportsPromptCaching,
} from './index.js';

const PERSONA = 'SYSTEM\nYou are LYKN.\nStable rules stay here.';

function assembleTurn({
  user = 'hey',
  prefs = 'Be concise.',
  conversation = '',
  time = '[CURRENT_TIME] The user timezone is America/Denver.',
  web = '',
} = {}) {
  return [
    PERSONA,
    `[USER_PREFERENCES]\n${prefs}`,
    `[INTENT]\nask`,
    conversation ? `[CONVERSATION]\n${conversation}` : '',
    web,
    `[USER]\n${user}`,
    time,
  ].filter(Boolean).join('\n\n');
}

test('inline [CONVERSATION] mentions in the persona do not split the prefix', () => {
  const prompt = [
    'SYSTEM\nRead [CONVERSATION] before responding. Prefer it over memory.',
    '[USER_PREFERENCES]\nBe concise.',
    '[CONVERSATION]\nUSER: hi',
    '[USER]\nhey',
  ].join('\n\n');
  const split = splitPromptForProvider(prompt);
  assert.match(split.system, /Read \[CONVERSATION\]/);
  assert.match(split.system, /\[USER_PREFERENCES\]/);
  assert.match(split.user, /\[CONVERSATION\]\nUSER: hi/);
});

test('stable system prefix is deterministic across normal turns', () => {
  const turn1 = assembleTurn({ user: 'hey' });
  const turn2 = assembleTurn({ user: "what's up" });
  assert.equal(splitStablePrefix(turn1).stablePrefix, splitStablePrefix(turn2).stablePrefix);
  assert.equal(splitPromptForProvider(turn1).system, splitPromptForProvider(turn2).system);
});

test('volatile turn data does not alter the stable prefix', () => {
  const a = assembleTurn({
    user: 'hey',
    time: '[CURRENT_TIME] 2026-08-28T06:00:00-06:00',
    web: '[WEB_SEARCH_RESULTS]\n1. example.com',
  });
  const b = assembleTurn({
    user: 'hey again',
    time: '[CURRENT_TIME] 2026-08-28T06:01:00-06:00',
    web: '[UNTRUSTED_WEB]\nchanged page',
  });
  assert.equal(splitStablePrefix(a).stablePrefix, splitStablePrefix(b).stablePrefix);
  assert.ok(splitStablePrefix(a).dynamicSuffix.includes('[CURRENT_TIME]'));
  assert.ok(splitStablePrefix(b).dynamicSuffix.includes('[UNTRUSTED_WEB]'));
});

test('prompt cache key stays stable when versions and user stay the same', () => {
  const a = buildPromptCacheKey({ userId: 'user-a', modelId: 'gpt-5.6-terra' });
  const b = buildPromptCacheKey({ userId: 'user-a', modelId: 'gpt-5.6-terra' });
  assert.equal(a, b);
});

test('prompt cache key changes when the system prompt version changes', () => {
  const a = buildPromptCacheKey({
    userId: 'user-a',
    modelId: 'gpt-5.6-terra',
    systemPromptVersion: LYKN_SYSTEM_PROMPT_VERSION,
  });
  const b = buildPromptCacheKey({
    userId: 'user-a',
    modelId: 'gpt-5.6-terra',
    systemPromptVersion: `${LYKN_SYSTEM_PROMPT_VERSION}-next`,
  });
  assert.notEqual(a, b);
});

test('prompt cache identity cannot collide across users', () => {
  const a = buildPromptCacheKey({ userId: 'alice', modelId: 'gpt-5.6-luna' });
  const b = buildPromptCacheKey({ userId: 'bob', modelId: 'gpt-5.6-luna' });
  assert.notEqual(a, b);
  assert.ok(!a.includes('alice'));
  assert.ok(!b.includes('bob'));
});

test('personalization fingerprint changes cache key when prefs change', () => {
  const a = buildPromptCacheKey({
    userId: 'user-a',
    modelId: 'gpt-5.6-terra',
    personalizationVersion: personalizationFingerprint({ userPrompt: 'Be brief' }),
  });
  const b = buildPromptCacheKey({
    userId: 'user-a',
    modelId: 'gpt-5.6-terra',
    personalizationVersion: personalizationFingerprint({ userPrompt: 'Be poetic' }),
  });
  assert.notEqual(a, b);
});

test('cached input uses model-specific cached pricing', () => {
  const luna = calculateCost('gpt-5.6-luna', 1000, 0, 1000);
  assert.equal(luna, getCachedInputPricing('gpt-5.6-luna'));
  assert.ok(luna < 0.0005);
});

test('uncached input uses normal input pricing', () => {
  assert.equal(calculateCost('gpt-5.6-terra', 1000, 0, 0), 0.0025);
});

test('providers without cached pricing do not invent a discount', () => {
  assert.equal(getCachedInputPricing('grok-4.5'), null);
  assert.equal(calculateCost('grok-4.5', 1000, 0, 1000), 0.002);
  assert.equal(supportsPromptCaching('grok-4.5'), false);
  assert.equal(getPromptCacheConfiguration('grok-4.5').supported, false);
});

test('duplicate request context is not re-inserted', () => {
  const convo = 'USER: My dog is Max\nASSISTANT: Nice';
  assert.equal(shouldAttachRequestContext('hey', 'hey', convo), false);
  assert.equal(shouldAttachRequestContext(`Earlier\n${convo}`, 'later', convo), false);
  assert.equal(shouldAttachRequestContext('A unique attached transcript', 'hey', convo), true);
});

test('recent conversation continuity is preserved', () => {
  const msgs = [
    { role: 'user', content: 'Explain two options for caching.' },
    { role: 'assistant', content: '1. Prefix cache\n2. Semantic cache' },
    { role: 'user', content: 'Do the same thing as before.' },
  ];
  const text = compressConversation(msgs, conversationOptionsForTier('standard', {
    currentUserText: 'Do the same thing as before.',
  }));
  assert.match(text, /Prefix cache/);
  assert.match(text, /same thing as before/);
});

test('older reference context is preserved when the current turn names it', () => {
  const msgs = [
    { role: 'user', content: "My dog's name is Max. He is 7 years old." },
    { role: 'assistant', content: 'Got it, Max is 7.' },
    { role: 'user', content: 'What is a good walk length?' },
    { role: 'assistant', content: 'About 30 minutes.' },
    { role: 'user', content: 'Tell me a joke.' },
    { role: 'assistant', content: 'Why did the dog sit in the shade?' },
    { role: 'user', content: 'Another joke.' },
    { role: 'assistant', content: 'A longer setup about cats.' },
    { role: 'user', content: 'How old did I say Max was?' },
  ];
  assert.equal(
    messageMatchesCurrentTurn(msgs[0], 'How old did I say Max was?'),
    true,
  );
  const text = compressConversation(msgs, conversationOptionsForTier('fast', {
    currentUserText: 'How old did I say Max was?',
  }));
  assert.match(text, /Max/);
  assert.match(text, /7/);
});

test('attachment text is not duplicated into request context', () => {
  const attachment = '[ATTACHED_IMAGES]\n1 image attached';
  const prompt = `${PERSONA}\n\n${attachment}\n\n[USER]\nwhat is in the photo`;
  const split = splitPromptForProvider(prompt);
  assert.ok(split.user.includes('[ATTACHED_IMAGES]'));
  assert.ok(!split.system.includes('[ATTACHED_IMAGES]'));
  assert.equal(shouldAttachRequestContext(attachment, 'what is in the photo', ''), true);
});

test('dynamic browser/search content stays outside the stable prefix', () => {
  const prompt = assembleTurn({
    web: '[WEB_SEARCH_RESULTS]\nFox News headlines',
  });
  const { stablePrefix, dynamicSuffix } = splitStablePrefix(prompt);
  assert.ok(!stablePrefix.includes('[WEB_SEARCH_RESULTS]'));
  assert.ok(dynamicSuffix.includes('[WEB_SEARCH_RESULTS]'));
});

test('explicit model overrides still resolve', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'claude-sonnet-4-6',
    text: 'hey',
    planId: 'studio',
  });
  assert.equal(route.modelId, 'claude-sonnet-4-6');
  assert.equal(route.routingSource, 'override');
});

test('Auto routing still works after context-pipeline wiring', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: "hey what's up",
    planId: 'studio',
  });
  assert.equal(route.modelTier, 'fast');
  assert.equal(route.modelId, CHAT_ROUTE_MODELS.fast);
});

test('Pro and Max normal chat remain 0 credits', () => {
  assert.equal(resolveBillableCredits({ actionType: 'chat_short', catalogCredits: 1, planId: 'studio' }), 0);
  assert.equal(resolveBillableCredits({ actionType: 'chat_short', catalogCredits: 1, planId: 'max' }), 0);
  assert.equal(getCreditCost('chat_short', { planId: 'studio' }), 0);
  assert.equal(getCreditCost('chat_short', { planId: 'max' }), 0);
});

test('expensive tool billing remains unchanged', () => {
  assert.equal(getCreditCost('image_gen', { planId: 'studio' }), 15);
  assert.ok(getCreditCost('chat_short', { planId: 'free' }) > 0);
});

test('context-budget overflow trims safely', () => {
  const long = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `Turn ${i} ${'word '.repeat(80)}`,
  }));
  const text = compressConversation(long, conversationOptionsForTier('fast', {
    currentUserText: 'continue',
  }));
  assert.ok(text.length <= conversationOptionsForTier('fast').maxChars + 1);
  assert.match(text, /continue|Turn 39|Turn 38/);
});

test('tool-capable vs non-tool cache configuration stays provider-aware', () => {
  assert.equal(getPromptCacheConfiguration('gpt-5.6-terra').mechanism, 'automatic_prefix');
  assert.equal(getPromptCacheConfiguration('claude-sonnet-4-6').mechanism, 'cache_control_ephemeral');
  assert.equal(getPromptCacheConfiguration('gemini-flash-latest').mechanism, 'cachedContents');
});

test('cache and context telemetry record counts, not raw prompt text', () => {
  const prompt = assembleTurn({ conversation: 'USER: hi\nASSISTANT: hello' });
  const split = splitPromptForProvider(prompt);
  const telemetry = classifyPromptSections({
    system: split.system,
    user: split.user,
    toolsText: 'lykn_web_search',
  });
  const cache = cacheUsageMetrics({ inputTokens: 1000, cachedInputTokens: 400 });
  const meta = contextUsageMetadata(telemetry, cache);
  assert.equal(cache.uncached_input_tokens, 600);
  assert.equal(cache.cache_hit_rate, 0.4);
  assert.ok(meta.context_stable_tokens > 0);
  assert.ok(meta.context_stable_hash);
  assert.equal(JSON.stringify(meta).includes('Be concise'), false);
  assert.equal(JSON.stringify(telemetry).includes('Be concise'), false);
});
