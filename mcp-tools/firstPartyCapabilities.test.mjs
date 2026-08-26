import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_TOOL_NAMES, buildAnthropicTools, buildGeminiTools, buildOpenAiTools, runChatTool } from './chatTools.js';
import { LOCAL_TOOL_NAMES } from './localTools.js';
import {
  FIRST_PARTY_CAPABILITY_FAMILIES,
  FIRST_PARTY_TOOL_EXCLUSIONS,
  FIRST_PARTY_TOOL_METADATA,
  FIRST_PARTY_TOOL_METADATA_BY_NAME,
  MAX_EXTERNAL_TOOLS_PER_DISCLOSURE,
  composeWithExternalTools,
  inspectFirstPartyDisclosure,
  measureChatToolSchemas,
  resolveChatTurnDisclosure,
  selectExternalToolsForNeeds,
} from './firstPartyCapabilities.js';

const FALLBACK_42 = 42;

function disclose(message, extra = {}) {
  return resolveChatTurnDisclosure({
    message,
    conversation: [],
    exclusiveComposerMode: null,
    localMode: false,
    overlayAsk: false,
    inProject: false,
    allowNewArtifactBuild: false,
    lockOutArtifactBuilds: false,
    ...extra,
  });
}

function names(d) {
  return d.firstPartyToolNames;
}

function fakeMcpCatalog() {
  const kinds = [
    'gmail',
    'gdrive',
    'slack',
    'notion',
    'linear',
    'github',
    'calendar',
    'dropbox',
    'asana',
    'hubspot',
  ];
  const tools = [];
  for (const kind of kinds) {
    for (let i = 0; i < 50; i++) {
      tools.push({
        name: `${kind}_tool_${i}`,
        description: `MCP ${kind} tool ${i} for ${kind === 'gmail' ? 'gmail inbox email messages' : kind}`,
        connectionId: `conn_${kind}`,
        connectionKind: kind,
      });
    }
  }
  assert.equal(tools.length, 500);
  return tools;
}

test('every live CHAT_TOOL_NAMES entry has capability metadata', () => {
  const missing = CHAT_TOOL_NAMES.filter((n) => !FIRST_PARTY_TOOL_METADATA_BY_NAME[n]);
  assert.deepEqual(missing, [], 'unmapped Chat tools');
});

test('every Local Mode schema has capability metadata', () => {
  const missing = LOCAL_TOOL_NAMES.filter((n) => !FIRST_PARTY_TOOL_METADATA_BY_NAME[n]);
  assert.deepEqual(missing, [], 'unmapped Local tools');
});

test('metadata families are in the grammar and exclusions are explicit', () => {
  const familySet = new Set(FIRST_PARTY_CAPABILITY_FAMILIES);
  for (const row of FIRST_PARTY_TOOL_METADATA) {
    assert.ok(familySet.has(row.family), `${row.name} family ${row.family}`);
    for (const cap of row.capabilities) {
      assert.ok(familySet.has(cap), `${row.name} capability ${cap}`);
    }
    assert.equal(row.alwaysAvailable, false, `${row.name} must not be always-available`);
  }
  const exclusionNames = FIRST_PARTY_TOOL_EXCLUSIONS.map((e) => e.name);
  for (const name of exclusionNames) {
    assert.equal(CHAT_TOOL_NAMES.includes(name), false, `${name} should stay off the Chat allowlist`);
  }
  assert.equal(FIRST_PARTY_TOOL_EXCLUSIONS.length, 8);
});

test('hello discloses zero tools', () => {
  const d = disclose('hello');
  assert.deepEqual(names(d), []);
  assert.equal(d.keepToolsOn, false);
  assert.equal(d.inspect.count, 0);
  assert.equal(d.inspect.bytes, 0);
});

test('web search discloses the web family only', () => {
  const d = disclose("search the web for today's AI news");
  assert.deepEqual(names(d), ['lykn_web_search', 'lykn_web_fetch']);
  assert.ok(d.capabilities.includes('web.search'));
  assert.ok(d.capabilities.includes('web.read'));
  assert.ok(d.inspect.count < 5);
  assert.ok(d.inspect.approxTokens < 2000);
});

test('vault save discloses vault write, not the leftover dump', () => {
  const d = disclose('save this to my Vault');
  assert.ok(names(d).includes('lykn_createVaultNote'));
  assert.ok(names(d).includes('lykn_saveFileToVault'));
  assert.ok(names(d).includes('lykn_saveLinkToVault'));
  assert.equal(names(d).some((n) => n.startsWith('lykn_listProjects')), false);
  assert.equal(names(d).includes('lykn_web_search'), false);
  assert.ok(d.inspect.count <= 6);
  assert.ok(d.inspect.count < FALLBACK_42);
});

test('find my project discloses project read, not destroy', () => {
  const d = disclose('find my project');
  assert.ok(names(d).includes('lykn_listProjects'));
  assert.ok(names(d).includes('lykn_resolveProject'));
  assert.equal(names(d).includes('lykn_deleteProject'), false);
  assert.equal(names(d).includes('lykn_mergeProjects'), false);
  assert.ok(d.capabilities.includes('projects.read'));
  assert.equal(d.capabilities.includes('projects.destroy'), false);
  assert.ok(d.inspect.count < 12);
});

test('create a calendar event discloses calendar write, not the 12-tool pack', () => {
  const d = disclose('create a calendar event');
  assert.ok(names(d).includes('lykn_createEvent'));
  assert.ok(names(d).includes('lykn_listEvents'));
  assert.equal(names(d).includes('lykn_createTodo'), false);
  assert.ok(d.capabilities.includes('calendar.write'));
  assert.ok(d.inspect.count < 10);
});

test('make an image without Imagine does not dump leftover Chat tools', () => {
  const d = disclose('make an image');
  assert.equal(names(d).includes('lykn_generate_image'), false);
  assert.ok(names(d).length < FALLBACK_42);
  assert.ok(d.inspect.count < 8);
});

test('Imagine exclusive mode is image family only', () => {
  const d = disclose('make an image', { forceImage: true, exclusiveComposerMode: 'image' });
  assert.deepEqual(names(d), ['lykn_generate_image', 'lykn_process_image']);
});

test('browse example.com discloses web read, not 42 Chat tools', () => {
  const d = disclose('browse example.com');
  assert.ok(names(d).includes('lykn_web_fetch'));
  assert.equal(names(d).includes('lykn_createEvent'), false);
  assert.ok(d.inspect.count < 6);
});

test('read this local file uses Local families only', () => {
  const d = disclose('read this local file', { localMode: true });
  const local = names(d).filter((n) => n.startsWith('local_'));
  const chat = names(d).filter((n) => !n.startsWith('local_'));
  assert.ok(local.includes('local_read_file'));
  assert.ok(local.includes('local_list_dir'));
  assert.equal(local.includes('local_run_command'), false);
  assert.equal(local.includes('local_browser_agent'), false);
  assert.ok(chat.length <= 2);
  assert.ok(names(d).length < 20);
});

test('web search with Local Mode on does not append leftover Chat or all Local tools', () => {
  const d = disclose("search the web for today's AI news", { localMode: true });
  assert.deepEqual(
    names(d).filter((n) => !n.startsWith('local_')),
    ['lykn_web_search', 'lykn_web_fetch'],
  );
  assert.equal(names(d).includes('local_run_command'), false);
  assert.ok(names(d).length < 10);
});

test('SSH into a dev server is not the Chat leftover dump', () => {
  const d = disclose('SSH into dev server');
  assert.deepEqual(names(d), []);
  assert.ok(d.inspect.count === 0);
});

test('ambiguous agent-capable turns never receive the 42-tool fallback', () => {
  const turns = [
    'make me something',
    'make me a website',
    'can you take care of that',
    'help me with this',
    "what's in this file?",
  ];
  for (const message of turns) {
    const d = disclose(message);
    assert.ok(
      names(d).length < FALLBACK_42,
      `"${message}" disclosed ${names(d).length} tools`,
    );
    assert.ok(d.inspect.approxTokens < 8000, `"${message}" still expensive (${d.inspect.approxTokens})`);
  }
});

test('Gmail/MCP composes a small first-party set with ≤10 relevant MCP tools', () => {
  const discovered = fakeMcpCatalog();
  const d = disclose('find my newest Gmail message', { discoveredExternalTools: discovered });
  assert.ok(d.firstPartyToolNames.length < 8, `first-party ${d.firstPartyToolNames.length}`);
  assert.ok(d.externalNeeds.includes('email'));
  assert.ok(d.externalTools.length <= MAX_EXTERNAL_TOOLS_PER_DISCLOSURE);
  assert.ok(d.externalTools.length > 0);
  assert.ok(d.externalTools.every((t) => /gmail|mail|inbox|email/i.test(`${t.name} ${t.description}`)));
  assert.equal(d.externalTools.some((t) => t.connectionKind === 'hubspot'), false);
  const composed = composeWithExternalTools(d.firstPartyToolNames, d.externalTools);
  assert.ok(composed.toolNames.length < 20);
});

test('normal chat discloses 0 MCP tools even with a 500-tool catalog', () => {
  const d = disclose('hello', { discoveredExternalTools: fakeMcpCatalog() });
  assert.deepEqual(d.externalTools, []);
  assert.deepEqual(d.externalNeeds, []);
});

test('documents Task attaches document MCP tools, not a global dump', () => {
  const discovered = fakeMcpCatalog();
  const selected = selectExternalToolsForNeeds(discovered, ['documents']);
  assert.ok(selected.length <= 10);
  assert.ok(selected.every((t) => /gdrive|docs|dropbox|notion|document/i.test(`${t.name} ${t.description} ${t.connectionKind}`)));
});

test('disclosed names are identical across OpenAI, Anthropic, and Gemini serializers', () => {
  const d = disclose("search the web for today's AI news");
  const openai = buildOpenAiTools(d.firstPartyToolNames);
  const anthropic = buildAnthropicTools(d.firstPartyToolNames);
  const gemini = buildGeminiTools(d.firstPartyToolNames);
  assert.deepEqual(
    openai.map((t) => t.function.name),
    anthropic.map((t) => t.name),
  );
  assert.deepEqual(
    openai.map((t) => t.function.name),
    gemini[0].functionDeclarations.map((t) => t.name),
  );
});

test('execution authorization still rejects hidden and undisclosed tools', async () => {
  const ctx = { userId: 'u1' };
  const lean = ['lykn_web_search', 'lykn_web_fetch'];
  const hidden = await runChatTool('lykn_deleteProject', {}, ctx, { allowedToolNames: lean });
  assert.equal(hidden.ok, false);
  assert.match(hidden.payload.error, /tool_not_enabled_for_model/);

  const retired = await runChatTool('lykn_searchVault', {}, ctx, {
    allowedToolNames: ['lykn_searchVault'],
  });
  assert.equal(retired.ok, false);
  assert.match(retired.payload.error, /tool_not_whitelisted_for_chat/);

  const hallucinated = await runChatTool('lykn_web_search', {}, ctx, { allowedToolNames: [] });
  assert.equal(hallucinated.ok, false);
  assert.match(hallucinated.payload.error, /tool_not_enabled_for_model/);
});

test('token characterization for representative turns', () => {
  const discovered = fakeMcpCatalog();
  const rows = [
    ['hello', disclose('hello')],
    ['ambiguous make me a website', disclose('make me a website')],
    ['web search', disclose("search the web for today's AI news")],
    ['vault save', disclose('save this to my Vault')],
    ['calendar create', disclose('create a calendar event')],
    ['local file', disclose('read this local file', { localMode: true })],
    ['gmail/mcp', disclose('find my newest Gmail message', { discoveredExternalTools: discovered })],
    [
      'multi-surface',
      disclose('search the web for this and save it to my Vault'),
    ],
  ];
  const report = rows.map(([label, d]) => {
    const first = measureChatToolSchemas(d.firstPartyToolNames);
    return {
      label,
      capabilities: d.capabilities.join(','),
      firstParty: first.count,
      mcp: d.externalTools.length,
      bytes: first.bytes,
      tokens: first.approxTokens,
      fallback: d.fallback,
    };
  });
  console.log('\nfirst-party disclosure token characterization');
  console.table(report);
  for (const row of report) {
    assert.ok(row.firstParty < FALLBACK_42, `${row.label} still has leftover dump (${row.firstParty})`);
  }
  assert.equal(report[0].firstParty, 0);
  assert.ok(report[2].tokens < 1500);
  assert.ok(report[6].mcp <= 10);
  inspectFirstPartyDisclosure(rows[2][1]);
});
