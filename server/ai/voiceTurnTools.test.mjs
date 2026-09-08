import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveVoiceToolsForUtterance,
  utteranceWantsLiveScreen,
} from './voiceTurnTools.js';

test('ordinary spoken Q&A does not list MCP connections', async () => {
  let listed = false;
  const out = await resolveVoiceToolsForUtterance({
    manager: {
      store: {
        async list() {
          listed = true;
          return [{ id: 'c1', name: 'Gmail', status: 'connected' }];
        },
      },
    },
    userId: 'user-1',
    message: 'what is photosynthesis',
    conversation: [],
    localMode: false,
    lyknBots: [],
  });
  assert.equal(listed, false);
  assert.equal(out.tools.some((t) => t.name === 'lykn_search_connected_tools'), false);
  assert.equal(out.mcpTurn.tools.length, 0);
});

test('an email ask still resolves connected-app tools', async () => {
  let listed = false;
  const out = await resolveVoiceToolsForUtterance({
    manager: {
      store: {
        async list() {
          listed = true;
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
    message: 'email John the notes from today',
    conversation: [],
  });
  assert.equal(listed, true);
  assert.ok(out.disclosure.externalNeeds?.length || out.mcpTurn.needs?.length);
});

test('follow-up send it after an email draft still resolves', async () => {
  let listed = false;
  await resolveVoiceToolsForUtterance({
    manager: {
      store: {
        async list() {
          listed = true;
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
    message: 'ok now send it',
    conversation: [{ role: 'user', content: 'Draft this email to Alex about the launch.' }],
  });
  assert.equal(listed, true);
});

test('screen asks are the only ones that should hit the shared screen row', () => {
  assert.equal(utteranceWantsLiveScreen('hello'), false);
  assert.equal(utteranceWantsLiveScreen('what is photosynthesis'), false);
  assert.equal(utteranceWantsLiveScreen("what's on my screen"), true);
  assert.equal(utteranceWantsLiveScreen('what is this'), true);
});

test('a greeting without Local Mode does not attach local file tools', async () => {
  const out = await resolveVoiceToolsForUtterance({
    message: 'hello',
    conversation: [],
    localMode: false,
  });
  assert.equal(out.interruptForTools, false);
  assert.equal(out.tools.some((t) => t.name === 'local_list_dir'), false);
  assert.equal(out.tools.some((t) => t.name === 'local_open_path'), false);
});

test('an action ask attaches the same Chat skill tools', async () => {
  const out = await resolveVoiceToolsForUtterance({
    message: 'generate an image of a red bicycle',
    conversation: [],
  });
  assert.equal(out.interruptForTools, true);
  assert.ok(out.tools.some((t) => t.name === 'generate_image'));
});

test('Local Mode offers Chat local discovery tools so the model can pick', async () => {
  const out = await resolveVoiceToolsForUtterance({
    message: 'hello',
    conversation: [],
    localMode: true,
  });
  assert.equal(out.interruptForTools, true);
  assert.ok(out.tools.some((t) => t.name === 'local_list_dir'));
  assert.ok(out.tools.some((t) => t.name === 'local_search_files'));
  assert.ok(out.tools.some((t) => t.name === 'local_open_path'));
});
