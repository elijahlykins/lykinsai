import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHIEF_OF_STAFF_RULES,
  formatDefaultMainAgentBlock,
  formatMainAgentOrchestrationBlock,
} from './mainAgentOrchestration.js';

const roster = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'Coding bot', description: 'Writes and reviews code' },
];

test('default LYKN block keeps folder reads on the chief of staff', () => {
  const block = formatDefaultMainAgentBlock(roster);
  assert.match(block, /chief of staff/i);
  assert.match(block, /Never hand off a folder/);
  assert.doesNotMatch(block, /fits one of these models better/);
  for (const line of CHIEF_OF_STAFF_RULES) {
    assert.match(block, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('configured main-agent block uses the same keep-it rule', () => {
  const block = formatMainAgentOrchestrationBlock(
    { name: 'LYKN', isMainAgent: true },
    roster,
  );
  assert.match(block, /chief of staff/i);
  assert.match(block, /Never hand off a folder/);
  assert.doesNotMatch(block, /fits a sub-agent better/);
});
