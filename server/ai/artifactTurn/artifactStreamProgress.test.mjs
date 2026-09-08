import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPartialStringField,
  makeArtifactProgressEmitter,
} from './artifactStreamProgress.js';

/** Cut a valid JSON args object short, the way a live stream arrives. */
function truncatedArgs(obj, keepFraction) {
  const full = JSON.stringify(obj);
  return full.slice(0, Math.floor(full.length * keepFraction));
}

test('reads a complete string field', () => {
  const buf = JSON.stringify({ title: 'Habit Tracker', code: 'const a = 1;' });
  assert.equal(extractPartialStringField(buf, 'title'), 'Habit Tracker');
  assert.equal(extractPartialStringField(buf, 'code'), 'const a = 1;');
});

test('reads a field the stream has only half delivered', () => {
  const code = 'import React from "react";\nexport default function App() {\n  return null;\n}';
  const buf = truncatedArgs({ title: 'Demo', code }, 0.7);
  const partial = extractPartialStringField(buf, 'code');
  assert.ok(partial.length > 0);
  assert.ok(code.startsWith(partial), 'partial must be a prefix of the real source');
  // Escapes are decoded, not echoed raw.
  assert.ok(partial.includes('import React from "react"'));
  assert.ok(!partial.includes('\\n'));
});

test('a field that has not started yet reads as empty', () => {
  assert.equal(extractPartialStringField('{"title":"Demo"', 'code'), '');
  assert.equal(extractPartialStringField('{"title":"De', 'code'), '');
  assert.equal(extractPartialStringField('', 'code'), '');
  assert.equal(extractPartialStringField('{"code"', 'code'), '');
  assert.equal(extractPartialStringField('{"code":', 'code'), '');
});

test('an escape sequence cut in half does not corrupt the output', () => {
  // Buffer ends mid `\uXXXX` and mid `\"`.
  assert.equal(extractPartialStringField('{"code":"a\\u00e', 'code'), 'a');
  assert.equal(extractPartialStringField('{"code":"a\\', 'code'), 'a');
  assert.equal(extractPartialStringField('{"code":"a\\u00e9b', 'code'), 'aéb');
});

test('emits throttled frames as the source grows', async () => {
  const frames = [];
  const emit = makeArtifactProgressEmitter({ send: (p) => frames.push(p), throttleMs: 0 });
  emit('lykn_build_react_artifact', '{"title":"Demo","code":"const a');
  emit('lykn_build_react_artifact', '{"title":"Demo","code":"const a = 1;');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].artifact_progress.title, 'Demo');
  assert.equal(frames[1].artifact_progress.code, 'const a = 1;');
  assert.equal(frames[1].artifact_progress.chars, 'const a = 1;'.length);

  // No new bytes → no frame.
  emit('lykn_build_react_artifact', '{"title":"Demo","code":"const a = 1;');
  assert.equal(frames.length, 2);
});

test('an edits patch streams nothing — there is no source to show', () => {
  const frames = [];
  const emit = makeArtifactProgressEmitter({ send: (p) => frames.push(p), throttleMs: 0 });
  emit('lykn_build_react_artifact', '{"title":"Demo","edits":[{"find":"a","replace":"b"}]}');
  assert.equal(frames.length, 0);
});

test('unrelated tools and oversized buffers are ignored', () => {
  const frames = [];
  const emit = makeArtifactProgressEmitter({ send: (p) => frames.push(p), throttleMs: 0, maxChars: 10 });
  emit('lykn_web_search', '{"code":"const a = 1;"}');
  assert.equal(frames.length, 0);
  emit('lykn_build_react_artifact', '{"code":"this is definitely longer than ten characters"}');
  assert.equal(frames.length, 0);
});

test('throttling suppresses frames inside the window', () => {
  const frames = [];
  const emit = makeArtifactProgressEmitter({ send: (p) => frames.push(p), throttleMs: 60_000 });
  emit('lykn_build_react_artifact', '{"code":"a');
  emit('lykn_build_react_artifact', '{"code":"ab');
  emit('lykn_build_react_artifact', '{"code":"abc');
  assert.equal(frames.length, 1);
});

test('a broken send never breaks the build', () => {
  const emit = makeArtifactProgressEmitter({
    send: () => { throw new Error('socket closed'); },
    throttleMs: 0,
  });
  assert.doesNotThrow(() => emit('lykn_build_react_artifact', '{"code":"const a = 1;'));
});
