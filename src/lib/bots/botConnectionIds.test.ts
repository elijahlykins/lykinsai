import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignBotConnections,
  cleanConnectionIds,
  createBot,
  parseBots,
  serializeBots,
} from '@/lib/bots/botStore';

test('Bot connectionIds are an allowlist and never keep secrets', () => {
  const bot = createBot({
    name: 'Mailer',
    connectionIds: ['conn_work', 'sk-secret.token', 'Bearer abc'],
  });
  assert.deepEqual(bot.connectionIds, ['conn_work']);
  const revived = parseBots(serializeBots([bot]));
  assert.deepEqual(revived[0].connectionIds, ['conn_work']);
  assert.ok(!serializeBots([bot]).includes('sk-secret'));
});

test('undefined Bot connections mean all; empty means none', () => {
  const open = createBot({ name: 'Open' });
  assert.equal(open.connectionIds, undefined);
  const none = assignBotConnections(open, []);
  assert.deepEqual(none.connectionIds, []);
  const subset = assignBotConnections(none, ['conn_work']);
  assert.deepEqual(subset.connectionIds, ['conn_work']);
});

test('cleanConnectionIds drops token-shaped values', () => {
  assert.deepEqual(cleanConnectionIds(['ok_1', 'secret.token', '']), ['ok_1']);
});
