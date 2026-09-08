import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { clipJsonToCap } from './mcp-tools/toolResultBounds.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const loopSrc = readFileSync(join(HERE, 'chat-agent-loop.js'), 'utf8');

test('chat file investigation gets a longer tool loop than a casual turn', () => {
  assert.match(loopSrc, /const MAX_HOPS = 6;/);
  assert.match(loopSrc, /const MAX_HOPS_INVESTIGATE = 20;/);
  assert.match(loopSrc, /const MAX_TOOL_CALLS_PER_HOP_INVESTIGATE = 8;/);
  assert.match(loopSrc, /if \(opts\?\.investigateMode\) return MAX_HOPS_INVESTIGATE;/);
  assert.match(loopSrc, /investigateMode,/);
  assert.match(loopSrc, /clipJsonToCap\(/);
});

test('desktop MCP turns get the creative loop budget', async () => {
  const { resolveMaxHops } = await import('./chat-agent-loop.js');
  // The half-built Porsche: "model a car in blender" ran on the 6-hop chat
  // budget — a complete creative build is dozens of act→look→refine cycles.
  assert.equal(resolveMaxHops({ desktopMcpMode: true }), 40);
  // Workspace still wins when both are armed (its budget is bigger).
  assert.equal(resolveMaxHops({ workspaceMode: true, desktopMcpMode: true }), 60);
  assert.equal(resolveMaxHops({}), 6);
});

test('desktopMcpStallReason reads abandonment from the call shapes', async () => {
  const { desktopMcpStallReason } = await import('./lib/agentStallPolicy.js');
  const act = (tool) => ({ name: 'local_mcp_call_tool', args: { app: 'Blender', tool } });

  // Acted and stopped without ever looking — the Porsche failure signature.
  assert.equal(
    desktopMcpStallReason([act('execute_blender_code'), act('create_object')]),
    'unverified',
  );
  // Acted, then verified: consistent with finished work.
  assert.equal(
    desktopMcpStallReason([act('execute_blender_code'), act('get_scene_info')]),
    null,
  );
  assert.equal(
    desktopMcpStallReason([act('execute_blender_code'), act('screenshot_viewport')]),
    null,
  );
  // Verified, but the reply commits to future steps → mid-task.
  assert.equal(
    desktopMcpStallReason(
      [act('execute_blender_code'), act('get_scene_info')],
      "The body and chassis are in place. Next I'll add the wheels and the interior.",
    ),
    'mid-task',
  );
  assert.equal(
    desktopMcpStallReason(
      [act('execute_blender_code'), act('get_scene_info')],
      'I still need to add the wheels, glass, and materials.',
    ),
    'mid-task',
  );
  // A finished summary with an OFFER is not mid-task narration.
  assert.equal(
    desktopMcpStallReason(
      [act('execute_blender_code'), act('get_scene_info')],
      'Done — the car is fully modeled with materials and lighting. Want more? I can add a spoiler or racing stripes.',
    ),
    null,
  );
  // Desktop-control calls share the same act/look grammar.
  assert.equal(
    desktopMcpStallReason([{ name: 'local_desktop_act', args: {} }]),
    'unverified',
  );
  assert.equal(
    desktopMcpStallReason([
      { name: 'local_desktop_act', args: {} },
      { name: 'local_desktop_look', args: {} },
    ]),
    null,
  );
  // No app calls at all: nothing to judge.
  assert.equal(desktopMcpStallReason([], "Next I'll go over the plan."), null);
});

test('desktop MCP stalls trigger nudges with the creative cap of 3', async () => {
  const { shouldNudgeWorkspaceContinue, workspaceNudgePrompt, agentStallReason } =
    await import('./lib/agentStallPolicy.js');
  const blind = [
    { name: 'local_mcp_call_tool', args: { app: 'Blender', tool: 'execute_blender_code' } },
  ];
  for (const n of [0, 1, 2]) {
    assert.equal(
      shouldNudgeWorkspaceContinue({
        desktopMcpMode: true,
        workspaceNudges: n,
        toolCalls: blind,
        pendingToolCalls: false,
      }),
      true,
      `nudge ${n} must fire`,
    );
  }
  assert.equal(
    shouldNudgeWorkspaceContinue({
      desktopMcpMode: true,
      workspaceNudges: 3,
      toolCalls: blind,
      pendingToolCalls: false,
    }),
    false,
  );
  // Without the mode, the same shape is a plain chat turn — no nudge.
  assert.equal(
    shouldNudgeWorkspaceContinue({
      workspaceNudges: 0,
      toolCalls: blind,
      pendingToolCalls: false,
    }),
    false,
  );
  // The MCP prompt demands completion and verification, not validation runs.
  const prompt = workspaceNudgePrompt('unverified');
  assert.match(prompt, /COMPLETE result/);
  assert.match(prompt, /never act blind/);
  assert.match(prompt, /half-built/);
  assert.equal(workspaceNudgePrompt('mid-task'), prompt);
  // On a combined turn, workspace shapes win (more specific prompts).
  assert.equal(
    agentStallReason({
      workspaceMode: true,
      desktopMcpMode: true,
      toolCalls: [{ name: 'local_write_file', args: {} }],
    }),
    'unvalidated',
  );
});

test('claude thinking via openrouter is effort-pinned and burnout-retried', async () => {
  const { CLAUDE_THINKING_MODEL_RE, CLAUDE_REASONING_EFFORT_CHAT, CLAUDE_REASONING_EFFORT_AGENT } =
    await import('./chat-agent-loop.js');

  // The mansion failure, twice over: claude-fable-5 spent ~3 minutes entirely
  // in hidden reasoning and hit the length cap with zero text and zero tool
  // calls; the retry with `enabled: false` was then rejected outright
  // ("Reasoning is mandatory for this endpoint and cannot be disabled") and
  // the turn fell to the toolless legacy stream. Effort levels are the knob
  // these endpoints honor: medium for one-hop chat depth, low for agent
  // loops — a many-hop build cannot afford a minute of hidden planning per
  // hop, which reads as a dead build in the UI.
  assert.equal(CLAUDE_REASONING_EFFORT_CHAT, 'medium');
  assert.equal(CLAUDE_REASONING_EFFORT_AGENT, 'low');
  assert.match(loopSrc, /reasoning: \{ effort: reasoningEffort \}/);
  assert.match(loopSrc, /\(workspaceMode \|\| codingMode \|\| desktopMcpMode\)\s*\n?\s*\? CLAUDE_REASONING_EFFORT_AGENT/);
  assert.doesNotMatch(loopSrc, /\{ enabled: false \}/);
  assert.match(loopSrc, /reasoning burnout on \$\{model\}/);

  // OpenRouter ignores the OpenAI-only max_completion_tokens field, so the
  // real cap must ride as max_tokens or thinking scales with the model max.
  assert.match(loopSrc, /providerLabel === 'openrouter' \? \{ max_tokens: maxOutputTokens \}/);

  // Pin applies to the thinking families however OpenRouter spells the id…
  for (const id of ['anthropic/claude-fable-5.1', 'claude-fable-5.1', 'anthropic/claude-fable-5', 'claude-fable-5', 'anthropic/claude-opus-4-8', 'claude-sonnet-5']) {
    assert.equal(CLAUDE_THINKING_MODEL_RE.test(id), true, id);
  }
  // …and never to other providers' reasoning models (their controls differ).
  for (const id of ['openai/gpt-5.6-terra', 'x-ai/grok-4.6', 'google/gemini-3.1-pro-preview', 'claude-3-5-haiku']) {
    assert.equal(CLAUDE_THINKING_MODEL_RE.test(id), false, id);
  }
});

test('a workspace build abandoned after writes gets pushed back to work', async () => {
  const { shouldNudgeWorkspaceContinue, workspaceStallReason } = await import('./lib/agentStallPolicy.js');
  const calls = (...names) => names.map((name, i) => ({ id: `c${i}`, name }));

  // The live failure: scaffold, install, write files… then narrate and stop.
  const abandoned = calls(
    'local_build_workspace',
    'local_run_command', // npm create vite
    'local_run_command', // npm install
    'local_write_file',
    'local_write_file',
    'local_edit_file',
  );
  assert.equal(workspaceStallReason(abandoned), 'unvalidated');
  assert.equal(
    shouldNudgeWorkspaceContinue({
      workspaceMode: true,
      workspaceNudges: 0,
      toolCalls: abandoned,
      pendingToolCalls: false,
    }),
    true,
  );
  // Still unvalidated after one nudge → pushed again, up to the cap.
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: true, workspaceNudges: 1, toolCalls: abandoned, pendingToolCalls: false }),
    true,
  );

  // A validated build (tests/server ran AFTER the last write) ends freely.
  const validated = calls('local_write_file', 'local_run_command', 'local_start_process', 'local_stop_process');
  assert.equal(workspaceStallReason(validated), null);

  // The second live failure: a resumed build that read the project and then
  // narrated instead of writing. One push — a genuine question about the code
  // has the same shape, and it just answers and ends on the second pass.
  const inspectOnly = calls('local_build_workspace', 'local_list_dir', 'local_read_file', 'local_read_file');
  assert.equal(workspaceStallReason(inspectOnly), 'inspect-only');
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: true, workspaceNudges: 0, toolCalls: inspectOnly, pendingToolCalls: false }),
    true,
  );
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: true, workspaceNudges: 1, toolCalls: inspectOnly, pendingToolCalls: false }),
    false,
  );

  // Zero tool calls: chatting and stalling look the same — never nudged.
  assert.equal(workspaceStallReason([]), null);

  // …unless the reply IS the deliverable pasted as chat text. The mansion
  // failure: no tool calls, just a giant three.js code block in the answer.
  const codeDump = 'Here is your mansion:\n```jsx\n' + 'const scene = new THREE.Scene();\n'.repeat(60) + '```\nEnjoy!';
  assert.equal(workspaceStallReason([], codeDump), 'code-in-chat');
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: true, workspaceNudges: 0, toolCalls: [], pendingToolCalls: false, finalText: codeDump }),
    true,
  );
  // Dumping code twice is still wrong — nudged up to the cap.
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: true, workspaceNudges: 1, toolCalls: [], pendingToolCalls: false, finalText: codeDump }),
    true,
  );
  // A short snippet inside a real answer ("add this to vite.config") is fine.
  const snippetAnswer = 'Add this to vite.config:\n```js\nserver: { port: 3000 }\n```';
  assert.equal(workspaceStallReason([], snippetAnswer), null);
  // Once tools actually ran, chat text alongside them is just narration.
  assert.equal(workspaceStallReason(calls('local_write_file', 'local_run_command'), codeDump), null);

  // The warehouse-edit failure: tools armed (11/20 offered, workspace armed in
  // the log) yet the model claimed "this turn I don't have live access to your
  // Mac's files" and told the user to resend. Zero tools + an access-refusal
  // claim is never a legitimate workspace answer — corrected up to the cap.
  const noAccessClaim =
    "I'd love to knock this out right now, but this turn I don't have live access " +
    "to your Mac's files, so I can't actually open the Warehouse Ops project and " +
    'patch it. Send this same message again (or just say "go") and once the local ' +
    "tools are back I'll make both changes in one pass.";
  assert.equal(workspaceStallReason([], noAccessClaim), 'claimed-no-access');
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: true, workspaceNudges: 0, toolCalls: [], pendingToolCalls: false, finalText: noAccessClaim }),
    true,
  );
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: true, workspaceNudges: 1, toolCalls: [], pendingToolCalls: false, finalText: noAccessClaim }),
    true,
  );
  // The easy-cad variant: an inventory claim ("web tools only") instead of a
  // direct access denial, plus "can't open <path>" and "when the file tools
  // are available". All three sentences from the live reply must trip it.
  const invClaim =
    "I can't verify it from here on this turn. The tools I have right now are web " +
    'and connected-app tools only, not the file-reading tools for your Mac, so I ' +
    "can't open ~/LYKN/Builds/easy-cad/src/main.js and confirm the shift-select " +
    'code is present.';
  assert.equal(workspaceStallReason([], invClaim), 'claimed-no-access');
  assert.equal(
    workspaceStallReason([], 'Have me read the file next turn when the file tools are available.'),
    'claimed-no-access',
  );
  assert.equal(
    workspaceStallReason([], "so I can't open ~/LYKN/Builds/easy-cad/src/main.js right now"),
    'claimed-no-access',
  );

  // Talking ABOUT access in an ordinary answer must not trip it.
  const accessAnswer = 'Local Mode gives me access to the folders you approved, like your home folder.';
  assert.equal(workspaceStallReason([], accessAnswer), null);
  assert.equal(
    workspaceStallReason([], 'The tools ran fine; I opened src/main.js and the shift-select code is there.'),
    null,
  );
  // And once tools ran, an access disclaimer in the text is irrelevant.
  assert.equal(workspaceStallReason(calls('local_read_file'), noAccessClaim), 'inspect-only');

  // Each stall shape maps to its own corrective prompt.
  const { workspaceNudgePrompt } = await import('./lib/agentStallPolicy.js');
  assert.match(workspaceNudgePrompt('claimed-no-access'), /ARE armed on this turn/);
  assert.match(workspaceNudgePrompt('claimed-no-access'), /never tell the user you lack access|Do not tell the user you lack access/i);
  assert.match(workspaceNudgePrompt('code-in-chat'), /pasted the build as a code block/);
  assert.match(workspaceNudgePrompt('unvalidated'), /Progress check/);
  assert.match(workspaceNudgePrompt('inspect-only'), /Progress check/);

  // The nudge is bounded and scoped to workspace turns.
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: false, workspaceNudges: 0, toolCalls: abandoned, pendingToolCalls: false }),
    false,
  );
  assert.equal(
    shouldNudgeWorkspaceContinue({ workspaceMode: true, workspaceNudges: 2, toolCalls: abandoned, pendingToolCalls: false }),
    false,
  );
});

test('tool results carrying pixels reach the model as real images', async () => {
  const { toolResultImages, dataUrlToAnthropicImage, dataUrlToGeminiPart, stripClientOnlyFields } =
    await import('./chat-agent-loop.js');
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

  // The render-and-refine loop: local_read_file on a Blender render (or any
  // screenshot) exposes imageDataUrl, and the hop attaches it as vision input.
  const results = [
    { name: 'local_read_file', payload: { ok: true, imageDataUrl: png, vision: true } },
    { name: 'local_run_command', payload: { ok: true, stdout: 'done' } },
  ];
  const images = toolResultImages(results);
  assert.equal(images.length, 1);
  assert.equal(images[0].tool, 'local_read_file');
  assert.equal(images[0].url, png);

  // Caps: at most 2 per hop, non-image and oversized data URLs skipped.
  const many = Array.from({ length: 5 }, () => ({ name: 't', payload: { imageDataUrl: png } }));
  assert.equal(toolResultImages(many).length, 2);
  assert.equal(toolResultImages([{ name: 't', payload: { imageDataUrl: 'data:text/plain;base64,aGk=' } }]).length, 0);

  // Provider grammars.
  const anthropic = dataUrlToAnthropicImage(png);
  assert.equal(anthropic.type, 'image');
  assert.equal(anthropic.source.media_type, 'image/png');
  assert.equal(anthropic.source.data, 'iVBORw0KGgoAAAANSUhEUg==');
  const gemini = dataUrlToGeminiPart(png);
  assert.equal(gemini.inlineData.mimeType, 'image/png');
  assert.equal(dataUrlToAnthropicImage('not a url'), null);

  // The base64 string is stripped from the model's TEXT serialization — the
  // model gets pixels, not noise; the client SSE payload keeps the field.
  const stripped = stripClientOnlyFields({ ok: true, imageDataUrl: png, content: 'a render' });
  assert.equal(stripped.imageDataUrl, undefined);
  assert.equal(stripped.content, 'a render');
});

test('file-read serialisation keeps nextOffset instead of a broken JSON preview', () => {
  const payload = {
    ok: true,
    path: '/tmp/app.ts',
    content: 'const x = 1;\n'.repeat(4000),
    truncated: true,
    startLine: 1,
    endLine: 400,
    totalLines: 4000,
    nextOffset: 401,
    hint: 'Call again with offset: 401',
  };
  const parsed = JSON.parse(clipJsonToCap(payload, payload, 'local_read_file'));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.nextOffset, 401);
  assert.equal(typeof parsed.content, 'string');
  assert.equal(parsed.preview, undefined);
});

test('firstUserStatusLine keeps one short sentence', async () => {
  const { firstUserStatusLine } = await import('./lib/chatWorkReplyGate.js');
  const wall =
    'The existing atlas uses primitive shapes. I found Z-Anatomy meshes. ' +
    'The upgrade will preserve your study interface.';
  assert.equal(firstUserStatusLine(wall), 'The existing atlas uses primitive shapes.');
  const long = 'A'.repeat(200);
  assert.equal(firstUserStatusLine(long).length, 138);
  assert.equal(firstUserStatusLine(''), '');
});

test('work reply gate parks hop prose and delivers the finish once', async () => {
  const { makeWorkReplyGate } = await import('./lib/chatWorkReplyGate.js');
  const chunks = [];
  const statuses = [];
  const gate = makeWorkReplyGate(
    (t) => chunks.push(t),
    (s) => statuses.push(s),
    true,
  );
  gate.ingest('The existing atlas uses primitive shapes. I found Z-Anatomy meshes.');
  gate.park();
  assert.deepEqual(chunks, []);
  assert.deepEqual(statuses, ['The existing atlas uses primitive shapes.']);
  gate.ingest('Replaced the primitives with separate GLBs.\n- Skeleton, muscles, organs\nOpen ~/LYKN/Builds/anatomy-atlas.');
  gate.deliver();
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /Replaced the primitives/);
  assert.equal(statuses.length, 1);
});

test('work reply gate is a pass-through when work mode is off', async () => {
  const { makeWorkReplyGate } = await import('./lib/chatWorkReplyGate.js');
  const chunks = [];
  const gate = makeWorkReplyGate((t) => chunks.push(t), () => {}, false);
  gate.ingest('Hello ');
  gate.ingest('there.');
  gate.park();
  assert.deepEqual(chunks, ['Hello ', 'there.']);
});

test('search preamble parks as status and does not glue onto the answer', async () => {
  const { makeWorkReplyGate } = await import('./lib/chatWorkReplyGate.js');
  const chunks = [];
  const statuses = [];
  const gate = makeWorkReplyGate(
    (t) => chunks.push(t),
    (s) => statuses.push(s),
    true,
  );
  gate.ingest("I'll check what Neuralink has actually demonstrated so far, not the science-fiction version.");
  gate.park();
  gate.ingest("No. Neuralink cannot sit in your head and pull out the words of whatever you are thinking.");
  gate.deliver();
  assert.deepEqual(statuses, [
    "I'll check what Neuralink has actually demonstrated so far, not the science-fiction version.",
  ]);
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /^No\. Neuralink cannot sit in your head/);
  assert.equal(chunks.join(""), chunks[0]);
});

test('every agent loop holds hop prose so search preambles cannot glue onto the answer', () => {
  assert.equal((loopSrc.match(/makeWorkReplyGate\(/g) || []).length, 3);
  assert.equal((loopSrc.match(/const holdHopReply = true;/g) || []).length, 3);
  assert.doesNotMatch(loopSrc, /makeWorkReplyGate\(\s*onTextChunk,\s*onStatus,\s*!!\(workspaceMode/);
  assert.equal((loopSrc.match(/settleReply\('hold'\)/g) || []).length, 3);
});

// ─── Transient hop retries ──────────────────────────────────────────────────
// A build-workspace turn died mid-project with "the model connection dropped"
// because every provider loop treated ONE transport failure as the end of the
// turn. Transient failures now retry the hop in place: the conversation
// already holds every completed tool result, so nothing re-runs.

test('isTransientHopError separates recoverable drops from real errors', async () => {
  const { isTransientHopError } = await import('./chat-agent-loop.js');
  // Transport-level drops and provider pressure — retry these.
  for (const msg of [
    'fetch failed',
    'socket hang up',
    'read ECONNRESET',
    'terminated',
    'Premature close',
    'TLS handshake timeout',
    'Overloaded',
    'getaddrinfo EAI_AGAIN openrouter.ai',
    'Request timed out',
  ]) {
    assert.equal(isTransientHopError(msg), true, msg);
  }
  for (const status of [408, 429, 500, 502, 503, 529]) {
    assert.equal(isTransientHopError('anything', status), true, `status ${status}`);
  }
  // Permanent failures — retrying these burns time for nothing.
  for (const msg of [
    'aborted',
    'invalid_api_key',
    'context_length_exceeded',
    'tool schema validation failed',
  ]) {
    assert.equal(isTransientHopError(msg), false, msg);
  }
  for (const status of [400, 401, 403, 404]) {
    assert.equal(isTransientHopError('Server Error', status), false, `status ${status}`);
  }
});

test('all three provider loops wire the transient retry on every failure path', () => {
  assert.match(loopSrc, /const MAX_TRANSIENT_HOP_RETRIES = 3;/);
  // connect / http / stream — three paths per loop, three loops.
  const count = (re) => (loopSrc.match(re) || []).length;
  assert.equal(count(/transientHopPause\('connect'/g), 3, 'connect retries');
  assert.equal(count(/transientHopPause\(`http \$\{res\.status\}`/g), 3, 'http retries');
  assert.equal(count(/transientHopPause\('stream'/g), 3, 'stream retries');
  // Mid-stream retries roll back this hop's partial text.
  assert.equal(count(/hadText = hadTextAtHopStart;/g), 3, 'hadText rollback');
});

test('a dropped connection retries the hop and the turn still completes', async () => {
  const { runAgentLoop } = await import('./chat-agent-loop.js');
  const sse = [
    'data: {"choices":[{"delta":{"content":"All done."},"finish_reason":null}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response(sse, { status: 200 });
  };
  try {
    const chunks = [];
    const result = await runAgentLoop({
      provider: 'openai',
      env: { OPENAI_API_KEY: 'test-key' },
      model: 'gpt-test',
      userContent: 'hello',
      chatToolNames: ['lykn_web_search'],
      maxOutputTokens: 256,
      onTextChunk: (t) => chunks.push(t),
    });
    assert.equal(calls, 2, 'first call dropped, second retried');
    assert.equal(result.ok, true);
    assert.equal(result.hadText, true);
    assert.match(chunks.join(''), /All done\./);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a 503 retries; a 401 does not', async () => {
  const { runAgentLoop } = await import('./chat-agent-loop.js');
  const sse = [
    'data: {"choices":[{"delta":{"content":"Recovered."},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const realFetch = globalThis.fetch;
  // 503 then success → turn completes.
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({ error: { message: 'overloaded' } }),
      };
    }
    return new Response(sse, { status: 200 });
  };
  try {
    const result = await runAgentLoop({
      provider: 'openai',
      env: { OPENAI_API_KEY: 'test-key' },
      model: 'gpt-test',
      userContent: 'hello',
      chatToolNames: ['lykn_web_search'],
      maxOutputTokens: 256,
    });
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  // 401 → immediate error, no retry.
  let authCalls = 0;
  globalThis.fetch = async () => {
    authCalls += 1;
    return {
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'invalid_api_key' } }),
    };
  };
  try {
    const result = await runAgentLoop({
      provider: 'openai',
      env: { OPENAI_API_KEY: 'bad-key' },
      model: 'gpt-test',
      userContent: 'hello',
      chatToolNames: ['lykn_web_search'],
      maxOutputTokens: 256,
    });
    assert.equal(authCalls, 1, 'auth failures never retry');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'error');
  } finally {
    globalThis.fetch = realFetch;
  }
});
