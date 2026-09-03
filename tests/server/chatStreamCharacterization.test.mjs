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
  assert.match(streamSrc, /localToolStreams,/);
  assert.match(streamSrc, /RETRYABLE_STATUSES,/);
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
  assert.match(streamSrc, /streamClientToolsEnabled/);
  assert.match(streamSrc, /buildLyknBotsSection/);
  assert.match(streamSrc, /local_ask_bot/);
  assert.match(streamSrc, /logAiUsage\(/);
  assert.match(streamSrc, /resolveProductionChatMemory\(/);
  assert.match(streamSrc, /fetchProjectSection\(/);
});

test('invoke keeps returnActions as a live public contract', () => {
  assert.match(invokeSrc, /app\.post\('\/api\/ai\/invoke'/);
  assert.match(invokeSrc, /let \{ intent, text, returnActions,/);
  assert.match(invokeSrc, /const wantsActions = Boolean\(returnActions\)/);
});

test('stream and invoke build context after Auto routing and use a versioned cache key', () => {
  assert.match(streamSrc, /buildPromptCacheKey\(/);
  assert.match(invokeSrc, /personalizationFingerprint\(/);
  assert.match(streamSrc, /shouldAttachRequestContext\(/);
  assert.match(invokeSrc, /shouldAttachRequestContext\(/);
  assert.match(streamSrc, /contextUsageMetadata\(/);
  assert.match(invokeSrc, /contextUsageMetadata\(/);
  assert.match(streamSrc, /modelTier: chatRoute\?\.modelTier/);
  assert.match(invokeSrc, /modelTier: chatRoute\?\.modelTier/);
});

test('stream and invoke resolve Auto chat routing on the live path', () => {
  assert.match(streamSrc, /resolveChatRoute\(/);
  assert.match(invokeSrc, /resolveChatRoute\(/);
  assert.match(streamSrc, /chatRouteUsageMetadata\(/);
  assert.match(invokeSrc, /chatRouteUsageMetadata\(/);
  assert.match(streamSrc, /openaiReasoningPayload\(/);
  assert.match(streamSrc, /stream_options: \{ include_usage: true \}/);
  assert.match(streamSrc, /isBillableComputeTool\(/);
  assert.match(streamSrc, /planId: streamPlan\.planId/);
  assert.match(invokeSrc, /planId: invokePlan\.planId/);
});

test('stream keeps abuse rate-limit middleware on the chat route', () => {
  assert.match(streamSrc, /app\.post\('\/api\/ai\/stream', requireAuth, requireAppAccess, aiLimiter, checkAiUsageLimit/);
  assert.match(invokeSrc, /app\.post\('\/api\/ai\/invoke', requireAuth, requireAppAccess, aiLimiter, checkAiUsageLimit/);
});

test('stream and invoke import resolveUserPlan from billingService', () => {
  assert.match(streamSrc, /import \{ resolveUserPlan \} from '\.\.\/services\/billingService\.js'/);
  assert.match(invokeSrc, /import \{ resolveUserPlan \} from '\.\.\/services\/billingService\.js'/);
  assert.match(streamSrc, /await resolveUserPlan\(req\.user\?\.id, req\.user\?\.email\)/);
  assert.match(invokeSrc, /await resolveUserPlan\(req\.user\?\.id, req\.user\?\.email\)/);
});

test('stream imports Cursor build helpers used after enrichment', () => {
  assert.match(
    streamSrc,
    /import \{ claimUnannouncedBuilds, isCursorBuildsConfigured \} from '\.\.\/\.\.\/lib\/cursor\/cursorBuilds\.js'/,
  );
  assert.match(streamSrc, /isCursorBuildsConfigured\(\)/);
  assert.match(streamSrc, /claimUnannouncedBuilds\(/);
});

test('browser side chat is ask-only and does not arm agent tools', () => {
  assert.match(streamSrc, /BROWSER_ASK_ONLY_PROMPT/);
  assert.match(streamSrc, /isBrowserAskRequest\(req\.body\)/);
  assert.match(streamSrc, /if \(browserAsk\) prompt \+= "\\n\\n" \+ BROWSER_ASK_ONLY_PROMPT/);
  assert.match(streamSrc, /localMode: streamLocalMode && !browserAsk/);
  assert.match(streamSrc, /lyknBots: browserAsk \? \[\] : sanitizeLyknBots/);
  assert.match(streamSrc, /!browserAsk &&/);
  assert.match(streamSrc, /streamLocalMode = req\.body\?\.localMode === true && !browserAsk/);
  assert.match(streamSrc, /if \(browserAsk && !streamDisclosure\.keepToolsOn\) useTools = false/);
});

test('invoke imports buildYouTubeSearchQuery from webEnrichment', () => {
  assert.match(invokeSrc, /buildYouTubeSearchQuery/);
  assert.match(invokeSrc, /from '\.\/webEnrichment\.js'/);
});
