import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CursorCredentialError,
  fetchCursorIdentity,
  validateCursorCredential,
} from './cursorCredential.js';

test('Cursor credential validation returns typed metadata without echoing secrets', async () => {
  const result = await validateCursorCredential(
    { api_key: 'cursor-secret', repo: 'lykn/example' },
    {
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers.Authorization, 'Bearer cursor-secret');
        return {
          ok: true,
          status: 200,
          json: async () => ({ userEmail: 'owner@example.com', apiKeyName: 'Build key' }),
        };
      },
    },
  );
  assert.equal(result.secret, 'cursor-secret');
  assert.equal(result.label, 'Cursor (Build key)');
  assert.equal(result.metadata.default_repo, 'https://github.com/lykn/example');
  assert.equal(JSON.stringify(result.metadata).includes('cursor-secret'), false);
});

test('Cursor rejects invalid keys with a safe user-facing error', async () => {
  await assert.rejects(
    () => fetchCursorIdentity('bad-key', {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
      }),
    }),
    (error) => error instanceof CursorCredentialError && !error.message.includes('bad-key'),
  );
});
