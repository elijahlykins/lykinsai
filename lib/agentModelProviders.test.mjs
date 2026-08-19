// Usage: node --test lib/agentModelProviders.test.mjs
//
// Covers the two things in this module that fail silently and expensively:
// arm gating (an authenticated route that maps client input to paid models),
// and the Gemini schema sanitiser (whose omissions produced invalid decisions
// on 3 of 3 sampled runs before `required` was added to DECISION_SCHEMA).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import {
  resolveAgentStageModel,
  geminiSchema,
  flattenDescriptions,
  providerForModel,
} from './agentModelProviders.js';

const require = createRequire(import.meta.url);
const { DECISION_SCHEMA } = require('../electron/browser-agent/runtime/model.cjs');

const ARM_ENV = {
  BROWSER_AGENT_EVAL_ARMS_ENABLED: '1',
  BROWSER_AGENT_PLAN_MODEL: 'claude-opus-5',
  BROWSER_AGENT_PLAN_EFFORT: 'low',
  BROWSER_AGENT_ARM_LUNA_REFS_MODEL: 'gpt-5.6-luna',
  BROWSER_AGENT_ARM_LUNA_REFS_EFFORT: 'low',
  BROWSER_AGENT_ARM_GEMINI_HOLO_MODEL: 'gemini-3.7-flash',
};

test('an arm is refused unless the server explicitly enables eval arms', () => {
  const out = resolveAgentStageModel({ stage: 'decide', arm: 'luna-refs', userId: 'u1', env: {} });
  assert.match(out.armError, /not enabled/i);
  assert.equal(out.model, undefined);
});

test('an arm is refused for a user outside the allowlist', () => {
  const env = { ...ARM_ENV, BROWSER_AGENT_EVAL_USER_IDS: 'alice,bob' };
  assert.match(
    resolveAgentStageModel({ stage: 'decide', arm: 'luna-refs', userId: 'mallory', env }).armError,
    /not authorized/i,
  );
  // and allowed for someone on it
  assert.equal(
    resolveAgentStageModel({ stage: 'decide', arm: 'luna-refs', userId: 'bob', env }).model,
    'gpt-5.6-luna',
  );
});

test('an unknown arm never falls through to a default model', () => {
  const out = resolveAgentStageModel({ stage: 'decide', arm: 'does-not-exist', userId: 'u1', env: ARM_ENV });
  assert.match(out.armError, /unknown eval arm/i);
  assert.equal(out.model, undefined);
});

test('the client cannot smuggle a model id in through the arm name', () => {
  // Arm names are normalised to an env key, so an arbitrary string can only
  // ever resolve to an env var the operator set — never to the string itself.
  const out = resolveAgentStageModel({
    stage: 'decide', arm: 'claude-opus-5', userId: 'u1', env: ARM_ENV,
  });
  assert.match(out.armError, /unknown eval arm/i);
});

test('the planner is the same model in every arm', () => {
  // The whole experiment is invalid if the planner varies with the arm.
  const arms = ['luna-refs', 'gemini-holo'];
  const planners = arms.map(
    (arm) => resolveAgentStageModel({ stage: 'plan', arm, userId: 'u1', env: ARM_ENV }).model,
  );
  assert.deepEqual(planners, ['claude-opus-5', 'claude-opus-5']);
});

test('without an arm, production stage routing is unchanged', () => {
  const env = {
    BROWSER_AGENT_MODEL: 'gpt-5.6-terra',
    BROWSER_AGENT_LEARN_MODEL: 'gpt-4.1-mini',
  };
  assert.equal(resolveAgentStageModel({ stage: 'decide', arm: '', env }).model, 'gpt-5.6-terra');
  assert.equal(resolveAgentStageModel({ stage: 'verify', arm: '', env }).model, 'gpt-5.6-terra');
  assert.equal(resolveAgentStageModel({ stage: 'learn', arm: '', env }).model, 'gpt-4.1-mini');
  assert.equal(resolveAgentStageModel({ stage: 'judge', arm: '', env }).model, 'claude-opus-5');
});

test('geminiSchema strips the keys Gemini rejects, and nothing else', () => {
  const out = geminiSchema(DECISION_SCHEMA);
  const json = JSON.stringify(out);
  assert.ok(!json.includes('additionalProperties'), 'additionalProperties must be stripped');
  assert.ok(!json.includes('"$schema"'), '$schema must be stripped');
  // structure and the required anchor survive
  assert.equal(out.properties.action.properties.target.type, 'string');
  assert.deepEqual(out.properties.action.required, ['type']);
  assert.deepEqual(out.required, ['kind']);
});

test('DECISION_SCHEMA requires an action type', () => {
  // Without this, providers whose dialect free-forms unconstrained objects
  // omit the element ref entirely and every click becomes an invalid decision.
  assert.deepEqual(DECISION_SCHEMA.properties.action.required, ['type']);
});

test('flattenDescriptions recovers the guidance Gemini would otherwise lose', () => {
  const lines = flattenDescriptions(DECISION_SCHEMA);
  const joined = lines.join('\n');
  assert.ok(lines.length > 5, 'should surface many field descriptions');
  assert.match(joined, /action\.target:/);
  assert.match(joined, /action\.type: one of/); // enums are spelled out too
});

test('providerForModel routes every model the harness uses', () => {
  assert.equal(providerForModel('gpt-5.6-luna'), 'openai');
  assert.equal(providerForModel('claude-opus-5'), 'anthropic');
  assert.equal(providerForModel('gemini-3.7-flash'), 'gemini');
  assert.equal(providerForModel(''), null);
  assert.equal(providerForModel('holo3-1-35b-a3b'), null); // grounder has its own route
});

test('anthropicSchema closes open objects, which Anthropic requires', async () => {
  const { anthropicSchema } = await import('./agentModelProviders.js');
  // Regression: the real PLAN_SCHEMA has an open `knownFacts` map, and Anthropic
  // 400s on it. The loop swallows a failed plan by design, so the only symptom
  // was that Opus 5 silently never ran for a whole eval run.
  const schema = {
    type: 'object',
    properties: {
      plan: { type: 'array', items: { type: 'string' } },
      knownFacts: { type: 'object', additionalProperties: true },
      nested: { type: 'object', properties: { deep: { type: 'object' } } },
    },
    required: ['plan'],
    additionalProperties: false,
  };
  const out = anthropicSchema(schema);
  assert.equal(out.properties.knownFacts.additionalProperties, false);
  assert.equal(out.properties.nested.additionalProperties, false);
  assert.equal(out.properties.nested.properties.deep.additionalProperties, false);
  assert.equal(out.additionalProperties, false);
  // Non-object nodes are untouched.
  assert.deepEqual(out.properties.plan, { type: 'array', items: { type: 'string' } });
  assert.deepEqual(out.required, ['plan']);
  // And the input is not mutated.
  assert.equal(schema.properties.knownFacts.additionalProperties, true);
});

// ── provider dispatch ────────────────────────────────────────────────────────

test('a Grok model goes to x.ai with the x.ai key, not to OpenAI', async () => {
  // x.ai speaks the OpenAI dialect, which is why it shares that client. It does
  // not share OpenAI's endpoint or key — routing it through without swapping
  // both sent every Grok request to api.openai.com with the OpenAI credential.
  const { callStructured } = await import('./agentModelProviders.js');
  const seen = [];
  const realFetch = globalThis.fetch;
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevXai = process.env.XAI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-openai';
  process.env.XAI_API_KEY = 'xai-key';
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
    };
  };
  try {
    await callStructured({ model: 'grok-4', user: 'u', schema: { type: 'object' }, name: 'n' });
    assert.match(seen[0].url, /api\.x\.ai/, 'a Grok model must not be sent to OpenAI');
    assert.equal(seen[0].auth, 'Bearer xai-key');

    seen.length = 0;
    await callStructured({ model: 'gpt-5.6', user: 'u', schema: { type: 'object' }, name: 'n' });
    assert.match(seen[0].url, /api\.openai\.com/);
    assert.equal(seen[0].auth, 'Bearer sk-openai');
  } finally {
    globalThis.fetch = realFetch;
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevXai === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = prevXai;
  }
});

test('screenshots reach the vision model at full detail', async () => {
  // The agent reads 0-1000 coordinates off these frames. `detail: 'low'`
  // downsamples to ~512px, so a control it is asked to click can vanish from
  // the image it is aiming at.
  const src = await readFile(new URL('./agentModelProviders.js', import.meta.url), 'utf8');
  assert.match(src, /image_url: \{ url, detail: 'high' \}/);
  assert.doesNotMatch(src, /image_url: \{ url, detail: 'low' \}/);
});
