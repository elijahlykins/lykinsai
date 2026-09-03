import test from 'node:test';
import assert from 'node:assert/strict';
import { CREDIT_COSTS, extractOpenAIUsage, getCreditCost } from '../../../usageTracking.js';
import {
  CHAT_ROUTE_MODELS,
  chatRouteUsageMetadata,
  ROUTING_SOURCES,
  isAutoRoutedModelId,
  openaiReasoningPayload,
  resolveBillableCredits,
  resolveChatRoute,
  shouldSkipGlassRequestCap,
  supportedReasoningEfforts,
} from './index.js';

const COMPLEX_ARCHITECTURE = [
  'Design a robust memory architecture for a local-first autonomous agent system.',
  'Compare two candidate stores, explain consistency tradeoffs, sketch the write path,',
  'and say which one will scale when we add multi-agent retrieval and conflict resolution.',
  'Include failure modes and how the agent should recover when a write is interrupted.',
].join(' ');

test('simple greeting routes to the fast tier', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: "hey what's up",
    planId: 'studio',
  });
  assert.equal(route.modelTier, 'fast');
  assert.equal(route.modelId, CHAT_ROUTE_MODELS.fast);
  assert.equal(route.reasoningEffort, 'none');
  assert.equal(route.routingSource, ROUTING_SOURCES.HEURISTIC);
  assert.equal(route.billableChatCredits, 0);
});

test('normal substantive question routes to the standard tier', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: 'why would my agent keep repeating the same action after a tool error?',
    planId: 'studio',
  });
  assert.equal(route.modelTier, 'standard');
  assert.equal(route.modelId, CHAT_ROUTE_MODELS.standard);
  assert.equal(route.reasoningEffort, 'low');
});

test('clearly complex reasoning request routes to advanced', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: COMPLEX_ARCHITECTURE,
    planId: 'studio',
  });
  assert.equal(route.modelTier, 'advanced');
  assert.equal(route.modelId, CHAT_ROUTE_MODELS.advanced);
  assert.equal(route.reasoningEffort, 'high');
});

test('uncertain classification escalates instead of cheapening quality', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: 'rewrite this sentence to sound better',
    planId: 'studio',
  });
  assert.equal(route.modelTier, 'standard');
  assert.ok(route.confidence < 0.78);
});

test('classifier can promote a short rewrite to fast when confident', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: 'rewrite this sentence to sound better',
    planId: 'studio',
    classifyFn: async () => ({
      modelTier: 'fast',
      confidence: 0.92,
      reason: 'simple rewrite',
      routingSource: ROUTING_SOURCES.CLASSIFIER,
    }),
  });
  assert.equal(route.modelTier, 'fast');
  assert.equal(route.routingSource, ROUTING_SOURCES.CLASSIFIER);
});

test('explicit user model selection bypasses Auto routing', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'gpt-5.6-sol',
    text: "hey what's up",
    planId: 'studio',
  });
  assert.equal(route.routingSource, ROUTING_SOURCES.OVERRIDE);
  assert.equal(route.modelId, 'gpt-5.6-sol');
  assert.equal(route.modelTier, 'advanced');
});

test('classifier failure falls back to the standard model', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: 'rewrite this sentence to sound better',
    planId: 'studio',
    classifyFn: async () => {
      throw new Error('classifier timeout');
    },
  });
  assert.equal(route.modelTier, 'standard');
  assert.equal(route.modelId, CHAT_ROUTE_MODELS.standard);
  assert.equal(route.routingSource, ROUTING_SOURCES.FALLBACK);
});

test('Max uses a higher default reasoning level on standard chat', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: 'why would my agent keep repeating the same action after a tool error?',
    planId: 'max',
  });
  assert.equal(route.modelTier, 'standard');
  assert.equal(route.reasoningEffort, 'medium');
  assert.equal(route.billableChatCredits, 0);
});

test('unsupported reasoning effort is not sent to a model', () => {
  const luna = openaiReasoningPayload('gpt-5.6-luna', 'xhigh');
  assert.equal(luna.reasoning_effort, 'xhigh');
  const flash = openaiReasoningPayload('gpt-4.1-nano', 'xhigh');
  assert.deepEqual(flash, {});
  const gemini = openaiReasoningPayload('gemini-3.1-pro-preview', 'high');
  assert.deepEqual(gemini, {});
  assert.ok(!supportedReasoningEfforts('grok-4.5').includes('high'));
});

test('subscription normal chat consumes zero credits', () => {
  assert.equal(getCreditCost('chat_short', { planId: 'studio' }), 0);
  assert.equal(getCreditCost('chat_long', { planId: 'max' }), 0);
  assert.equal(getCreditCost('chat_complex', { planId: 'studio_pro' }), 0);
  assert.equal(getCreditCost('chat_long', { planId: 'student' }), 0);
});

test('Free chat credits stay on the catalog weights', () => {
  assert.equal(getCreditCost('chat_short', { planId: 'free' }), CREDIT_COSTS.chat_short);
});

test('image generation and video stay billable on Pro/Max', () => {
  assert.equal(getCreditCost('image_gen', { planId: 'studio' }), CREDIT_COSTS.image_gen);
  assert.equal(getCreditCost('image_edit', { planId: 'max' }), CREDIT_COSTS.image_edit);
  assert.equal(getCreditCost('video', { planId: 'studio' }), CREDIT_COSTS.video);
  assert.equal(getCreditCost('file_large', { planId: 'max' }), CREDIT_COSTS.file_large);
});

test('text turn does not double-bill when a compute tool already ran', () => {
  const chat = resolveBillableCredits({
    actionType: 'chat_short',
    catalogCredits: 1,
    planId: 'student',
    hasBillableToolAction: true,
  });
  const image = resolveBillableCredits({
    actionType: 'image_gen',
    catalogCredits: 15,
    planId: 'student',
    hasBillableToolAction: true,
  });
  assert.equal(chat, 0);
  assert.equal(image, 15);
});

test('paid-plan chat routes skip the metered gate; Free does not', () => {
  assert.equal(shouldSkipGlassRequestCap('studio', '/api/ai/stream'), true);
  assert.equal(shouldSkipGlassRequestCap('max', '/api/ai/invoke'), true);
  assert.equal(shouldSkipGlassRequestCap('student', '/api/ai/stream'), true);
  assert.equal(shouldSkipGlassRequestCap('free', '/api/ai/stream'), false);
  assert.equal(shouldSkipGlassRequestCap('studio', '/api/ai/tts'), false);
});

test('lykn and unified-auto are Auto-routed; frontier ids are not', () => {
  assert.equal(isAutoRoutedModelId('lykn'), true);
  assert.equal(isAutoRoutedModelId('lykn-setup'), true);
  assert.equal(isAutoRoutedModelId('unified-auto'), true);
  assert.equal(isAutoRoutedModelId('gpt-5.6-sol'), false);
});

test('usage metadata records the routed model decision', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: "hey what's up",
    planId: 'studio',
  });
  const meta = chatRouteUsageMetadata(route, { planId: 'studio' });
  assert.equal(meta.model_tier, 'fast');
  assert.equal(meta.routing_source, ROUTING_SOURCES.HEURISTIC);
  assert.equal(meta.plan, 'studio');
  assert.equal(route.modelId, CHAT_ROUTE_MODELS.fast);
});

test('My Setup uses a category assignment and otherwise inherits LYKN', async () => {
  const assigned = await resolveChatRoute({
    requestedModel: 'lykn-setup',
    text: "hey what's up",
    planId: 'studio',
    userSettings: { categories: { quick: 'gpt-5.6-sol' } },
  });
  assert.equal(assigned.routingSource, ROUTING_SOURCES.USER_SETUP);
  assert.equal(assigned.modelId, 'gpt-5.6-sol');

  const inherit = await resolveChatRoute({
    requestedModel: 'lykn-setup',
    text: "hey what's up",
    planId: 'studio',
    userSettings: { categories: {} },
  });
  assert.equal(inherit.modelId, CHAT_ROUTE_MODELS.fast);
  assert.equal(inherit.selectionMode, 'my_setup');
});

test('bot route policy uses the named route primary and LYKN fallbacks', async () => {
  const route = await resolveChatRoute({
    requestedModel: 'lykn',
    text: 'write a report',
    planId: 'studio',
    modelPolicy: { mode: 'route', routeId: 'r1' },
    resolvedRoute: {
      id: 'r1',
      primaryModelId: 'gpt-5.6-sol',
      fallbackModelIds: ['claude-opus-4-8'],
    },
  });
  assert.equal(route.routingSource, ROUTING_SOURCES.ROUTE);
  assert.equal(route.modelId, 'gpt-5.6-sol');
  assert.deepEqual(route.fallbackModelIds, ['claude-opus-4-8']);
});

test('OpenAI usage extract captures cached and reasoning tokens', () => {
  const usage = extractOpenAIUsage({
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 12 },
    },
  });
  assert.equal(usage.input_tokens, 1000);
  assert.equal(usage.output_tokens, 80);
  assert.equal(usage.cached_input_tokens, 400);
  assert.equal(usage.reasoning_tokens, 12);
});
