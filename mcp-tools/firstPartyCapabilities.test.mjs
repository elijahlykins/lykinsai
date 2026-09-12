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

test('write me a letter discloses the document writer', () => {
  const d = disclose('write me a letter to my landlord');
  assert.ok(names(d).includes('lykn_write_document'));
  assert.ok(d.capabilities.includes('documents.write'));
  assert.equal(names(d).includes('lykn_build_react_artifact'), false);
  assert.ok(d.inspect.count < 8);
});

test('hello discloses zero tools', () => {
  const d = disclose('hello');
  assert.deepEqual(names(d), []);
  assert.equal(d.keepToolsOn, false);
  assert.equal(d.inspect.count, 0);
  assert.equal(d.inspect.bytes, 0);
});

test('hello with connected apps still leaves tools off', () => {
  const d = disclose('hello', {
    hasConnectedApps: true,
    connectedApps: [{ id: 'c1', name: 'Gmail', catalogId: 'gmail' }],
  });
  assert.deepEqual(names(d), []);
  assert.equal(d.keepToolsOn, false);
  assert.equal(d.capabilities.includes('connections.external'), false);
});

test('web search discloses the web family only', () => {
  const d = disclose("search the web for today's AI news");
  assert.deepEqual(names(d), ['lykn_web_search', 'lykn_web_fetch']);
  assert.ok(d.capabilities.includes('web.search'));
  assert.ok(d.capabilities.includes('web.read'));
  assert.ok(d.inspect.count < 5);
  assert.ok(d.inspect.approxTokens < 2000);
});

test('real questions disclose web search so the model can choose', () => {
  for (const msg of [
    "what's on the news",
    'is clive a word',
    'would it be valid in scrabble',
    'chatgpt said yes haha',
    'explain how transformers work',
  ]) {
    const d = disclose(msg);
    assert.ok(names(d).includes('lykn_web_search'), `lykn_web_search missing for: ${msg}`);
    assert.ok(d.capabilities.includes('web.search'), `web.search missing for: ${msg}`);
    assert.ok(d.inspect.count < 8, `too many tools for: ${msg}`);
  }
  const hi = disclose('hello');
  assert.equal(names(hi).includes('lykn_web_search'), false);
});

test('brand-name site asks disclose web.read without a TLD in the message', () => {
  // Regression: "open up the perplexity landing page" used to disclose no web
  // tools at all, so the model told the user it cannot open webpages.
  for (const msg of [
    'open up the perplexity landing page',
    'can you scrape the perplexity computer website for me',
    'go to the acme homepage and tell me what it says',
  ]) {
    const d = disclose(msg);
    assert.ok(d.capabilities.includes('web.read'), `web.read missing for: ${msg}`);
    assert.ok(names(d).includes('lykn_web_fetch'), `lykn_web_fetch missing for: ${msg}`);
  }
});

test('bare "page" asks stay small, not a leftover dump', () => {
  const d = disclose('open the settings page');
  assert.ok(d.inspect.count < 8);
  assert.ok(d.inspect.count < FALLBACK_42);
});

test('vault save discloses vault write, not the leftover dump', () => {
  const d = disclose('save this to my Vault');
  assert.ok(names(d).includes('lykn_createVaultNote'));
  assert.ok(names(d).includes('lykn_saveFileToVault'));
  assert.ok(names(d).includes('lykn_saveLinkToVault'));
  assert.equal(names(d).some((n) => n.startsWith('lykn_listProjects')), false);
  assert.ok(d.inspect.count <= 8);
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

test('armed image mode keeps only process_image — generation is Imagine-only', () => {
  // Image GENERATION never registers on chat turns (it lives behind the
  // /api/ai/imagine-image endpoint); a stale client arming forceImage gets the
  // edit/OCR tool plus a redirect reply, never lykn_generate_image.
  const d = disclose('make an image', { forceImage: true, exclusiveComposerMode: 'image' });
  assert.deepEqual(names(d), ['lykn_process_image']);
});


test('browse example.com discloses web read, not 42 Chat tools', () => {
  const d = disclose('browse example.com');
  assert.ok(names(d).includes('lykn_web_fetch'));
  assert.equal(names(d).includes('lykn_createEvent'), false);
  assert.ok(d.inspect.count < 6);
});

test('named Mac folder asks disclose local file reads', () => {
  const first = disclose('hey can you read my LYKN folder', { localMode: true });
  assert.ok(names(first).includes('local_search_files'));
  assert.ok(names(first).includes('local_list_dir'));
  assert.equal(first.keepToolsOn, true);

  const analyze = disclose('analyze this folder', { localMode: true });
  assert.ok(names(analyze).includes('local_read_file'));
  assert.equal(analyze.keepToolsOn, true);

  const follow = disclose('just list whats inside', {
    localMode: true,
    conversation: [{ role: 'user', content: 'hey can you read my LYKN folder' }],
  });
  assert.ok(names(follow).includes('local_list_dir'));
  assert.equal(follow.keepToolsOn, true);
});

test('a workspace-armed turn discloses local capabilities regardless of wording', () => {
  // The easy-cad failure: "are the edits still in there" carries no file
  // keyword, so the disclosure said web-only while 11 local tools sat armed
  // in the request — and the model truthfully refused to touch the project.
  const d = disclose('are the edits you made on the shift select still in there', {
    localMode: true,
    buildWorkspace: true,
  });
  assert.ok(d.capabilities.includes('local.files.read'));
  assert.ok(d.capabilities.includes('local.files.write'));
  assert.ok(d.capabilities.includes('local.shell'));
  assert.ok(names(d).includes('local_read_file'));
  assert.ok(names(d).includes('local_edit_file'));
  assert.equal(d.keepToolsOn, true);

  // Workspace-only mode (Local Mode switch off): the Electron gate confines
  // calls to ~/LYKN/Builds, so the tools stay disclosed rather than stripped.
  const workspaceOnly = disclose('make the map bigger', {
    localMode: false,
    buildWorkspace: true,
  });
  assert.ok(workspaceOnly.capabilities.includes('local.files.write'));
  assert.ok(names(workspaceOnly).includes('local_edit_file'));

  // Without the workspace armed, the wording alone still discloses nothing
  // local — ordinary chats keep their lean disclosure.
  const plain = disclose('are the edits you made on the shift select still in there', {
    localMode: true,
  });
  assert.equal(plain.capabilities.includes('local.files.write'), false);
});

test('3D-asset intent and workspace turns arm lykn_generate_3d_model', () => {
  // Explicit 3D vocabulary arms the generator in plain chat…
  for (const msg of [
    'make me a 3d model of a porsche 911',
    'generate a character in 3D for my game',
    'can you get me a glb of a viking helmet',
  ]) {
    const d = disclose(msg, {});
    assert.ok(d.capabilities.includes('media.model3d'), `expected media.model3d for: ${msg}`);
    assert.ok(names(d).includes('lykn_generate_3d_model'), msg);
  }
  // …and every workspace turn carries it: "add a car to my game" has no 3D
  // wording, but procedural code cannot sculpt a car.
  const ws = disclose('add a car the player can drive around', {
    localMode: true,
    buildWorkspace: true,
  });
  assert.ok(ws.capabilities.includes('media.model3d'));
  assert.ok(names(ws).includes('lykn_generate_3d_model'));
  // Ordinary chats stay lean — "model" alone (AI models) must not arm it.
  const plain = disclose('which ai model should I use for writing', {});
  assert.equal(plain.capabilities.includes('media.model3d'), false);
});

test('asking LYKN to physically drive the Mac arms the desktop-control tools', () => {
  // "control blender for me" / "what's on my screen" — the see→click→type
  // loop (local_desktop_look/act) rides the local.desktop family.
  for (const msg of [
    'take control of blender and sculpt the head for me',
    "what's on my screen right now",
    'take a screenshot of my screen and tell me what you see',
    'click the render button in the app for me',
  ]) {
    const d = disclose(msg, { localMode: true });
    assert.ok(d.capabilities.includes('local.desktop'), `expected local.desktop for: ${msg}`);
    assert.ok(names(d).includes('local_desktop_look'), `expected look tool for: ${msg}`);
    assert.ok(names(d).includes('local_desktop_act'), `expected act tool for: ${msg}`);
  }

  // A generic coding ask must NOT arm physical control — "click submit" in a
  // web-dev chat is about the user's own page, not their desktop.
  const codey = disclose('make the submit button bigger when you click it', { localMode: true });
  assert.equal(names(codey).includes('local_desktop_act'), false);
});

test('ok check them after a folder-capability turn keeps local file reads', () => {
  const follow = disclose('ok check them', {
    localMode: true,
    overlayAsk: true,
    conversation: [{ role: 'user', content: "you can't search the folders or files in this chat" }],
  });
  assert.ok(names(follow).includes('local_search_files'));
  assert.ok(names(follow).includes('local_list_dir'));
  assert.equal(follow.keepToolsOn, true);
});

test('Glass overlay with Local Mode discloses local file reads for a Desktop compare', () => {
  const d = disclose('compare ~/Desktop/LYKN Landing with ~/Desktop/LYKN', {
    localMode: true,
    overlayAsk: true,
  });
  assert.ok(names(d).includes('local_search_files'));
  assert.ok(names(d).includes('local_list_dir'));
  assert.ok(names(d).includes('local_read_file'));
  assert.equal(d.keepToolsOn, true);
});

test('run a browser agent discloses local_browser_agent in Local Mode', () => {
  const d = disclose('run a browser agent and go to the Perplexity Computer website', {
    localMode: true,
  });
  assert.ok(names(d).includes('local_browser_agent'));
  assert.ok(d.capabilities.includes('browser.agent'));
});

test('browser side chat stays ask-only even with Local Mode', () => {
  const d = disclose('run a browser agent and email this to my team', {
    localMode: true,
    browserAsk: true,
    hasConnectedApps: true,
    discoveredExternalTools: fakeMcpCatalog().slice(0, 20),
    allowNewArtifactBuild: true,
  });
  assert.equal(names(d).includes('local_browser_agent'), false);
  assert.equal(names(d).includes('local_run_command'), false);
  assert.equal(names(d).includes('lykn_search_connected_tools'), false);
  assert.equal(names(d).includes('lykn_call_connected_tool'), false);
  assert.equal(d.externalTools.length, 0);
  assert.equal(d.capabilities.includes('browser.agent'), false);
  assert.equal(d.capabilities.includes('connections.external'), false);
});

test('hello still discloses zero tools', () => {
  const d = disclose('hello', {});
  assert.deepEqual(names(d), []);
  assert.equal(d.keepToolsOn, false);
});

test('run a terminal command discloses local_run_command in Local Mode', () => {
  const d = disclose('run npm test in the terminal', { localMode: true });
  assert.ok(names(d).includes('local_run_command'));
  assert.ok(d.capabilities.includes('local.shell'));
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

test('finding something in an attached folder discloses nested file reads', () => {
  const d = disclose('can you find where the build feature sits in this', {
    localMode: true,
    attachedFolders: [{ name: 'LYKN-dev', path: '/Users/me/LYKN-dev' }],
  });
  assert.ok(names(d).includes('local_search_files'));
  assert.ok(names(d).includes('local_list_dir'));
  assert.ok(names(d).includes('local_read_file'));
  assert.equal(d.keepToolsOn, true);
});

test("what's in agents.md after a dropped folder keeps local_read_file", () => {
  const d = disclose("what's in agents.md", {
    localMode: true,
    conversation: [{
      role: 'user',
      content: 'Desktop folder "Docs" — call local_list_dir or local_read_file\nPath: /Users/me/Docs',
    }],
  });
  assert.ok(names(d).includes('local_read_file'));
  assert.equal(d.keepToolsOn, true);
});

test('unrelated brainstorming after a dropped folder does not keep local file reads', () => {
  const d = disclose("let's brainstorm a new onboarding flow for the marketing site", {
    localMode: true,
    conversation: [{
      role: 'user',
      content: 'Desktop folder "Docs" — call local_list_dir or local_read_file\nPath: /Users/me/Docs',
    }],
  });
  assert.equal(names(d).includes('local_read_file'), false);
  assert.equal(names(d).includes('local_search_files'), false);
  assert.equal(names(d).includes('local_list_dir'), false);
});

test("what's in agents.md is a local file ask when Local Mode is on", () => {
  const d = disclose("what's in agents.md", { localMode: true });
  assert.ok(names(d).includes('local_read_file'));
  assert.equal(d.keepToolsOn, true);
});

test('SSH into a dev server is not the Chat leftover dump', () => {
  const d = disclose('SSH into dev server');
  assert.deepEqual(names(d), ['lykn_web_search', 'lykn_web_fetch']);
  assert.ok(d.inspect.count < 5);
  assert.ok(d.inspect.count < FALLBACK_42);
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

test('naming a connected app discloses the tool registry, not a hardcoded domain list', () => {
  const d = disclose('can you see my supabase project', {
    connectedApps: [{ id: 'sb', name: 'Supabase' }],
  });
  assert.ok(d.capabilities.includes('connections.external'));
  assert.ok(names(d).includes('lykn_search_connected_tools'));
  assert.ok(names(d).includes('lykn_call_connected_tool'));
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
