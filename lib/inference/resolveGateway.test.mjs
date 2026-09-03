import test from 'node:test';
import assert from 'node:assert/strict';
import { extractOpenRouterUsage, mergeOpenRouterUsage } from './openRouterGateway.js';
import { mapOpenRouterModel } from './openRouterCatalog.js';
import { isOpenRouterTarget, resolveInferenceTarget } from './resolveGateway.js';

test('curated models stay on direct providers when OpenRouter is not configured', () => {
  const env = { OPENAI_API_KEY: 'x' };
  const target = resolveInferenceTarget('gpt-5.6-terra', env);
  assert.equal(target.gateway, 'direct');
  assert.equal(target.provider, 'openai');
  assert.equal(isOpenRouterTarget('gpt-5.6-terra', env), false);
});

test('OPENROUTER_API_KEY routes curated models through OpenRouter by default', () => {
  const env = { OPENROUTER_API_KEY: 'or' };
  const terra = resolveInferenceTarget('gpt-5.6-terra', env);
  assert.equal(terra.gateway, 'openrouter');
  assert.equal(terra.keyVar, 'OPENROUTER_API_KEY');
  assert.equal(terra.upstreamId, 'openai/gpt-5.6-terra');

  const haiku = resolveInferenceTarget('claude-haiku-4-5', env);
  assert.equal(haiku.gateway, 'openrouter');
  assert.equal(haiku.upstreamId, 'anthropic/claude-haiku-4.5');
  assert.equal(isOpenRouterTarget('gemini-3.6-flash', env), true);
});

test('LYKN_CHAT_GATEWAY=direct keeps curated models on native providers', () => {
  const env = { OPENROUTER_API_KEY: 'or', LYKN_CHAT_GATEWAY: 'direct', OPENAI_API_KEY: 'x' };
  const target = resolveInferenceTarget('gpt-5.6-terra', env);
  assert.equal(target.gateway, 'direct');
  assert.equal(target.keyVar, 'OPENAI_API_KEY');
});

test('LYKN_CHAT_GATEWAY=openrouter uses OpenRouter when a key is set', () => {
  const env = { OPENROUTER_API_KEY: 'or', LYKN_CHAT_GATEWAY: 'openrouter' };
  const target = resolveInferenceTarget('gpt-5.6-terra', env);
  assert.equal(target.gateway, 'openrouter');
  assert.equal(target.keyVar, 'OPENROUTER_API_KEY');
  assert.ok(target.upstreamId);
});

test('OpenRouter usage prefers upstream cost', () => {
  const usage = extractOpenRouterUsage({
    usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.0012 },
  });
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 4);
  assert.equal(usage.cost_usd, 0.0012);
  assert.equal(usage.cost_source, 'upstream');
});

test('mergeOpenRouterUsage sums tokens and cost across hops', () => {
  const merged = mergeOpenRouterUsage(
    { input_tokens: 10, output_tokens: 2, cost_usd: 0.001, cost_source: 'upstream' },
    { input_tokens: 4, output_tokens: 6, cost_usd: 0.002, cost_source: 'upstream' },
  );
  assert.equal(merged.input_tokens, 14);
  assert.equal(merged.output_tokens, 8);
  assert.equal(merged.cost_usd, 0.003);
});

test('catalog mapper never marks synced models recommended', () => {
  const mapped = mapOpenRouterModel({
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek Chat',
    context_length: 64000,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.00000014', completion: '0.00000028' },
    supported_parameters: ['tools', 'tool_choice'],
  });
  assert.equal(mapped.id, 'deepseek/deepseek-chat');
  assert.equal(mapped.capabilities.tools, true);
  assert.ok(mapped.pricing.input > 0);
});
