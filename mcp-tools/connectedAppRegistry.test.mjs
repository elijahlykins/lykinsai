import test from 'node:test';
import assert from 'node:assert/strict';

import { interpretConnectedToolPayload, identityFromToolResult } from './connectedAppRegistry.js';
import { unresolvedRequiredArgs } from '../lib/mcp/toolRegistrySearch.js';

test('unresolvedRequiredArgs ignores pagination and supplied values', () => {
  const schema = {
    required: ['installation_id', 'page'],
    properties: {
      installation_id: { type: 'integer' },
      page: { type: 'integer', default: 1 },
    },
  };
  assert.deepEqual(unresolvedRequiredArgs(schema, {}), ['installation_id']);
  assert.deepEqual(unresolvedRequiredArgs(schema, { installation_id: 9 }), []);
  assert.deepEqual(unresolvedRequiredArgs({ required: ['path'] }, { path: '' }), []);
});

test('identityFromToolResult reads a handle or email from any app payload', () => {
  assert.equal(identityFromToolResult({ data: { login: 'elijahlykins' } }), 'elijahlykins');
  assert.equal(identityFromToolResult({ data: { email: 'ada@lykn.io' } }), 'ada@lykn.io');
  assert.equal(identityFromToolResult({ data: { username: 'ada' } }), 'ada');
});

test('interpretConnectedToolPayload treats Composio successful:false as a failed call', () => {
  const executed = {
    ok: true,
    status: 'completed',
    observation: {
      kind: 'external_untrusted_observation',
      data: {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            successful: false,
            error: 'Forbidden',
            data: { status_code: 403 },
          }),
        }],
      },
    },
  };
  const read = interpretConnectedToolPayload(executed);
  assert.equal(read.failed, true);
  assert.equal(read.statusCode, 403);
});
