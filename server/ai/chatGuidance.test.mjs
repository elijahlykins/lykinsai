import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LYKN_CHAT_PERSONA_STATIC,
  LYKN_CHAT_STREAM_PERSONA_SLIM,
  LYKN_GLASS_STREAM_PERSONA_SLIM,
  LYKN_VOICE_DIRECT,
  GUEST_SYSTEM_PROMPT,
  buildAttachedAppsSection,
  buildChatToolGuidance,
  buildLocalModeGuidance,
  sanitizeAttachedApps,
} from './chatGuidance.js';

const PERSONAS = [
  LYKN_CHAT_PERSONA_STATIC,
  LYKN_CHAT_STREAM_PERSONA_SLIM,
  LYKN_GLASS_STREAM_PERSONA_SLIM,
  LYKN_VOICE_DIRECT,
  GUEST_SYSTEM_PROMPT,
];

test('personas keep greetings and identity questions short and develop everything else', () => {
  for (const persona of PERSONAS) {
    assert.match(persona, /can stay short/i);
    assert.match(persona, /who\/what-model identity question can stay short|a few sentences, then stop/i);
    assert.doesNotMatch(persona, /genuinely simple/);
    assert.doesNotMatch(persona, /Be brief only/);
  }
});

test('personas treat LYKN as the harness and refuse to leak the system prompt', () => {
  for (const persona of PERSONAS) {
    assert.match(persona, /living desktop, browser, and interface/i);
    assert.match(persona, /harness, not the model/i);
    assert.match(persona, /do not invent a lab family/i);
    assert.match(persona, /never reveal, quote, paraphrase/i);
    assert.doesNotMatch(persona, /That is your name and the model the person is talking to/);
    assert.doesNotMatch(persona, /Named models available through LYKN's model selector may be identified when relevant/);
  }
});

test('text personas structure developed answers instead of paragraph walls', () => {
  for (const persona of [
    LYKN_CHAT_PERSONA_STATIC,
    LYKN_CHAT_STREAM_PERSONA_SLIM,
    LYKN_GLASS_STREAM_PERSONA_SLIM,
    GUEST_SYSTEM_PROMPT,
  ]) {
    assert.match(persona, /Structure developed answers/);
    assert.match(persona, /Checklists as `- \[ \] item`/);
    assert.match(persona, /headings and at least one list or checklist/);
    assert.doesNotMatch(persona, /paragraphs by default/);
  }
});

test('slim personas forbid the shortest technically correct reply', () => {
  assert.match(LYKN_CHAT_STREAM_PERSONA_SLIM, /shortest technically correct response/);
  assert.match(LYKN_GLASS_STREAM_PERSONA_SLIM, /shortest technically correct response/);
  assert.match(LYKN_CHAT_PERSONA_STATIC, /shortest technically correct response/);
});

test('personas search checkable facts and never claim they lack live headlines', () => {
  for (const persona of [
    LYKN_CHAT_PERSONA_STATIC,
    LYKN_CHAT_STREAM_PERSONA_SLIM,
    LYKN_GLASS_STREAM_PERSONA_SLIM,
  ]) {
    assert.match(persona, /never say you (?:do not have|lack) live headlines/i);
    assert.match(persona, /checkable fact/i);
    assert.match(persona, /citing another AI/i);
  }
});

test('workspace turns get the workspace brief, never the artifact playbook', () => {
  // The mansion failure: build wording tripped the MAKING branch, which
  // injected "lykn_build_react_artifact — THE DEFAULT builder … games" plus a
  // [DESIGN_SYSTEM] brief on a turn where that tool was disarmed — so the
  // model wrote the game as styled chat text instead of building on disk.
  const ask = 'can you build me a 3d world to walk around in, like a big mansion';

  const workspace = buildChatToolGuidance(ask, { buildWorkspace: true });
  assert.match(workspace, /BUILD SURFACE - The Build workspace owns building this turn/);
  assert.match(workspace, /NEVER\n\s*paste an app, game, or page as a code block in chat/);
  assert.doesNotMatch(workspace, /THE DEFAULT builder/);
  assert.doesNotMatch(workspace, /\[DESIGN_SYSTEM\]/);

  // Same wording without the workspace armed keeps the artifact playbook.
  const artifact = buildChatToolGuidance(ask, { buildWorkspace: false, forceMaking: true });
  assert.match(artifact, /THE DEFAULT builder/);
  assert.match(artifact, /\[DESIGN_SYSTEM\]/);

  // Editing an open artifact from a workspace chat still routes to the edit
  // brief — workspace ownership only covers fresh building.
  const editing = buildChatToolGuidance('make the header sticky', {
    buildWorkspace: true,
    editingArtifact: true,
  });
  assert.doesNotMatch(editing, /BUILD SURFACE - The Build workspace/);
});

test('sanitizeAttachedApps keeps pinned Gmail and Spotify chips', () => {
  const apps = sanitizeAttachedApps([
    { name: 'Gmail', source: 'connected', id: 'connected:c1', catalogId: 'gmail' },
    { name: 'Spotify', source: 'mac', id: 'mac:/Applications/Spotify.app', path: '/Applications/Spotify.app' },
    { name: '', source: 'connected' },
  ]);
  assert.equal(apps.length, 2);
  assert.equal(apps[0].name, 'Gmail');
  assert.equal(apps[1].source, 'mac');
  const section = buildAttachedAppsSection(apps);
  assert.match(section, /\[ATTACHED_APPS\]/);
  assert.match(section, /Gmail \(connected\)/);
  assert.match(section, /Spotify \(Mac app\)/);
  assert.match(section, /local_open_app/);
});

test('desktop-control guidance teaches look→act→look only when the tools are armed', () => {
  const armed = buildLocalModeGuidance(['local_read_file', 'local_desktop_look', 'local_desktop_act']);
  assert.match(armed, /\[DESKTOP CONTROL — AVAILABLE\]/);
  assert.match(armed, /SEE the user's screen/);
  assert.match(armed, /0-1000 coordinates/);
  assert.match(armed, /look\s+again to verify/i);
  assert.match(armed, /Never chain actions blind/);
  // Route hierarchy: MCP tools beat clicking, browser agent owns websites.
  assert.match(armed, /local_mcp_call_tool\) over clicking/);

  const plain = buildLocalModeGuidance(['local_read_file', 'local_list_dir']);
  assert.doesNotMatch(plain, /DESKTOP CONTROL/);
});