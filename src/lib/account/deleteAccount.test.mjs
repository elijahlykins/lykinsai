import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_DELETE_CONFIRM_PHRASE,
  canSubmitAccountDeletion,
  requestAccountDeletion,
} from './deleteAccount.js';

test('deletion does not submit until the confirm phrase matches exactly', () => {
  assert.equal(canSubmitAccountDeletion(''), false);
  assert.equal(canSubmitAccountDeletion('delete'), false);
  assert.equal(canSubmitAccountDeletion('DELETE '), true);
  assert.equal(canSubmitAccountDeletion(ACCOUNT_DELETE_CONFIRM_PHRASE), true);
});

test('requestAccountDeletion does not call the API without confirmation', async () => {
  let called = 0;
  const out = await requestAccountDeletion({
    apiBase: 'https://api.lykn.io',
    token: 'tok',
    confirm: 'please',
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(called, 0);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'confirmation_required');
});

test('requestAccountDeletion sends an authenticated DELETE with the server phrase', async () => {
  let captured = null;
  const out = await requestAccountDeletion({
    apiBase: 'https://api.lykn.io/',
    token: 'sess-token',
    confirm: 'DELETE',
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(captured.url, 'https://api.lykn.io/api/account');
  assert.equal(captured.init.method, 'DELETE');
  assert.equal(captured.init.headers.Authorization, 'Bearer sess-token');
  assert.equal(JSON.parse(captured.init.body).confirm, 'DELETE');
});

test('requestAccountDeletion requires a session token', async () => {
  const out = await requestAccountDeletion({
    apiBase: 'https://api.lykn.io',
    token: '',
    confirm: 'DELETE',
    fetchImpl: async () => {
      throw new Error('should not fetch');
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'not_signed_in');
});
