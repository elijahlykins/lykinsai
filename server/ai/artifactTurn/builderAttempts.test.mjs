import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAgentAttempts, FORCED_TOOL_FALLBACK_MODELS } from './builderAttempts.js';

const providerForModel = (id) => {
  if (String(id).startsWith('gpt-') || String(id).startsWith('o3')) return 'openai';
  if (String(id).includes('claude')) return 'anthropic';
  if (String(id).startsWith('gemini')) return 'gemini';
  if (String(id).includes('grok')) return 'grok';
  return null;
};

const ALL_KEYS = {
  ANTHROPIC_API_KEY: 'x',
  OPENAI_API_KEY: 'x',
  GOOGLE_API_KEY: 'x',
};

test('an ordinary turn gets exactly one attempt', () => {
  const attempts = buildAgentAttempts({
    provider: 'openai',
    model: 'gpt-5.6-terra',
    forcedToolName: undefined,
    routeFallbackModelIds: null,
    providerForModel,
    openRouterReady: false,
    env: ALL_KEYS,
  });
  assert.deepEqual(attempts, [{ provider: 'openai', model: 'gpt-5.6-terra' }]);
});

test('a forced-tool turn appends the recovery chain in preference order', () => {
  const attempts = buildAgentAttempts({
    provider: 'grok',
    model: 'grok-4.6',
    forcedToolName: 'lykn_build_react_artifact',
    routeFallbackModelIds: null,
    providerForModel,
    openRouterReady: false,
    env: ALL_KEYS,
  });
  assert.deepEqual(attempts.map((a) => a.model), [
    'grok-4.6',
    ...FORCED_TOOL_FALLBACK_MODELS,
  ]);
  assert.deepEqual(attempts.map((a) => a.provider), [
    'grok',
    'anthropic',
    'openai',
    'gemini',
  ]);
});

test('a workspace build turn gets the recovery chain without a forced tool', () => {
  // The mansion failure: claude-fable-5 died on a provider 400 before doing
  // any work, and with a single attempt the turn fell to the toolless legacy
  // stream — "build me a game" answered as prose. Workspace turns force no
  // tool (the model picks its own first local_* call) but still need the
  // coding-model recovery tail.
  const attempts = buildAgentAttempts({
    provider: 'openrouter',
    model: 'claude-fable-5',
    forcedToolName: undefined,
    workspaceTurn: true,
    routeFallbackModelIds: null,
    providerForModel,
    openRouterReady: true,
    env: {},
  });
  assert.deepEqual(attempts.map((a) => a.model), [
    'claude-fable-5',
    ...FORCED_TOOL_FALLBACK_MODELS,
  ]);
});

test('the user\'s own fallback chain outranks the recovery tail', () => {
  const attempts = buildAgentAttempts({
    provider: 'openai',
    model: 'gpt-5.6-terra',
    forcedToolName: 'lykn_build_react_artifact',
    routeFallbackModelIds: ['claude-sonnet-5'],
    providerForModel,
    openRouterReady: false,
    env: ALL_KEYS,
  });
  assert.equal(attempts[1].model, 'claude-sonnet-5');
});

test('missing provider keys drop that fallback instead of failing the turn', () => {
  const attempts = buildAgentAttempts({
    provider: 'grok',
    model: 'grok-4.6',
    forcedToolName: 'lykn_build_react_artifact',
    routeFallbackModelIds: null,
    providerForModel,
    openRouterReady: false,
    env: { OPENAI_API_KEY: 'x' },
  });
  assert.deepEqual(attempts.map((a) => a.model), ['grok-4.6', 'gpt-5.6-sol']);
});

test('OpenRouter serves every fallback over one transport', () => {
  const attempts = buildAgentAttempts({
    provider: 'openrouter',
    model: 'grok-4.6',
    forcedToolName: 'lykn_build_react_artifact',
    routeFallbackModelIds: null,
    providerForModel,
    openRouterReady: true,
    env: {},
  });
  assert.deepEqual(attempts.map((a) => a.provider), [
    'openrouter', 'openrouter', 'openrouter', 'openrouter',
  ]);
});

test('the primary model is never duplicated in the chain', () => {
  const attempts = buildAgentAttempts({
    provider: 'openai',
    model: 'gpt-5.6-sol',
    forcedToolName: 'lykn_build_react_artifact',
    routeFallbackModelIds: ['gpt-5.6-sol'],
    providerForModel,
    openRouterReady: false,
    env: ALL_KEYS,
  });
  const models = attempts.map((a) => a.model);
  assert.equal(new Set(models).size, models.length);
  assert.equal(models[0], 'gpt-5.6-sol');
});
