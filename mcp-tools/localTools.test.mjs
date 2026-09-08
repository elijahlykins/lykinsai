import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeLocalSystemAsk,
  LOCAL_TOOL_NAMES,
  LOCAL_CHAT_TOOLS,
  DESKTOP_MCP_TOOL_NAMES,
  sanitizeDesktopMcpApps,
  mentionsDesktopMcpApp,
  messageWantsMcpConnect,
} from './localTools.js';
import {
  messageWantsBotAsk,
  conversationMentionedLocalFolder,
  messageLooksLikeFolderInspectFollowUp,
  turnWantsLocalFileTools,
} from './chatIntentSignals.js';
import { sanitizeLyknBots } from './chatTools.js';

test('named-file peeks are local asks', () => {
  assert.equal(looksLikeLocalSystemAsk("what's in agents.md"), true);
  assert.equal(looksLikeLocalSystemAsk('what is in notes.txt'), true);
  assert.equal(looksLikeLocalSystemAsk('read src/app.ts'), true);
  assert.equal(looksLikeLocalSystemAsk("what's in that file"), true);
  assert.equal(looksLikeLocalSystemAsk('analyze this folder'), true);
  assert.equal(looksLikeLocalSystemAsk('review the files in here'), true);
  assert.equal(looksLikeLocalSystemAsk('can you find where the build feature sits in this'), true);
  assert.equal(looksLikeLocalSystemAsk("let's brainstorm a new onboarding flow"), false);
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

test('later brainstorming does not keep prior-folder local tools on', () => {
  const conversation = [{
    role: 'user',
    content: 'Desktop folder "Docs" — call local_list_dir or local_read_file\nPath: /Users/me/Docs',
  }];
  assert.equal(
    turnWantsLocalFileTools({
      localMode: true,
      message: "let's brainstorm a new onboarding flow",
      conversation,
    }),
    false,
  );
  assert.equal(
    turnWantsLocalFileTools({
      localMode: true,
      message: "what's in agents.md",
      conversation,
    }),
    true,
  );
  assert.equal(
    turnWantsLocalFileTools({
      localMode: true,
      message: 'what do you think?',
      attachedFolders: [{ name: 'Docs', path: '/Users/me/Docs' }],
    }),
    true,
  );
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

test('local_read_file schema exposes offset/limit for paginated reads', () => {
  const spec = LOCAL_CHAT_TOOLS.find((tool) => tool.name === 'local_read_file');
  assert.ok(spec);
  assert.equal(spec.inputSchema.properties.offset.type, 'integer');
  assert.equal(spec.inputSchema.properties.limit.type, 'integer');
});

test('local_install_app lets the model pick an app-specific dock icon', () => {
  const spec = LOCAL_CHAT_TOOLS.find((tool) => tool.name === 'local_install_app');
  assert.ok(spec);
  const icon = spec.inputSchema.properties.icon;
  assert.equal(icon.type, 'string');
  // The description must push a DELIBERATE, app-specific pick (a shooter gets
  // a crosshair, not whatever generic tile the dock falls back to) and promise
  // that the user's own pick is never overridden.
  assert.match(icon.description, /Lucide icon name/i);
  assert.match(icon.description, /fits THIS specific app/);
  assert.match(icon.description, /ALWAYS pick one/);
  assert.match(icon.description, /never overridden/);
});

test('local_browser_agent does not let the model choose a chatId', () => {
  const spec = LOCAL_CHAT_TOOLS.find((tool) => tool.name === 'local_browser_agent');
  assert.ok(spec);
  assert.equal(spec.inputSchema.properties.chatId, undefined);
  assert.deepEqual(Object.keys(spec.inputSchema.properties).sort(), ['task', 'url']);
  assert.equal(spec.inputSchema.additionalProperties, false);
});

test('desktop MCP registry tools are schema-only local tools', () => {
  assert.deepEqual(DESKTOP_MCP_TOOL_NAMES, [
    'local_mcp_search_tools',
    'local_mcp_call_tool',
    'local_mcp_catalog',
    'local_mcp_connect',
  ]);
  for (const name of DESKTOP_MCP_TOOL_NAMES) {
    assert.ok(LOCAL_TOOL_NAMES.includes(name), `${name} must ride the client-executed lane`);
    const spec = LOCAL_CHAT_TOOLS.find((tool) => tool.name === name);
    assert.ok(spec, `${name} needs a schema`);
    assert.equal(spec.inputSchema.additionalProperties, false);
  }
  const call = LOCAL_CHAT_TOOLS.find((tool) => tool.name === 'local_mcp_call_tool');
  assert.deepEqual(call.inputSchema.required, ['app', 'tool']);
});

test('local_mcp_connect teaches the safe paths: catalog first, env flow, setup steps', () => {
  const connect = LOCAL_CHAT_TOOLS.find((tool) => tool.name === 'local_mcp_connect');
  // Nothing is required: `app` alone (catalog) or `commandLine` alone (custom)
  // are both complete calls — the IPC side rejects the empty case with guidance.
  assert.equal(connect.inputSchema.required, undefined);
  assert.match(connect.description, /approves the exact command/);
  assert.match(connect.description, /env_required/);
  assert.match(connect.description, /stored encrypted/);
  assert.match(connect.inputSchema.properties.commandLine.description, /no shells/i);
  assert.match(connect.inputSchema.properties.env.description, /never invent values/);

  const catalog = LOCAL_CHAT_TOOLS.find((tool) => tool.name === 'local_mcp_catalog');
  assert.match(catalog.description, /DETECTED/);
  assert.match(catalog.description, /local_mcp_connect/);
});

test('messageWantsMcpConnect catches connect asks and ignores plain chat', () => {
  assert.equal(messageWantsMcpConnect('connect to blender'), true);
  assert.equal(messageWantsMcpConnect('hook me up to notion'), true);
  assert.equal(messageWantsMcpConnect('can you link lykn with my obsidian vault'), true);
  assert.equal(messageWantsMcpConnect('add an mcp server for godot'), true);
  assert.equal(messageWantsMcpConnect('install the playwright mcp'), true);
  assert.equal(messageWantsMcpConnect('what tools can you work with on this mac'), true);
  assert.equal(messageWantsMcpConnect('take over ableton and make a beat'), true);
  assert.equal(messageWantsMcpConnect('how do I bake bread'), false);
  assert.equal(messageWantsMcpConnect('summarize this article for me'), false);
  assert.equal(messageWantsMcpConnect('connect the dots between these two ideas'), false);
  assert.equal(messageWantsMcpConnect(''), false);
});

test('sanitizeDesktopMcpApps caps and whitelists renderer input', () => {
  assert.deepEqual(sanitizeDesktopMcpApps(null), []);
  assert.deepEqual(sanitizeDesktopMcpApps('nope'), []);
  const cleaned = sanitizeDesktopMcpApps([
    { name: 'Blender', toolCount: 17, tools: ['get_scene_info', 'execute_blender_code'] },
    { name: '', toolCount: 5, tools: [] },
    { name: 'X'.repeat(200), toolCount: -3, tools: Array(20).fill('t'), extra: 'dropped' },
  ]);
  assert.equal(cleaned.length, 2);
  assert.deepEqual(cleaned[0], {
    name: 'Blender',
    toolCount: 17,
    tools: ['get_scene_info', 'execute_blender_code'],
  });
  assert.equal(cleaned[1].name.length, 60);
  assert.equal(cleaned[1].toolCount, 0);
  assert.equal(cleaned[1].tools.length, 6);
  assert.equal(cleaned[1].extra, undefined);
});

test('naming a connected desktop MCP app is intent; small talk is not', () => {
  const apps = [{ name: 'Blender', toolCount: 17, tools: [] }];
  assert.equal(mentionsDesktopMcpApp('make me a donut in blender', apps), true);
  assert.equal(mentionsDesktopMcpApp('add a cube to the Blender scene', apps), true);
  assert.equal(mentionsDesktopMcpApp('what is a good 3d tool', apps), false);
  assert.equal(mentionsDesktopMcpApp('make me a donut in blender', []), false);
  assert.equal(mentionsDesktopMcpApp('', apps), false);
});
