// Characterization: `/api/ai/stream` and `/api/ai/local-tool-result` share
// one process-singleton Map. Do not instantiate per request or per registrar.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localToolStreams,
  registerLocalToolStream,
  releaseLocalToolStream,
  resolveLocalToolResult,
} from '../../server/ai/localToolBridge.js';

test.afterEach(() => {
  localToolStreams.clear();
});

test('registerLocalToolStream stores a single pending map per streamId', () => {
  registerLocalToolStream('s1', 'user-a');
  assert.equal(localToolStreams.size, 1);
  const entry = localToolStreams.get('s1');
  assert.equal(entry.userId, 'user-a');
  assert.ok(entry.pending instanceof Map);
  assert.equal(entry.pending.size, 0);
});

test('resolveLocalToolResult delivers only to the owning user', async () => {
  registerLocalToolStream('s2', 'user-a');
  const entry = localToolStreams.get('s2');
  const delivered = new Promise((resolve) => {
    entry.pending.set('tool-1', resolve);
  });

  assert.equal(resolveLocalToolResult('s2', 'user-b', 'tool-1', { ok: true }), false);
  assert.equal(entry.pending.size, 1);

  assert.equal(resolveLocalToolResult('s2', 'user-a', 'tool-1', { ok: true, text: 'hi' }), true);
  assert.deepEqual(await delivered, { ok: true, text: 'hi' });
  assert.equal(entry.pending.size, 0);
});

test('releaseLocalToolStream rejects leftover pending calls and drops the entry', async () => {
  registerLocalToolStream('s3', 'user-a');
  const entry = localToolStreams.get('s3');
  const pending = new Promise((resolve) => {
    entry.pending.set('tool-9', resolve);
  });
  releaseLocalToolStream('s3');
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /closed before the tool finished/);
  assert.equal(localToolStreams.has('s3'), false);
});

test('unknown stream or toolCallId does not throw', () => {
  assert.equal(resolveLocalToolResult('missing', 'user-a', 'tool-1', { ok: true }), false);
  registerLocalToolStream('s4', 'user-a');
  assert.equal(resolveLocalToolResult('s4', 'user-a', 'no-such-tool', { ok: true }), false);
});
