import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CHAT_TOOL_NAMES, runChatTool } from './chatTools.js';
import {
  LYKN_VOICE_TOOL_NAMES,
  RETIRED_VOICE_ALIASES,
  VOICE_TOOL_ALIAS_CLASS,
  measureVoiceToolSchemas,
} from './voiceTools.js';
import {
  filterOpenAiToolsForVoiceDisclosure,
  resolveVoiceTurnDisclosure,
  VOICE_TOOLS_BY_CAPABILITY,
} from './voiceToolResolver.js';
import { FIRST_PARTY_CAPABILITY_FAMILIES } from './firstPartyCapabilities.js';
import {
  GENERIC_CHAT_TOOL_GUIDANCE,
  GENERIC_VOICE_TOOL_GUIDANCE,
  buildCapabilityToolGuidance,
  buildSlimChatToolGuidance,
  buildVoiceFamilyGuidance,
  measureGuidanceText,
} from './chatToolGuidance.js';
import { MAX_EXTERNAL_TOOLS_PER_DISCLOSURE } from './firstPartyCapabilities.js';

function disclose(message, extra = {}) {
  return resolveVoiceTurnDisclosure({ message, ...extra });
}

function fakeMcpCatalog() {
  const tools = [];
  for (let i = 0; i < 50; i++) {
    tools.push({
      name: `gmail_tool_${i}`,
      description: 'gmail inbox email messages',
      connectionId: 'conn_gmail',
      connectionKind: 'gmail',
    });
    tools.push({
      name: `hubspot_tool_${i}`,
      description: 'hubspot CRM',
      connectionId: 'conn_hubspot',
      connectionKind: 'hubspot',
    });
  }
  return tools;
}

test('every capability family has a Voice mapping', () => {
  for (const family of FIRST_PARTY_CAPABILITY_FAMILIES) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(VOICE_TOOLS_BY_CAPABILITY, family),
      `Voice missing family ${family}`,
    );
  }
});

test('client Voice tool names stay in lockstep with the registry', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/lib/voice/voiceToolNames.ts'),
    'utf8',
  );
  for (const name of LYKN_VOICE_TOOL_NAMES) {
    assert.match(src, new RegExp(`"${name}"`), `client list missing ${name}`);
  }
  const overlay = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../electron/overlay-ui/voice.js'),
    'utf8',
  );
  for (const name of LYKN_VOICE_TOOL_NAMES) {
    if (name === 'ask_bot' || name === 'browser_agent' || name === 'update_voice_instructions') continue;
    assert.match(overlay, new RegExp(`"${name}"`), `overlay list missing ${name}`);
  }
});

test('every Voice def is classified and retired aliases are not live', () => {
  for (const name of LYKN_VOICE_TOOL_NAMES) {
    assert.ok(VOICE_TOOL_ALIAS_CLASS[name], `unclassified Voice tool ${name}`);
  }
  const live = new Set(LYKN_VOICE_TOOL_NAMES);
  for (const row of RETIRED_VOICE_ALIASES) {
    assert.equal(live.has(row.name), false, `${row.name} still in live Voice registry`);
  }
});

test('casual voice discloses 0 or a tiny tool set', () => {
  for (const message of ['hello', 'just tell me a joke', "how's it going"]) {
    const d = disclose(message);
    assert.ok(d.firstPartyToolNames.length <= 2, `"${message}" tools=${d.firstPartyToolNames.join(',')}`);
    assert.ok(d.inspect.approxTokens < 800, `"${message}" still expensive (${d.inspect.approxTokens})`);
  }
});

test('calendar voice discloses the calendar family, not the full registry', () => {
  const d = disclose("What's on my calendar today?");
  assert.ok(d.capabilities.includes('calendar.read'));
  assert.ok(d.firstPartyToolNames.includes('list_events'));
  assert.equal(d.firstPartyToolNames.includes('web_search'), false);
  assert.equal(d.firstPartyToolNames.includes('search_vault'), false);
  assert.ok(d.firstPartyToolNames.length < 12);
  assert.ok(d.inspect.approxTokens < 4000);
});

test('vault voice pulls things up with open_app, never the old vault search', () => {
  const d = disclose('Search my Vault for the contract.');
  assert.ok(d.capabilities.includes('vault.read'));
  assert.ok(d.firstPartyToolNames.includes('open_app'));
  assert.equal(d.firstPartyToolNames.includes('search_vault'), false);
  assert.equal(d.firstPartyToolNames.includes('read_document'), false);
  assert.equal(d.firstPartyToolNames.includes('display_document'), false);
  assert.equal(d.firstPartyToolNames.includes('list_events'), false);

  const pullUp = disclose('pull up the dashboard I made');
  assert.ok(pullUp.firstPartyToolNames.includes('open_app'));
  assert.equal(pullUp.firstPartyToolNames.includes('search_vault'), false);
});

test('weather voice uses web search, not vault', () => {
  const d = disclose("What's the weather?");
  assert.ok(d.firstPartyToolNames.includes('web_search'));
  assert.equal(d.firstPartyToolNames.includes('search_vault'), false);
});

test('reminder voice discloses reminders, not the full dump', () => {
  const d = disclose('Create a reminder to call Sam in an hour.');
  assert.ok(d.firstPartyToolNames.includes('create_reminder'));
  assert.ok(d.firstPartyToolNames.length < 10);
});

test('Gmail voice is a small Voice set plus ≤10 MCP tools', () => {
  const d = disclose('Check my Gmail.', { discoveredExternalTools: fakeMcpCatalog() });
  assert.ok(d.externalNeeds.includes('email'));
  assert.equal(d.firstPartyToolNames.includes('list_apps'), false);
  assert.equal(d.firstPartyToolNames.includes('call_app'), false);
  assert.ok(d.firstPartyToolNames.length < 8);
  assert.ok(d.externalTools.length <= MAX_EXTERNAL_TOOLS_PER_DISCLOSURE);
  assert.ok(d.externalTools.length > 0);
  assert.ok(d.externalTools.every((t) => /gmail|mail|inbox|email/i.test(`${t.name} ${t.description}`)));
});

test('custom REST list_apps is not an MCP fallback', () => {
  const gmail = disclose('Check my Gmail.');
  assert.equal(gmail.firstPartyToolNames.includes('list_apps'), false);
  const custom = disclose('what connected apps do I have');
  assert.ok(custom.firstPartyToolNames.includes('list_apps'));
  assert.ok(custom.firstPartyToolNames.includes('call_app'));
});

test('desktop voice discloses browser_agent and ask_bot for those asks', () => {
  const browse = disclose('run a browser agent and go to the Perplexity Computer website', {
    localMode: true,
  });
  assert.ok(browse.capabilities.includes('browser.agent'));
  assert.ok(browse.firstPartyToolNames.includes('browser_agent'));
  assert.equal(browse.firstPartyToolNames.includes('ask_bot'), false);

  const send = disclose('send Scout to start work in the browser', {
    localMode: true,
    lyknBots: [{ id: 'bot_scout', name: 'Scout', role: 'Research' }],
  });
  assert.ok(send.capabilities.includes('bots.ask'));
  assert.ok(send.firstPartyToolNames.includes('ask_bot'));
});

test('hello on desktop voice still discloses no bot or browser tools', () => {
  const d = disclose('hello', {
    localMode: true,
    lyknBots: [{ id: 'bot_scout', name: 'Scout', role: 'Research' }],
  });
  assert.equal(d.firstPartyToolNames.includes('ask_bot'), false);
  assert.equal(d.firstPartyToolNames.includes('browser_agent'), false);
});

test('full Voice registry is not dumped on a calendar turn', () => {
  const all = measureVoiceToolSchemas(LYKN_VOICE_TOOL_NAMES);
  const cal = disclose("What's on my calendar today?");
  assert.ok(all.count >= 30, `expected a large static registry, got ${all.count}`);
  assert.ok(cal.inspect.count < all.count / 2);
  assert.ok(cal.inspect.approxTokens < all.approxTokens / 2);
});

test('ElevenLabs-shaped tools[] is filtered to the disclosed subset', () => {
  const dump = LYKN_VOICE_TOOL_NAMES.map((name) => ({
    type: 'function',
    function: { name, description: 'x', parameters: { type: 'object' } },
  }));
  dump.push({
    type: 'function',
    function: { name: 'gmail_search', description: 'gmail inbox', parameters: { type: 'object' } },
  });
  dump.push({
    type: 'function',
    function: { name: 'list_custom_models', description: 'dead', parameters: { type: 'object' } },
  });
  const d = disclose("What's on my calendar today?", { discoveredExternalTools: fakeMcpCatalog() });
  const filtered = filterOpenAiToolsForVoiceDisclosure(dump, d);
  const names = filtered.map((t) => t.function.name);
  assert.ok(names.includes('list_events'));
  assert.equal(names.includes('search_vault'), false);
  assert.equal(names.includes('list_custom_models'), false);
  assert.equal(names.includes('gmail_search'), false);
});

test('capability guidance appears only when relevant and stale tools are absent', () => {
  const vault = buildCapabilityToolGuidance(['vault.write']);
  assert.match(vault, /save only when the user clearly asks/i);
  assert.equal(/lykn_searchVault/.test(vault), false);
  assert.equal(/lykn_call_app/.test(vault), false);
  assert.equal(/get_facts|get_beliefs|propose_fact/.test(vault), false);

  const cal = buildCapabilityToolGuidance(['calendar.write']);
  assert.match(cal, /dates\/timezones/i);
  assert.equal(/VAULT WRITE/.test(cal), false);

  const slim = buildSlimChatToolGuidance(['lykn_listEvents'], ['calendar.read']);
  assert.match(slim, /lykn_listEvents/);
  assert.match(slim, /Speak natural local times/);

  const voice = buildVoiceFamilyGuidance(['web.search']);
  assert.match(voice, /web_search/);
  assert.match(GENERIC_VOICE_TOOL_GUIDANCE, /Never mention deleted memory stores/);
  assert.equal(/\bcall get_facts\b|\buse get_beliefs\b/.test(GENERIC_VOICE_TOOL_GUIDANCE), false);
});

test('static Chat tool guidance is far smaller than the old 6K menu', () => {
  const generic = measureGuidanceText(GENERIC_CHAT_TOOL_GUIDANCE);
  const vaultTurn = measureGuidanceText(buildSlimChatToolGuidance(
    ['lykn_open_app'],
    ['vault.read'],
  ));
  assert.ok(generic.approxTokens < 500, `generic ${generic.approxTokens}`);
  assert.ok(vaultTurn.approxTokens < 700, `vault guidance ${vaultTurn.approxTokens}`);
});

test('voice discloses the same Chat skills when asked', () => {
  const letter = disclose('write me a letter to my landlord');
  assert.ok(letter.capabilities.includes('documents.write'));
  assert.ok(letter.firstPartyToolNames.includes('write_document'));
  assert.equal(letter.firstPartyToolNames.includes('build_react_artifact'), false);

  const image = disclose('generate an image of a red bicycle');
  assert.ok(image.firstPartyToolNames.includes('generate_image'));
  assert.equal(image.firstPartyToolNames.includes('write_document'), false);

  const math = disclose('calculate 17.5 percent of 2400');
  assert.ok(math.firstPartyToolNames.includes('calculate'));

  const open = disclose('open my calendar');
  assert.ok(open.firstPartyToolNames.includes('open_app'));

  const local = disclose('run npm test in the terminal', { localMode: true });
  assert.ok(local.firstPartyToolNames.includes('local_run_command'));

  const project = disclose('find my project');
  assert.ok(project.firstPartyToolNames.includes('list_projects'));
  assert.ok(project.firstPartyToolNames.includes('resolve_project'));
  assert.equal(project.firstPartyToolNames.includes('delete_project'), false);

  const hello = disclose('hello');
  assert.ok(hello.firstPartyToolNames.length <= 2);
});

test('Voice session replaces tools each turn instead of accumulating', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/hooks/useRealtimeVoice.ts'),
    'utf8',
  );
  assert.match(src, /voiceToolDefsRef\.current = next/);
  assert.doesNotMatch(src, /voiceToolDefsRef\.current\.set\(name, tool/);
});

test('deleted runtime tools cannot execute from Chat', async () => {
  const belief = await runChatTool('lykn_proposeBelief', {}, { userId: 'u1' }, {
    allowedToolNames: ['lykn_proposeBelief'],
  });
  assert.equal(belief.ok, false);

  const apps = await runChatTool('lykn_list_apps', {}, { userId: 'u1' }, {
    allowedToolNames: ['lykn_list_apps'],
  });
  assert.equal(apps.ok, false);
  assert.match(apps.payload.error, /tool_not_whitelisted_for_chat/);

  assert.equal(CHAT_TOOL_NAMES.includes('lykn_searchVault'), false);
  assert.equal(CHAT_TOOL_NAMES.includes('lykn_loadNeuron'), false);
  assert.equal(CHAT_TOOL_NAMES.includes('lykn_loadNeurons'), false);
  assert.equal(CHAT_TOOL_NAMES.includes('lykn_getProjectNeurons'), false);
  assert.equal(CHAT_TOOL_NAMES.includes('lykn_addProjectNeurons'), false);
  assert.equal(CHAT_TOOL_NAMES.includes('lykn_removeProjectNeurons'), false);
  assert.equal(CHAT_TOOL_NAMES.includes('lykn_proposeBelief'), false);
});
