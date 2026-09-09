import test from 'node:test';
import assert from 'node:assert/strict';

import {
  UNLIMITED_USAGE_EMAILS,
  clearUnlimitedUsage,
  grantUnlimitedUsage,
  isUnlimitedUsage,
  isUnlimitedUsageEmail,
  markUnlimitedUsage,
} from './internalAccounts.js';

test('admin@lykn.io is hardcoded as unlimited usage', () => {
  assert.equal(UNLIMITED_USAGE_EMAILS.has('admin@lykn.io'), true);
  assert.equal(isUnlimitedUsageEmail('admin@lykn.io'), true);
  assert.equal(isUnlimitedUsageEmail('Admin@Lykn.io'), true);
  assert.equal(isUnlimitedUsageEmail('jaeminw8@gmail.com'), true);
  assert.equal(isUnlimitedUsageEmail('someone@lykn.io'), false);
  assert.equal(isUnlimitedUsageEmail(''), false);
  assert.equal(isUnlimitedUsageEmail(null), false);
});

test('grantUnlimitedUsage remembers the userId for later settlement', () => {
  const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  clearUnlimitedUsage(userId);
  try {
    assert.equal(isUnlimitedUsage(userId), false);
    assert.equal(grantUnlimitedUsage({ userId, email: 'admin@lykn.io' }), true);
    assert.equal(isUnlimitedUsage(userId), true);
    assert.equal(grantUnlimitedUsage({ userId, email: null }), true);
    assert.equal(grantUnlimitedUsage({ userId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', email: 'other@example.com' }), false);
  } finally {
    clearUnlimitedUsage();
  }
});

test('markUnlimitedUsage can be cleared', () => {
  const userId = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
  markUnlimitedUsage(userId);
  assert.equal(isUnlimitedUsage(userId), true);
  clearUnlimitedUsage(userId);
  assert.equal(isUnlimitedUsage(userId), false);
});
