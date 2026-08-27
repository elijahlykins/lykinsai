import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decryptToken,
  decryptTokenWithKey,
  encryptToken,
  encryptTokenWithKey,
} from './credentialStore.js';

const KEY = '11'.repeat(32);
const OTHER_KEY = '22'.repeat(32);

test('generic credential crypto preserves the legacy AES-GCM blob format', () => {
  const previous = process.env.CONNECTOR_TOKEN_KEY;
  process.env.CONNECTOR_TOKEN_KEY = KEY;
  try {
    const encrypted = encryptToken('secret-value');
    assert.equal(encrypted.split(':').length, 3);
    assert.equal(decryptToken(encrypted), 'secret-value');
    assert.equal(decryptTokenWithKey(encrypted, KEY), 'secret-value');
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_TOKEN_KEY;
    else process.env.CONNECTOR_TOKEN_KEY = previous;
  }
});

test('explicit keys support safe rotation and reject the wrong key', () => {
  const encrypted = encryptTokenWithKey('rotate-me', KEY);
  assert.equal(decryptTokenWithKey(encrypted, KEY), 'rotate-me');
  assert.throws(() => decryptTokenWithKey(encrypted, OTHER_KEY));
});

test('credential crypto fails closed without a valid key', () => {
  const previous = process.env.CONNECTOR_TOKEN_KEY;
  delete process.env.CONNECTOR_TOKEN_KEY;
  try {
    assert.throws(() => encryptToken('never plaintext'), /CONNECTOR_TOKEN_KEY is not set/);
  } finally {
    if (previous !== undefined) process.env.CONNECTOR_TOKEN_KEY = previous;
  }
});
