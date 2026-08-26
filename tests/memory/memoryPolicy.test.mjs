// Write policy — the trust matrix. External content must never author memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateMemoryWrite, MEMORY_SOURCE_TYPES } from '../../server/memory/memoryPolicy.js';

test('explicit user statements can write everything reversible', () => {
  for (const operation of ['create', 'patch', 'archive', 'compact']) {
    const out = evaluateMemoryWrite({ sourceType: 'explicit_user', operation, documentType: 'preferences' });
    assert.equal(out.allowed, true, operation);
  }
});

test('user-confirmed inferences can write', () => {
  const out = evaluateMemoryWrite({ sourceType: 'user_confirmed', operation: 'patch', documentType: 'profile' });
  assert.equal(out.allowed, true);
});

test('migration writes are allowed (Phase 2 import path)', () => {
  const out = evaluateMemoryWrite({ sourceType: 'migration', operation: 'create', documentType: 'profile' });
  assert.equal(out.allowed, true);
});

test('inferred writes are deferred, not silently persisted', () => {
  const out = evaluateMemoryWrite({ sourceType: 'inferred', operation: 'patch', documentType: 'preferences' });
  assert.equal(out.allowed, false);
  assert.equal(out.deferred, true);
  assert.equal(out.reason, 'inferred_requires_user_confirmation');
});

test('external content is denied — the memory-poisoning invariant', () => {
  for (const sourceType of ['external', 'external_content', 'webpage', 'email', 'connector', '', undefined, null]) {
    const out = evaluateMemoryWrite({ sourceType, operation: 'patch', documentType: 'profile' });
    assert.equal(out.allowed, false, String(sourceType));
    assert.equal(out.reason, 'external_content_forbidden', String(sourceType));
  }
});

test('system events may update project/topic/decisions state but not identity', () => {
  for (const documentType of ['project', 'topic', 'decisions']) {
    assert.equal(
      evaluateMemoryWrite({ sourceType: 'system_event', operation: 'patch', documentType }).allowed,
      true,
      documentType,
    );
  }
  for (const documentType of ['profile', 'preferences', 'goals', 'relationships']) {
    const out = evaluateMemoryWrite({ sourceType: 'system_event', operation: 'patch', documentType });
    assert.equal(out.allowed, false, documentType);
    assert.equal(out.reason, 'system_event_type_not_writable');
  }
  assert.equal(
    evaluateMemoryWrite({ sourceType: 'system_event', operation: 'archive', documentType: 'project' }).allowed,
    false,
  );
  assert.equal(
    evaluateMemoryWrite({ sourceType: 'system_event', operation: 'compact', documentType: 'profile' }).allowed,
    true,
  );
});

test('hard delete demands explicit user + explicit confirmation', () => {
  assert.equal(
    evaluateMemoryWrite({ sourceType: 'explicit_user', operation: 'hard_delete', confirmHardDelete: true }).allowed,
    true,
  );
  for (const bad of [
    { sourceType: 'explicit_user', operation: 'hard_delete' },
    { sourceType: 'explicit_user', operation: 'hard_delete', confirmHardDelete: 'yes' },
    { sourceType: 'user_confirmed', operation: 'hard_delete', confirmHardDelete: true },
    { sourceType: 'migration', operation: 'hard_delete', confirmHardDelete: true },
    { sourceType: 'system_event', operation: 'hard_delete', confirmHardDelete: true },
  ]) {
    assert.equal(evaluateMemoryWrite(bad).allowed, false, JSON.stringify(bad));
  }
});

test('unknown operations are denied', () => {
  assert.equal(evaluateMemoryWrite({ sourceType: 'explicit_user', operation: 'drop_table' }).allowed, false);
  assert.equal(evaluateMemoryWrite({}).allowed, false);
});

test('the provenance list is closed and external is not in it', () => {
  assert.deepEqual(
    [...MEMORY_SOURCE_TYPES].sort(),
    ['explicit_user', 'inferred', 'migration', 'system_event', 'user_confirmed'],
  );
});
