import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stripChatArtifacts,
  exchangeToTrainingPair,
  pairsFromConversationExchanges,
} from './cleanConversationPairs.js';

test('stripChatArtifacts removes learned tags and attachments', () => {
  const raw =
    'Hello there <learned kind="identity">secret</learned> and more [ATTACHMENTS_JSON:{"x":1}]';
  const out = stripChatArtifacts(raw);
  assert.equal(out, 'Hello there and more');
});

test('exchangeToTrainingPair maps user/assistant messages', () => {
  const row = exchangeToTrainingPair({
    user_message: 'How should I structure this essay?',
    assistant_message:
      'Start with a one-sentence thesis, then three sections with evidence from your vault notes.',
  });
  assert.ok(row);
  assert.match(row.prompt, /essay/);
  assert.match(row.response, /thesis/);
});

test('pairsFromConversationExchanges caps and filters short rows', () => {
  const exchanges = [
    { user_message: 'ok', assistant_message: 'short' },
    {
      user_message: 'What is the best way to plan a product launch?',
      assistant_message:
        'Break the launch into three phases: positioning, beta feedback, and public announcement with clear metrics.',
    },
  ];
  const { pairs, exchangesUsed } = pairsFromConversationExchanges(exchanges, { maxPairs: 5 });
  assert.equal(pairs.length, 1);
  assert.equal(exchangesUsed, 1);
});
