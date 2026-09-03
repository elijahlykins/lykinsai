import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeLocalSystemAsk, LOCAL_TOOL_NAMES, LOCAL_CHAT_TOOLS } from './localTools.js';
import {
  messageWantsBotAsk,
  conversationMentionedLocalFolder,
  messageLooksLikeFolderInspectFollowUp,
} from './chatIntentSignals.js';
import { sanitizeLyknBots } from './chatTools.js';

test('named-file peeks are local asks', () => {
  assert.equal(looksLikeLocalSystemAsk("what's in agents.md"), true);
  assert.equal(looksLikeLocalSystemAsk('what is in notes.txt'), true);
  assert.equal(looksLikeLocalSystemAsk('read src/app.ts'), true);
  assert.equal(looksLikeLocalSystemAsk("what's in that file"), true);
});

test('named folders and list-whats-inside are local asks', () => {
  assert.equal(looksLikeLocalSystemAsk('hey can you read my LYKN folder'), true);
  assert.equal(looksLikeLocalSystemAsk('just list whats inside'), true);
  assert.equal(looksLikeLocalSystemAsk("just list what's inside"), true);
  assert.equal(looksLikeLocalSystemAsk("it's on my machine"), true);
  assert.equal(looksLikeLocalSystemAsk("you can't search the folders or files in this chat"), true);
});

test('ok check them continues a named-folder conversation', () => {
  assert.equal(messageLooksLikeFolderInspectFollowUp('ok check them'), true);
  assert.equal(messageLooksLikeFolderInspectFollowUp('compare them'), true);
  assert.equal(messageLooksLikeFolderInspectFollowUp('check those'), true);
  assert.equal(
    conversationMentionedLocalFolder([
      { role: 'user', content: "you can't search the folders or files in this chat" },
    ]),
    true,
  );
  assert.equal(messageLooksLikeFolderInspectFollowUp('hello'), false);
});

test('ordinary chat is not a local ask', () => {
  assert.equal(looksLikeLocalSystemAsk('hello'), false);
  assert.equal(looksLikeLocalSystemAsk('what is markdown'), false);
  assert.equal(looksLikeLocalSystemAsk('thanks'), false);
});

test('ask-bot intent matches named teammates and generic consults', () => {
  const bots = [{ id: 'bot_cody', name: 'Cody', role: 'Architect' }];
  assert.equal(messageWantsBotAsk('ask Cody what he thinks about the current agent structure', bots), true);
  assert.equal(messageWantsBotAsk('what does Cody think', bots), true);
  assert.equal(messageWantsBotAsk('ask my bot about this', []), true);
  assert.equal(messageWantsBotAsk('send a bot to start work in the browser', []), true);
  assert.equal(messageWantsBotAsk('run one of the bots', []), true);
  assert.equal(messageWantsBotAsk('hello', bots), false);
  assert.equal(messageWantsBotAsk('ask me later', []), false);
  assert.equal(LOCAL_TOOL_NAMES.includes('local_ask_bot'), true);
});

test('sanitizeLyknBots keeps known fields only', () => {
  assert.deepEqual(
    sanitizeLyknBots([{ id: ' bot_1 ', name: ' Cody ', role: ' Architect ', secret: 'nope' }, { name: 'Nope' }]),
    [{ id: 'bot_1', name: 'Cody', role: 'Architect' }],
  );
});

test('local_browser_agent does not let the model choose a chatId', () => {
  const spec = LOCAL_CHAT_TOOLS.find((tool) => tool.name === 'local_browser_agent');
  assert.ok(spec);
  assert.equal(spec.inputSchema.properties.chatId, undefined);
  assert.deepEqual(Object.keys(spec.inputSchema.properties).sort(), ['task', 'url']);
  assert.equal(spec.inputSchema.additionalProperties, false);
});
