// Source-level characterization of `/api/ai/stream` byte/state contracts.
// Full provider SSE is not exercised here — the harness must not contact
// real AI providers. These guards catch accidental framing / abort / usage
// drift when the handler is extracted or split further.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const streamSrc = readFileSync(join(HERE, '../../server/ai/chatStream.routes.js'), 'utf8');
const invokeSrc = readFileSync(join(HERE, '../../server/ai/chatInvoke.routes.js'), 'utf8');

test('stream registers local-tool-result before the SSE handler (shared bridge)', () => {
  const localIdx = streamSrc.indexOf("app.post('/api/ai/local-tool-result'");
  const streamIdx = streamSrc.indexOf("app.post('/api/ai/stream'");
  assert.ok(localIdx > 0 && streamIdx > localIdx);
  assert.match(streamSrc, /resolveLocalToolResult\(/);
  assert.match(streamSrc, /registerLocalToolStream\(/);
  assert.match(streamSrc, /releaseLocalToolStream\(/);
});

test('SSE framing: token data, keepalive, error, served_model, single [DONE]', () => {
  assert.match(streamSrc, /res\.write\(`data: \$\{JSON\.stringify\(\{ t: text \}\)\}\\n\\n`\)/);
  assert.match(streamSrc, /res\.write\(`data: \$\{JSON\.stringify\(\{ tool_call: evt \}\)\}\\n\\n`\)/);
  assert.match(streamSrc, /res\.write\(`: keepalive \$\{Date\.now\(\)\}\\n\\n`\)/);
  assert.match(streamSrc, /res\.write\(`data: \$\{JSON\.stringify\(\{ error: msg \}\)\}\\n\\n`\)/);
  assert.match(streamSrc, /res\.write\(`data: \$\{JSON\.stringify\(\{ served_model: actualModel \}\)\}\\n\\n`\)/);
  assert.match(streamSrc, /res\.write\('data: \[DONE\]\\n\\n'\)/);
  assert.equal((streamSrc.match(/res\.write\('data: \[DONE\]\\n\\n'\)/g) || []).length, 1);
});

test('sendDone / sendError are gated on writableEnded (no duplicate final)', () => {
  assert.match(streamSrc, /const sendDone = \(\) => \{\s*if \(!res\.writableEnded\)/s);
  assert.match(streamSrc, /const sendError = \(msg\) => \{ if \(!res\.writableEnded\)/);
});

test('client disconnect aborts the in-flight stream', () => {
  assert.match(streamSrc, /req\.on\('close', onStreamClose\)/);
  assert.match(streamSrc, /streamAbort\.abort\(\)/);
});

test('tool loop, MCP/local tools, and usage accounting remain on the stream path', () => {
  assert.match(streamSrc, /runAgentLoop\(/);
  assert.match(streamSrc, /CHAT_TOOLS/);
  assert.match(streamSrc, /LOCAL_TOOL_NAMES/);
  assert.match(streamSrc, /logAiUsage\(/);
  assert.match(streamSrc, /resolveProductionChatMemory\(/);
  assert.match(streamSrc, /fetchProjectSection\(/);
});

test('invoke keeps returnActions as a live public contract', () => {
  assert.match(invokeSrc, /app\.post\('\/api\/ai\/invoke'/);
  assert.match(invokeSrc, /let \{ intent, text, returnActions,/);
  assert.match(invokeSrc, /const wantsActions = Boolean\(returnActions\)/);
});
