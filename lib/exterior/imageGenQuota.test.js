import test from 'node:test';
import assert from 'node:assert/strict';
import { IMAGE_GEN_MONTHLY_LIMIT } from './constants.js';

test('IMAGE_GEN_MONTHLY_LIMIT defaults to 0 (unlimited — cap temporarily lifted)', () => {
  assert.equal(IMAGE_GEN_MONTHLY_LIMIT, 0);
});
