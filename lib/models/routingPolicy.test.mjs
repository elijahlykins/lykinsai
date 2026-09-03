import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferRouteCategory,
  MY_SETUP_ID,
  requestedModelForPolicy,
  resolveSetupAssignment,
  sanitizeBotModelPolicy,
  sanitizeRouteRecord,
  SELECTION_MODES,
} from './routingPolicy.js';

test('inferRouteCategory uses structured flags, not keywords', () => {
  assert.equal(inferRouteCategory({ forAgent: true }), 'agents');
  assert.equal(inferRouteCategory({ deepResearch: true }), 'research');
  assert.equal(inferRouteCategory({ artifactToolName: 'build_react_artifact' }), 'coding');
  assert.equal(inferRouteCategory({ hasImages: true }), 'vision');
  assert.equal(inferRouteCategory({ modelTier: 'fast' }), 'quick');
  assert.equal(inferRouteCategory({ modelTier: 'advanced' }), 'reasoning');
  assert.equal(inferRouteCategory({ modelTier: 'standard' }), 'default');
});

test('unset My Setup categories inherit LYKN', () => {
  assert.equal(resolveSetupAssignment({ categories: {} }, 'coding'), null);
  assert.equal(resolveSetupAssignment({ categories: { coding: 'lykn' } }, 'coding'), null);
  assert.equal(
    resolveSetupAssignment({ categories: { coding: 'gpt-5.6-sol' } }, 'coding'),
    'gpt-5.6-sol',
  );
});

test('My Setup can assign OpenRouter catalog ids', () => {
  assert.equal(
    resolveSetupAssignment({ categories: { coding: 'anthropic/claude-sonnet-4' } }, 'coding'),
    'anthropic/claude-sonnet-4',
  );
  assert.equal(resolveSetupAssignment({ categories: { coding: '../evil' } }, 'coding'), null);
});

test('bot policy defaults to LYKN and maps to picker ids', () => {
  assert.deepEqual(sanitizeBotModelPolicy(null), {
    mode: SELECTION_MODES.LYKN,
    routeId: null,
    modelId: null,
    steps: null,
  });
  assert.equal(requestedModelForPolicy({ mode: 'my_setup' }), MY_SETUP_ID);
  assert.equal(requestedModelForPolicy({ mode: 'model', modelId: 'gpt-5.6-sol' }), 'gpt-5.6-sol');
  assert.equal(requestedModelForPolicy({ mode: 'lykn' }), 'lykn');
});

test('named routes require a real primary model', () => {
  assert.equal(sanitizeRouteRecord({ name: 'X', primaryModelId: 'not-a-model' }).ok, false);
  const ok = sanitizeRouteRecord({
    name: 'Code',
    purpose: 'coding',
    primaryModelId: 'gpt-5.6-sol',
    fallbackModelIds: ['claude-opus-4-8', 'gpt-5.6-sol'],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.route.primaryModelId, 'gpt-5.6-sol');
  assert.deepEqual(ok.route.fallbackModelIds, ['claude-opus-4-8']);
});
