import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_VOICE_LLM_MODEL,
  LEAN_VOICE_LLM_MODEL,
  prepareVoiceCustomLlmUpstream,
  trimVoiceLlmMessages,
} from './voiceCustomLlm.js';

test('lean spoken Q&A uses nano, ignores ElevenLabs gpt-4o, and drops empty tools', () => {
  const out = prepareVoiceCustomLlmUpstream({
    body: { model: 'gpt-4o', stream: false, tools: [{ function: { name: 'web_search' } }], max_tokens: 8000 },
    rebuiltMessages: [
      { role: 'system', content: 'grounding' },
      { role: 'user', content: 'what is photosynthesis' },
    ],
    filteredTools: [],
    interruptForTools: false,
    envModel: '',
  });
  assert.equal(out.model, LEAN_VOICE_LLM_MODEL);
  assert.equal(out.stream, true);
  assert.equal(out.tools, undefined);
  assert.equal(out.max_tokens, 400);
});

test('Chat-disclosed tools are forwarded so the model can pick one', () => {
  const tools = [{ function: { name: 'local_list_dir' } }];
  const out = prepareVoiceCustomLlmUpstream({
    body: { model: 'gpt-4o' },
    rebuiltMessages: [{ role: 'user', content: "what's in my desktop" }],
    filteredTools: tools,
    interruptForTools: false,
    envModel: '',
  });
  assert.equal(out.model, DEFAULT_VOICE_LLM_MODEL);
  assert.equal(out.stream, true);
  assert.deepEqual(out.tools, tools);
  assert.equal(out.max_tokens, 400);
});

test('the legacy gpt-4o env default does not keep Voice on gpt-4o', () => {
  const out = prepareVoiceCustomLlmUpstream({
    body: { model: 'gpt-4o' },
    rebuiltMessages: [{ role: 'user', content: 'hello' }],
    filteredTools: [],
    interruptForTools: false,
    envModel: 'gpt-4o',
  });
  assert.equal(out.model, LEAN_VOICE_LLM_MODEL);
});

test('an explicit non-gpt-4o ELEVENLABS_LLM_MODEL still wins', () => {
  const out = prepareVoiceCustomLlmUpstream({
    body: { model: 'gpt-4o' },
    rebuiltMessages: [{ role: 'user', content: 'hello' }],
    filteredTools: [],
    interruptForTools: false,
    envModel: 'gpt-4.1-mini',
  });
  assert.equal(out.model, 'gpt-4.1-mini');
});

test('trimVoiceLlmMessages keeps leading system blocks and a short tail', () => {
  const messages = [
    { role: 'system', content: 'a' },
    { role: 'system', content: 'b' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: String(i) })),
  ];
  const out = trimVoiceLlmMessages(messages, { tail: 4 });
  assert.deepEqual(out.slice(0, 2), [
    { role: 'system', content: 'a' },
    { role: 'system', content: 'b' },
  ]);
  assert.equal(out.length, 6);
  assert.equal(out.at(-1).content, '19');
});
