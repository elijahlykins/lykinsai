import test from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_PREFERENCE_DEFAULTS,
  mergePreferenceRow,
  sanitisePreferencesPatch,
} from './preferencePatch.js';

test('mergePreferenceRow keeps sibling fields when one toggle changes', () => {
  const existing = {
    ...USER_PREFERENCE_DEFAULTS,
    memory_paused: true,
    email_product_updates: false,
    metadata: { theme: 'dark' },
  };
  const row = mergePreferenceRow(existing, { night_shift_enabled: true });
  assert.equal(row.memory_paused, true);
  assert.equal(row.email_product_updates, false);
  assert.equal(row.night_shift_enabled, true);
  assert.equal(row.metadata.theme, 'dark');
});

test('mergePreferenceRow shallow-merges metadata instead of replacing it', () => {
  const existing = {
    ...USER_PREFERENCE_DEFAULTS,
    metadata: { theme: 'dark', seen_product_update_id: 'old' },
  };
  const row = mergePreferenceRow(existing, {
    metadata: { seen_product_update_id: '2026-09-desktop' },
  });
  assert.equal(row.metadata.theme, 'dark');
  assert.equal(row.metadata.seen_product_update_id, '2026-09-desktop');
});

test('sanitisePreferencesPatch rejects empty bodies', () => {
  assert.equal(sanitisePreferencesPatch({}).ok, false);
  assert.equal(sanitisePreferencesPatch({ metadata: { seen_product_update_id: 'x' } }).ok, true);
});
