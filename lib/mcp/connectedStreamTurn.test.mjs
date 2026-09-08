import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachConnectedAppsToStreamTurn,
  connectedAppsNote,
  mcpContextFromConversation,
  publicConnectedApps,
  shouldArmConnectedAppRegistry,
  turnNeedsConnectedAppResolve,
} from './connectedStreamTurn.js';

test('ordinary Q&A does not need a connected-app resolve', () => {
  assert.equal(
    turnNeedsConnectedAppResolve({
      text: 'what is photosynthesis',
      connectedApps: [{ id: 'c1', name: 'Gmail', status: 'connected' }],
    }),
    false,
  );
  assert.equal(
    turnNeedsConnectedAppResolve({
      text: 'hello',
      connectedApps: [{ id: 'c1', name: 'Slack', catalogId: 'slack' }],
    }),
    false,
  );
});

test('email, named apps, and follow-up context still resolve', () => {
  assert.equal(
    turnNeedsConnectedAppResolve({ text: 'email John the notes from today' }),
    true,
  );
  assert.equal(
    turnNeedsConnectedAppResolve({
      text: 'check Mailchimp',
      connectedApps: [{ id: 'c1', name: 'Mailchimp', catalogId: 'mailchimp' }],
    }),
    true,
  );
  assert.equal(
    turnNeedsConnectedAppResolve({
      text: 'ok now send it',
      contextText: 'Draft this email to Alex about the launch.',
    }),
    true,
  );
  assert.equal(
    turnNeedsConnectedAppResolve({ text: 'can you see the tool I just connected?' }),
    true,
  );
});

test('registry arms only when the turn needs an external app', () => {
  assert.equal(shouldArmConnectedAppRegistry(null), false);
  assert.equal(
    shouldArmConnectedAppRegistry({ resolution: { reason: 'no_connections', tools: [] } }),
    false,
  );
  assert.equal(
    shouldArmConnectedAppRegistry({
      needs: [],
      resolution: { reason: 'no_external_need', tools: [] },
    }),
    false,
  );
  assert.equal(
    shouldArmConnectedAppRegistry({
      needs: ['communication.email.read'],
      resolution: { reason: 'resolved', tools: [{ toolName: 'GMAIL_FETCH' }] },
    }),
    true,
  );
  assert.equal(
    shouldArmConnectedAppRegistry({
      needs: ['communication.email.send'],
      resolution: { reason: 'no_matching_tools', tools: [] },
    }),
    true,
  );
  assert.equal(
    shouldArmConnectedAppRegistry({
      needs: [],
      resolution: { reason: 'ambiguous_account', tools: [], ambiguous: true },
    }),
    true,
  );
});

test('ambiguous-account note names the candidates', () => {
  const note = connectedAppsNote({
    resolution: {
      ambiguous: true,
      candidates: [
        { accountIdentity: 'ada@lykn.io' },
        { accountLabel: 'Work Slack' },
      ],
    },
  });
  assert.match(note, /CONNECTED_APPS_NOTE/);
  assert.match(note, /ada@lykn\.io/);
  assert.match(note, /Work Slack/);
  assert.equal(connectedAppsNote({ resolution: { ambiguous: false } }), '');
});

test('conversation context keeps a short recent window', () => {
  const ctx = mcpContextFromConversation([
    { role: 'user', content: 'a'.repeat(800) },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'send it' },
  ]);
  assert.ok(ctx.includes('send it'));
  assert.ok(ctx.length < 1300);
});

test('publicConnectedApps keeps connected rows only', () => {
  assert.deepEqual(
    publicConnectedApps([
      { id: 'c1', name: 'Gmail', status: 'connected', catalogId: 'gmail' },
      { id: 'c2', name: 'Slack', status: 'disconnected', catalogId: 'slack' },
    ]),
    [{ id: 'c1', name: 'Gmail', accountLabel: undefined, accountIdentity: undefined, catalogId: 'gmail' }],
  );
});

test('attach keeps awareness and skips resolve on a lean turn', async () => {
  let listed = false;
  const attached = await attachConnectedAppsToStreamTurn({
    manager: {
      store: {
        async list() {
          listed = true;
          return [{ id: 'c1', name: 'Gmail', status: 'connected' }];
        },
      },
    },
    userId: 'user-1',
    authHeader: 'Bearer x',
    text: 'what is photosynthesis',
    conversation: [],
    context: '',
    streamDisclosure: { keepToolsOn: false, firstPartyToolNames: [] },
    streamChatToolNames: [],
    connectedApps: [{ id: 'c1', name: 'Gmail' }],
    fetchConnectedToolsSection: async () => '[CONNECTED_TOOLS]\nGmail',
  });
  assert.equal(listed, false);
  assert.match(attached.context, /CONNECTED_TOOLS/);
  assert.equal(attached.useTools, false);
  assert.equal(attached.mcpTurn, null);
  assert.equal(attached.streamDisclosure.keepToolsOn, false);
  assert.equal(attached.streamChatToolNames.includes('lykn_search_connected_tools'), false);
});

test('attach arms search/call when resolve finds a real need', async () => {
  const attached = await attachConnectedAppsToStreamTurn({
    manager: {
      store: {
        async list() {
          return [{
            id: 'c1',
            name: 'Gmail',
            status: 'connected',
            catalogId: 'gmail',
            classifiedTools: [],
          }];
        },
      },
    },
    userId: 'user-1',
    authHeader: 'Bearer x',
    text: 'email John the notes from today',
    conversation: [],
    context: '',
    streamDisclosure: { keepToolsOn: false, firstPartyToolNames: [] },
    streamChatToolNames: [],
    connectedApps: [{ id: 'c1', name: 'Gmail' }],
    fetchConnectedToolsSection: async () => '',
  });
  assert.equal(attached.useTools, true);
  assert.equal(attached.streamDisclosure.keepToolsOn, true);
  assert.ok(attached.streamChatToolNames.includes('lykn_search_connected_tools'));
  assert.ok(attached.streamChatToolNames.includes('lykn_call_connected_tool'));
});
