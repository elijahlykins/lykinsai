// ============================================================================
// chat-agent-loop.js — multi-provider tool-calling agent loop for in-app chat
// ============================================================================
// /api/ai/stream historically only streams text from one provider per turn.
// This module adds a SECOND streaming mode that interleaves text deltas
// with tool calls — and supports it across every provider we route to:
//
//   • OpenAI  — Chat Completions `tools[]` + tool_calls deltas
//   • Grok    — xAI's OpenAI-compatible Chat Completions API
//   • Anthropic — Messages API `tools` + `tool_use` / `tool_result` blocks
//   • Gemini  — generateContent `tools.functionDeclarations` + functionCall /
//               functionResponse parts
//
// Each provider speaks a different streaming SSE shape, so we keep the
// loop per provider rather than trying to normalise them into one parser.
// A small dispatcher at the bottom (`runAgentLoop`) picks the right one
// based on `provider`.
//
// What all four implementations share:
//   1. POST to the provider with messages + tool descriptors.
//   2. Forward text deltas via onTextChunk(t).
//   3. Accumulate tool_call deltas, then on a tool-call finish:
//      - emit `tool_call` SSE events (status: running → done | error)
//      - run the tool via runChatTool (the in-app whitelist)
//      - append the tool result in the provider's native message format
//      - loop to the next hop
//   4. Stop when the provider's "no more tool calls, here's the final
//      reply" signal arrives, or hop cap is hit.
//
// What this module does NOT handle (caller is responsible):
//   • Opening / flushing SSE response headers (server.js does this).
//   • Telemetry / usage logging (server.js fires logAiUsage on done).
//   • Picking the model id (caller passes a provider-correct model).
//   • Fallback when a hop errors before any text — caller can decide
//     to retry on a different provider, fall back to the legacy stream,
//     or surface an error.

import {
  runChatTool,
  buildOpenAiTools,
  buildAnthropicTools,
  buildGeminiTools,
} from './mcp-tools/chatTools.js';
import { inferNewBuildActivities } from './lib/ai/buildNarration.js';

const MAX_HOPS = 6;
/** Complex coding / multi-file artifact builds get a longer tool loop. */
const MAX_HOPS_CODING = 28;
/** Open-panel refine: short loop — one batched edit, not 6 sequential rebuilds. */
const MAX_HOPS_EDIT = 8;
const MAX_HOPS_HARD_CAP = 40;
const MAX_TOOL_CALLS_PER_HOP = 5;
const MAX_TOOL_CALLS_PER_HOP_CODING = 8;
const MAX_TOOL_CALLS_PER_HOP_EDIT = 3;
const TOOL_RESULT_CAP = 16000;

/** Tools that produce a user-visible artifact card when they succeed. */
const ARTIFACT_SHIP_TOOLS = new Set([
  'lykn_build_react_artifact',
  'lykn_build_template',
  'lykn_build_spreadsheet',
  'lykn_manage_file',
  'lykn_render_video',
]);

function isEditArtifactTurn(ctx) {
  if (!ctx || typeof ctx !== 'object') return false;
  if (ctx.editingArtifact === true) return true;
  if (typeof ctx.activeArtifactCode === 'string' && ctx.activeArtifactCode.trim()) return true;
  if (Array.isArray(ctx.activeArtifactFiles) && ctx.activeArtifactFiles.length > 0) return true;
  if (
    ctx.activeArtifactFiles &&
    typeof ctx.activeArtifactFiles === 'object' &&
    !Array.isArray(ctx.activeArtifactFiles) &&
    Object.keys(ctx.activeArtifactFiles).length > 0
  ) {
    return true;
  }
  if (Array.isArray(ctx.activeArtifactSections) && ctx.activeArtifactSections.length > 0) return true;
  if (typeof ctx.activeArtifactContent === 'string' && ctx.activeArtifactContent.trim()) return true;
  if (Array.isArray(ctx.activeArtifactRows) && ctx.activeArtifactRows.length > 0) return true;
  return false;
}

function resolveMaxHops(opts) {
  const requested = Number(opts?.maxHops);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.max(Math.floor(requested), 1), MAX_HOPS_HARD_CAP);
  }
  if (opts?.editingArtifact) return MAX_HOPS_EDIT;
  return opts?.codingMode ? MAX_HOPS_CODING : MAX_HOPS;
}

function resolveMaxToolCallsPerHop(opts) {
  if (opts?.editingArtifact) return MAX_TOOL_CALLS_PER_HOP_EDIT;
  if (opts?.codingMode) return MAX_TOOL_CALLS_PER_HOP_CODING;
  return MAX_TOOL_CALLS_PER_HOP;
}

/** Keep open-artifact ctx in sync so a rare second hop patches the latest code. */
function refreshActiveArtifactCtx(ctx, results) {
  if (!ctx || !Array.isArray(results)) return;
  for (const r of results) {
    if (!r || r.isError || !r.payload || r.payload.ok === false) continue;
    const p = r.payload;
    if (r.name === 'lykn_build_react_artifact') {
      if (typeof p.artifact_code === 'string' && p.artifact_code.trim()) {
        ctx.activeArtifactCode = p.artifact_code;
      }
      if (Array.isArray(p.artifact_files) && p.artifact_files.length) {
        ctx.activeArtifactFiles = p.artifact_files;
      }
      if (typeof p.entry === 'string' && p.entry.trim()) {
        ctx.activeArtifactEntry = p.entry.trim();
      }
      if (Array.isArray(p.todos)) ctx.activeArtifactTodos = p.todos;
      if (typeof p.title === 'string' && p.title.trim()) {
        ctx.activeArtifactTitle = p.title.trim();
      }
    } else if (r.name === 'lykn_build_template') {
      if (Array.isArray(p.sections)) ctx.activeArtifactSections = p.sections;
      if (typeof p.content === 'string') ctx.activeArtifactContent = p.content;
      if (typeof p.theme === 'string') ctx.activeArtifactTheme = p.theme;
      if (typeof p.font === 'string') ctx.activeArtifactFont = p.font;
    } else if (r.name === 'lykn_manage_file') {
      if (typeof p.artifact_content === 'string') ctx.activeArtifactContent = p.artifact_content;
      else if (typeof p.content === 'string') ctx.activeArtifactContent = p.content;
    } else if (r.name === 'lykn_build_spreadsheet') {
      if (Array.isArray(p.headers)) ctx.activeArtifactHeaders = p.headers;
      if (Array.isArray(p.rows)) ctx.activeArtifactRows = p.rows;
    }
  }
}

function artifactShippedFromResults(results) {
  return (Array.isArray(results) ? results : []).some(
    (r) =>
      r &&
      ARTIFACT_SHIP_TOOLS.has(r.name) &&
      !r.isError &&
      r.payload &&
      r.payload.ok !== false,
  );
}
// A healthy OpenAI-style stream ALWAYS ends with a finish_reason chunk.
// xAI in particular sometimes drops the connection mid-generation during a
// long reasoning pause (observed: stream ends cleanly after ~40s with no
// finish_reason, no tool deltas, no error) — the turn looks like a polite
// "nothing to do" and the user gets no artifact. Retry the hop ONCE (each
// doomed attempt costs ~40s of user-visible waiting), then bail with
// `forced_tool_incomplete` so the server's provider fallback takes over.
const MAX_TRUNCATED_STREAM_RETRIES = 1;
// Deep-research reports (markdown + stock/chart/sheet fences) often hit a
// provider's per-call output ceiling mid-embed. Continue the same turn a
// few times so the report finishes with closed fences + Sources instead of
// leaving the client with raw truncated embed JSON.
const MAX_RESEARCH_CONTINUES = 3;
const RESEARCH_CONTINUE_PROMPT =
  '[Continue the research report from exactly where you left off. ' +
  'Do not restart or repeat completed sections. ' +
  'If a ```stock / ```chart / ```sheet fence is still open, close it with valid content and ``` first. ' +
  'Then finish remaining findings and end with the Sources section. ' +
  'Never leave an open code fence.]';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function safeJsonParse(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

/** True when a research report looks truncated mid-embed or missing Sources. */
export function researchReportLooksIncomplete(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  // Unclosed markdown fence (odd number of ``` markers).
  const ticks = s.match(/```/g);
  if (ticks && ticks.length % 2 !== 0) return true;
  // Substantial report body without a Sources section yet.
  if (
    s.length > 1200 &&
    !/(?:^|\n)#{1,3}\s*sources\b/i.test(s) &&
    !/(?:^|\n)\*\*sources\*\*/i.test(s)
  ) {
    return true;
  }
  return false;
}

function isLengthStopReason(reason) {
  const r = String(reason || '').toLowerCase();
  return (
    r === 'length' ||
    r === 'max_tokens' ||
    r === 'max_token' ||
    r === 'model_length'
  );
}

/**
 * After a text-only hop, decide whether to continue a deep-research report.
 * Returns true when the caller should push a continue user turn and keep looping.
 */
function shouldContinueIncompleteResearch({
  continueIncompleteResearch,
  researchContinues,
  accumulatedText,
  pendingToolCalls,
}) {
  if (!continueIncompleteResearch) return false;
  if (researchContinues >= MAX_RESEARCH_CONTINUES) return false;
  if (pendingToolCalls) return false;
  if (!researchReportLooksIncomplete(accumulatedText)) return false;
  // Incomplete report (open fence / missing Sources) — keep going whether the
  // provider reported length or a quiet stop mid-fence.
  return true;
}

// ---------------------------------------------------------------------------
// Brand casing — the product name is always LYKN (all caps) in user-facing
// text. Models sometimes emit "Lykn" / "lykn"; rewrite those before the
// chunk reaches the client. Leave technical forms alone: lykn.io, lykn_*,
// lykn-* (overlay markers like lykn-artifact: / lykn-video:), /lykn/..., @lykn.
// ---------------------------------------------------------------------------
const LYKN_BRAND_RE = /\b[Ll][Yy][Kk][Nn]\b(?!\.io\b)(?![_\-/])/g;

export function normalizeLyknBrandCasing(text) {
  if (!text) return text;
  return String(text).replace(LYKN_BRAND_RE, 'LYKN');
}

// Hold back a trailing 1–3 char prefix of "lykn" (any case) so a chunk that
// ends mid-brand ("Ly" + next "kn") isn't flushed before we can normalize.
function splitBrandHoldTail(text) {
  const s = String(text || '');
  if (!s) return { safe: '', hold: '' };
  const m = s.match(/([Ll][Yy]?[Kk]?[Nn]?)$/);
  if (!m) return { safe: s, hold: '' };
  const tail = m[1];
  const lower = tail.toLowerCase();
  if (lower.length === 0 || lower.length >= 4) return { safe: s, hold: '' };
  if (!'lykn'.startsWith(lower)) return { safe: s, hold: '' };
  const start = s.length - tail.length;
  if (start > 0 && /[A-Za-z0-9]/.test(s[start - 1])) return { safe: s, hold: '' };
  return { safe: s.slice(0, start), hold: tail };
}

function emitNormalized(onTextChunk, text) {
  if (!text) return;
  const out = normalizeLyknBrandCasing(text);
  if (out) {
    try { onTextChunk?.(out); } catch { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// Tool-syntax stripper — sanitises model TEXT output before it streams to
// the user. Some models (especially smaller ones) will emit literal
// tool-call syntax as text instead of (or in addition to) actually
// invoking the function via the native tool-calling channel, e.g.:
//   "Let me check. [memory_list({})]"
// or "<tool>lykn_listProjects()</tool>".
//
// Those should never reach the user. We can't fully prevent it on the
// prompt side — every provider includes the tool descriptors in its
// own way and the model can hallucinate call syntax from the
// descriptors alone — so we run a streaming-safe stripper on every
// outgoing text chunk.
//
// Streaming-safe means:
//   • Strip COMPLETE patterns immediately.
//   • For any PARTIAL pattern at the tail (e.g. chunk ends mid-
//     "[lykn_") hold the tail back until the next chunk arrives.
//   • Cap the hold at MAX_HOLD so a model that opens a `[` and never
//     closes it doesn't block the stream forever — past the cap we
//     drop the unclosed opener (and any continuation chunks until />)
//     rather than leaking tool-call syntax to the user.
//   • Flush whatever's left when the hop ends.
//
// We deliberately don't strip bare tool-name MENTIONS without a call
// (e.g. the user asking "what is memory_list?" and the model
// repeating the name in its answer). The stripper only kills text
// that looks like an actual function-call invocation.
// ---------------------------------------------------------------------------

const STRIP_PATTERNS = [
  // Supabase storage URLs must NEVER reach the user — generated/edited
  // images, vault files, etc. are all rendered via artifact/attachment
  // cards from the tool result, so a raw signed URL in the reply text is
  // always a leak. Kill the markdown image/link wrapper first (so we don't
  // leave a dangling `![]()`), then any bare URL. Covers signed / public /
  // authenticated object paths on any *.supabase.co project host.
  /!\[[^\]]*\]\(\s*https?:\/\/[a-z0-9-]+\.supabase\.co\/[^)]*\)/gi,
  /\[[^\]]*\]\(\s*https?:\/\/[a-z0-9-]+\.supabase\.co\/[^)]*\)/gi,
  /<?https?:\/\/[a-z0-9-]+\.supabase\.co\/[^\s)>\]]+>?/gi,
  // [lykn_xxx({...})] — bracketed call (most common imitation pattern,
  // and what shows up when smaller models echo the OpenAI-style
  // function descriptors).
  /\[\s*lykn_\w+\s*\([\s\S]*?\)\s*\]/g,
  // lykn_xxx({...}) — bare JSON-shaped call
  /\blykn_\w+\s*\(\s*\{[\s\S]*?\}\s*\)/g,
  // lykn_xxx() — empty-args call
  /\blykn_\w+\s*\(\s*\)/g,
  // <tool_use ... /> and <tool_use>...</tool_use> — Cursor / Anthropic XML
  // that some models echo as plain text instead of using native tool calls.
  /<tool_use\b[^>]*\/>/gi,
  /<tool_use\b[^>]*>[\s\S]*?<\/tool_use>/gi,
  /<\/?tool_use\b[^>]*>/gi,
  // <tool>...</tool>, <tool_call>...</tool_call>, etc.
  /<tool[_a-z]*[^>]*>[\s\S]*?<\/tool[_a-z]*>/gi,
  // Lone opening/closing tool tags (in case the close was on a
  // different hop or got mangled mid-stream).
  /<\/?tool[_a-z]*[^>]*>/gi,
  // <function_call>...</function_call> etc.
  /<function[_a-z]*[^>]*>[\s\S]*?<\/function[_a-z]*>/gi,
  /<\/?function[_a-z]*[^>]*>/gi,
];

// Openers that indicate a partial tool-call invocation that hasn't
// closed yet — when one of these matches near the tail, hold the
// tail back rather than flushing.
const STRIP_OPENERS = [
  /\[\s*lykn_/,
  /\blykn_\w+\s*\(/,
  /<tool_use\b/i,
  /<tool[_a-z]*/i,
  /<function[_a-z]*/i,
  // Hold the tail the moment a Supabase URL (or its markdown wrapper)
  // starts, so a half-streamed signed URL can't flush before the closing
  // token arrives and applyStripPatterns can remove the whole thing.
  /!?\[[^\]]*\]\(\s*https?:\/\/[a-z0-9-]+\.supabase\.co/i,
  /https?:\/\/[a-z0-9-]+\.supabase\.co/i,
];

// `local_pull_file` uploads land under a `/local-pull/` storage path and are
// the ONE kind of storage URL that is SUPPOSED to appear in reply text — the
// local tool executor explicitly tells the model to embed it (e.g.
// `![photo](signed-url)`). Every other *.supabase.co URL is still a leak.
const LOCAL_PULL_ALLOWED_RE =
  /!?\[[^\]]*\]\(\s*https?:\/\/[a-z0-9-]+\.supabase\.co\/[^)]*\/local-pull\/[^)]*\)|https?:\/\/[a-z0-9-]+\.supabase\.co\/[^\s)>\]]*\/local-pull\/[^\s)>\]]*/gi;

// Same-length mask (private-use char run) so indices in the masked copy map
// 1:1 onto the original — used by the opener scan, never emitted.
function maskAllowedUrlsForScan(text) {
  return text.replace(LOCAL_PULL_ALLOWED_RE, (m) => '\uE000'.repeat(m.length));
}

function applyStripPatterns(text) {
  // Tokenize allowed local-pull embeds out of the way, strip, then restore.
  const kept = [];
  let out = text.replace(LOCAL_PULL_ALLOWED_RE, (m) => {
    kept.push(m);
    return `\uE000${kept.length - 1}\uE001`;
  });
  for (const re of STRIP_PATTERNS) out = out.replace(re, '');
  return out.replace(/\uE000(\d+)\uE001/g, (_m, i) => kept[Number(i)] ?? '');
}

/** Strip tool-call syntax from a complete (non-streaming) model response. */
export function stripToolSyntaxFromText(text) {
  if (typeof text !== 'string' || !text) return text;
  return normalizeLyknBrandCasing(applyStripPatterns(text));
}

const TOOL_USE_SELF_CLOSE = /\/>/;
const TOOL_USE_BLOCK_CLOSE = /<\/tool_use>/i;

export function makeToolSyntaxStripper(onTextChunk, MAX_HOLD = 16384) {
  let buffer = '';
  // After discarding an unclosed opener, suppress continuation chunks
  // (e.g. the tail of a long arguments="..." value) until we see /> or
  // </tool_use>, so a mid-tag stream split cannot leak argument debris.
  let dropUntilClose = false;
  // Hold a 1–3 char trailing prefix of "lykn" so brand casing can normalize
  // across chunk boundaries ("Ly" + "kn" → "LYKN", not "Ly" then "kn").
  let brandHold = '';
  const findEarliestOpener = (text) => {
    // Scan a masked copy: a COMPLETE allowed local-pull embed must not trip
    // the Supabase-URL openers (it would hold the tail forever and the embed
    // would never flush). Incomplete embeds don't match the mask, so a
    // half-streamed URL is still held back until its closing token arrives.
    const scan = maskAllowedUrlsForScan(text);
    let earliestOpener = -1;
    for (const re of STRIP_OPENERS) {
      const m = re.exec(scan);
      if (m && (earliestOpener < 0 || m.index < earliestOpener)) {
        earliestOpener = m.index;
      }
    }
    return earliestOpener;
  };
  const flushSafeText = (text, { final = false } = {}) => {
    if (!text && !brandHold) return;
    const combined = brandHold + (text || '');
    brandHold = '';
    if (final) {
      emitNormalized(onTextChunk, combined);
      return;
    }
    const { safe, hold } = splitBrandHoldTail(combined);
    brandHold = hold;
    emitNormalized(onTextChunk, safe);
  };
  const consumeDroppedTail = () => {
    const selfClose = buffer.search(TOOL_USE_SELF_CLOSE);
    const blockClose = buffer.search(TOOL_USE_BLOCK_CLOSE);
    let closeAt = -1;
    let closeLen = 0;
    if (selfClose >= 0 && (blockClose < 0 || selfClose < blockClose)) {
      closeAt = selfClose;
      closeLen = 2;
    } else if (blockClose >= 0) {
      closeAt = blockClose;
      const m = buffer.slice(blockClose).match(TOOL_USE_BLOCK_CLOSE);
      closeLen = m ? m[0].length : 10;
    }
    if (closeAt >= 0) {
      buffer = buffer.slice(closeAt + closeLen);
      dropUntilClose = false;
      buffer = applyStripPatterns(buffer);
      return true;
    }
    if (buffer.length > MAX_HOLD) {
      buffer = '';
      dropUntilClose = false;
    }
    return false;
  };
  return {
    ingest(chunk) {
      if (!chunk) return;
      buffer += chunk;
      if (dropUntilClose) {
        while (dropUntilClose && consumeDroppedTail()) { /* drain */ }
        if (dropUntilClose) return;
      }
      // Kill any complete patterns inline (cheap; idempotent).
      buffer = applyStripPatterns(buffer);
      // Find earliest position where an UNCLOSED opener starts.
      // Anything before that is safe to flush.
      const earliestOpener = findEarliestOpener(buffer);
      let safeLen;
      if (earliestOpener >= 0) {
        const tailLen = buffer.length - earliestOpener;
        if (tailLen <= MAX_HOLD) {
          // Hold the tail until the opener closes or more chunks arrive.
          safeLen = earliestOpener;
        } else {
          // Tail grew past MAX_HOLD without closing — drop the unclosed
          // opener entirely rather than leaking it (common with long
          // <tool_use ... arguments="..."/> echoes).
          const prefix = buffer.slice(0, earliestOpener);
          flushSafeText(prefix);
          buffer = buffer.slice(earliestOpener);
          dropUntilClose = true;
          while (dropUntilClose && consumeDroppedTail()) { /* drain */ }
          return;
        }
      } else {
        safeLen = buffer.length;
      }
      if (safeLen > 0) {
        const out = buffer.slice(0, safeLen);
        flushSafeText(out);
        buffer = buffer.slice(safeLen);
      }
    },
    flush() {
      if (dropUntilClose) {
        buffer = '';
        dropUntilClose = false;
        brandHold = '';
        return;
      }
      buffer = applyStripPatterns(buffer);
      const earliestOpener = findEarliestOpener(buffer);
      const out = earliestOpener >= 0 ? buffer.slice(0, earliestOpener) : buffer;
      flushSafeText(out, { final: true });
      buffer = '';
    },
  };
}

// Fields that are only useful for the client-side artifact renderer (e.g. the
// full HTML used for an inline srcDoc preview, or the merged JSX after an
// `edits` patch build). Stripping them keeps the model's tool-result context
// lean and prevents the model from echoing raw markup back into the chat.
const CLIENT_ONLY_RESULT_FIELDS = ['preview_html', 'artifact_code', 'artifact_files'];

function serialiseToolResult(payload) {
  try {
    let forModel = payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      let stripped = false;
      const copy = {};
      for (const [k, v] of Object.entries(payload)) {
        if (CLIENT_ONLY_RESULT_FIELDS.includes(k)) {
          stripped = true;
          continue;
        }
        copy[k] = v;
      }
      if (stripped) forModel = copy;
    }
    const json = JSON.stringify(forModel);
    if (json.length <= TOOL_RESULT_CAP) return json;
    return JSON.stringify({
      ok: payload?.ok,
      truncated: true,
      preview: json.slice(0, TOOL_RESULT_CAP),
    });
  } catch {
    return String(payload || '');
  }
}

/**
 * Wrap onToolCall with try/catch + an `allToolCalls` push so the loop
 * record stays consistent even if the SSE write fails (e.g. socket
 * closed mid-stream).
 */
function makeToolCallRecorder(onToolCall, allToolCalls) {
  return function record(evt) {
    try { onToolCall?.(evt); } catch { /* swallow */ }
    if (evt.status === 'done' || evt.status === 'error') {
      allToolCalls.push({
        id: evt.id,
        name: evt.name,
        args: evt.args,
        status: evt.status,
        result: evt.result,
        error: evt.error,
        latencyMs: evt.latencyMs,
      });
    }
  };
}

// ── Tool-arg streaming narration ─────────────────────────────────────
// For builder tools the model's tool-call ARGUMENTS are the deliverable
// itself (the entire component source / document / composition), so the
// dominant wait of a Build turn happens while those args stream — before
// the tool ever reports "running". Without narration the status bubble
// sits on a single line for a minute+. The narrator turns that arg stream
// into live, deep-research-style progress: an opening beat when the tool
// is first named, the artifact's title as soon as it can be parsed out of
// the partial JSON, then the section / file / todo currently being written
// ("Building out the hero…"), with throttled "Writing the code… (12k)"
// ticks only when no part can be inferred yet.
const ARG_STREAM_START_LINES = {
  lykn_build_react_artifact: 'Designing the build…',
  lykn_build_template: 'Drafting the document…',
  lykn_build_spreadsheet: 'Laying out the spreadsheet…',
  lykn_render_video: 'Composing the video…',
  lykn_generate_image: 'Designing the image…',
};

const ARG_PROGRESS_VERBS = {
  lykn_build_react_artifact: 'Writing the code',
  lykn_build_template: 'Writing the document',
  lykn_build_spreadsheet: 'Filling in the spreadsheet',
  lykn_render_video: 'Writing the animation',
};

/** Pull a `"title": "..."` value out of a PARTIAL JSON arg buffer. */
function extractTitleFromPartialArgs(buf) {
  const m = /"title"\s*:\s*"((?:[^"\\]|\\.){1,80})/.exec(String(buf || ''));
  if (!m) return '';
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

function makeToolArgNarrator(onStatus) {
  if (typeof onStatus !== 'function') return () => {};
  const announced = new Set();
  const titled = new Set();
  const seenParts = new Set();
  let lastProgressAt = 0;
  let lastPartAt = 0;
  return function narrate(name, argsBuf = '') {
    if (!name) return;
    try {
      if (!announced.has(name)) {
        announced.add(name);
        const line = ARG_STREAM_START_LINES[name];
        if (line) onStatus(line);
      }
      const verb = ARG_PROGRESS_VERBS[name];
      if (!verb) return;
      if (!titled.has(name)) {
        const title = extractTitleFromPartialArgs(argsBuf);
        if (title) {
          titled.add(name);
          onStatus(`Building ${title.slice(0, 60)}…`);
        }
      }
      const fresh = inferNewBuildActivities(name, argsBuf, seenParts);
      if (fresh.length) {
        lastPartAt = Date.now();
        onStatus(fresh[fresh.length - 1].line);
        return;
      }
      const now = Date.now();
      // Byte ticks only fill gaps — once a section is on screen, keep it
      // until the next part appears so the bubble reads as thinking.
      if (argsBuf.length >= 400 && now - lastProgressAt >= 1800 && now - lastPartAt >= 2800) {
        lastProgressAt = now;
        const kb = argsBuf.length >= 1000 ? `${Math.round(argsBuf.length / 100) / 10}k` : `${argsBuf.length}`;
        onStatus(`${verb}… (${kb})`);
      }
    } catch {
      /* narration must never break the stream */
    }
  };
}

/**
 * Execute a batch of resolved tool calls in parallel, emitting
 * running/done events through `record`. Returns the array of normalised
 * results in the same order as `calls`.
 *
 *   calls: [{ id, name, args }]
 */
async function runToolBatch(calls, ctx, record, allowedToolNames, onActivity, maxToolCallsPerHop = MAX_TOOL_CALLS_PER_HOP) {
  // Drop exact duplicates (same tool, identical args) within one hop.
  // Models occasionally emit the same call twice in a parallel batch;
  // for expensive builders that means two persisted artifacts — the user
  // sees a duplicate card. The duplicate still gets a tool_result (echoing
  // the first call's payload) so the provider's message contract holds.
  const seen = new Map(); // key → first call
  const unique = [];
  const dupOf = new Map(); // dup call id → original call
  for (const call of calls) {
    const key = `${call.name}:${JSON.stringify(call.args ?? {})}`;
    const first = seen.get(key);
    if (first) {
      console.warn(`[chat-agent-loop] dropping duplicate tool call ${call.name} (identical args)`);
      dupOf.set(call.id, first);
      continue;
    }
    seen.set(key, call);
    unique.push(call);
  }

  // Edit turns: one artifact shipper per hop. Extra builder calls become a
  // soft bounce so the model batches find/replace into a single `edits` array
  // instead of flooding the chat with intermediate versions.
  const editTurn = isEditArtifactTurn(ctx);
  const skippedExtraShip = [];
  let shipSeen = false;
  const dedupedForEdit = [];
  for (const call of unique) {
    if (editTurn && ARTIFACT_SHIP_TOOLS.has(call.name)) {
      if (shipSeen) {
        skippedExtraShip.push(call);
        continue;
      }
      shipSeen = true;
    }
    dedupedForEdit.push(call);
  }

  const perHopCap = Math.min(Math.max(Number(maxToolCallsPerHop) || MAX_TOOL_CALLS_PER_HOP, 1), 12);
  const capped = dedupedForEdit.slice(0, perHopCap);
  if (unique.length > perHopCap || skippedExtraShip.length) {
    console.warn(
      `[chat-agent-loop] capping tool calls (edit=${editTurn}, kept=${capped.length}, skippedShip=${skippedExtraShip.length}, raw=${unique.length})`,
    );
  }
  const toolOpts = Array.isArray(allowedToolNames) ? { allowedToolNames } : {};
  // Image gen / Remotion / big builds can sit silent for minutes while the
  // provider works. Ping the stall watchdog so the SSE stream isn't killed
  // mid-tool with a fake "connection" error.
  const keepAlive = setInterval(() => {
    try { onActivity?.(); } catch { /* swallow */ }
  }, 8000);
  // Local Mode tools (file / terminal) never run on the server. When the
  // turn enabled Local Mode, the ctx carries an awaiter that ships the call
  // to the desktop client, waits for it to run the tool in the Electron main
  // process (with any user approval), and resolves with the result.
  const localToolNames = Array.isArray(ctx?.localToolNames) ? ctx.localToolNames : null;
  const awaitLocalTool =
    typeof ctx?.awaitLocalTool === 'function' ? ctx.awaitLocalTool : null;
  const isLocalCall = (name) =>
    !!localToolNames && !!awaitLocalTool && localToolNames.includes(name);

  let executed;
  try {
    executed = await Promise.all(capped.map(async (call) => {
      if (isLocalCall(call.name)) {
        const { payload, isError, latencyMs } = await awaitLocalTool(call, record, onActivity);
        try { onActivity?.(); } catch { /* swallow */ }
        return { id: call.id, name: call.name, args: call.args, payload, isError, latencyMs };
      }
      record({ id: call.id, name: call.name, args: call.args, status: 'running' });
      const { payload, isError, latencyMs } = await runChatTool(call.name, call.args, ctx, toolOpts);
      record({
        id: call.id,
        name: call.name,
        args: call.args,
        status: isError ? 'error' : 'done',
        result: payload,
        latencyMs,
      });
      try { onActivity?.(); } catch { /* swallow */ }
      return { id: call.id, name: call.name, args: call.args, payload, isError, latencyMs };
    }));
  } finally {
    clearInterval(keepAlive);
  }

  // Soft-reject extra artifact builders on edit turns (no second card).
  for (const call of skippedExtraShip) {
    const payload = {
      ok: false,
      error: 'batch_edits_required',
      hint:
        'Put EVERY requested change into ONE tool call — e.g. lykn_build_react_artifact with ' +
        'an `edits` array of all {find, replace} patches (and path for multi-file). ' +
        'Do not call the builder once per tweak; the panel already has the latest version.',
    };
    record({
      id: call.id,
      name: call.name,
      args: call.args,
      status: 'error',
      result: payload,
      latencyMs: 0,
    });
    executed.push({
      id: call.id,
      name: call.name,
      args: call.args,
      payload,
      isError: true,
      latencyMs: 0,
    });
  }

  // Every provider requires a tool result for EVERY call id it emitted —
  // answer dropped duplicates with the original call's payload (without
  // re-emitting client events, so no duplicate artifact cards).
  const byOriginalId = new Map(executed.map((r) => [r.id, r]));
  const dupResults = [];
  for (const [dupId, original] of dupOf) {
    const src = byOriginalId.get(original.id);
    if (src) dupResults.push({ ...src, id: dupId });
  }
  const all = executed.concat(dupResults);
  refreshActiveArtifactCtx(ctx, all);
  return all;
}

/**
 * Walk an SSE response body, calling `processPayload(payload)` for
 * each `data: <payload>` event. Works on the Web `ReadableStream` that
 * Node 18+'s global `fetch()` returns (NOT a Node stream — Web streams
 * don't have `.on()`).
 *
 * Returns a Promise that resolves once the stream ends or rejects on
 * a transport error.
 *
 * `onActivity` (optional) fires on every raw chunk received from the
 * upstream provider — BEFORE we parse / forward anything. The server's
 * stall watchdog only refreshes on text/tool SSE events it forwards to
 * the client, so a model that spends a long time streaming a large
 * tool-call argument (e.g. building an interactive HTML page passed as
 * tool args) emits no forwardable events for that whole stretch and the
 * watchdog would otherwise abort a perfectly healthy stream. Counting
 * raw upstream bytes as activity keeps the watchdog honest: it still
 * catches a genuinely wedged provider (no bytes at all) but no longer
 * kills a stream that's actively receiving argument tokens.
 */
async function readSseStream(body, processPayload, onActivity) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handlePayload = (payload) => {
    if (!payload || payload === '[DONE]') return;
    processPayload(payload);
  };

  const drainBuffered = () => {
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      handlePayload(trimmed.slice(6));
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { try { onActivity?.(); } catch { /* swallow */ } }
      buffer += decoder.decode(value, { stream: true });
      drainBuffered();
    }
    // Flush any trailing decoded bytes + handle the last line if it
    // wasn't newline-terminated.
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        handlePayload(trimmed.slice(6));
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Gemini variant — same envelope as readSseStream but parses each
 * `data: <json>` payload as JSON before forwarding. Gemini's
 * streamGenerateContent always sends well-formed JSON per data event,
 * but we still try/catch each parse so a single malformed chunk
 * doesn't kill the whole stream.
 */
async function readGeminiSseStream(body, processJson, onActivity) {
  await readSseStream(body, (payload) => {
    try { processJson(JSON.parse(payload)); } catch { /* skip malformed */ }
  }, onActivity);
}

function buildPriorTurns(priorTurns, openaiStyle = true) {
  const out = [];
  for (const turn of priorTurns || []) {
    if (!turn || typeof turn !== 'object') continue;
    const role = turn.role === 'assistant' ? 'assistant' : 'user';
    const content = typeof turn.content === 'string' ? turn.content : '';
    if (!content) continue;
    if (openaiStyle) {
      out.push({ role, content });
    } else {
      // Anthropic + Gemini both use a `messages`-style or `contents`-style
      // input where the role is the same but the field is `content` vs
      // `parts`. Each provider does its own remap above where it needs to.
      out.push({ role, content });
    }
  }
  return out;
}

// ===========================================================================
// OpenAI / Grok agent loop (shared — Grok is OpenAI-compatible)
// ===========================================================================

async function runOpenAiCompatLoop({
  apiKey,
  baseUrl,                      // 'https://api.openai.com/v1' or 'https://api.x.ai/v1'
  model,
  systemPrompt,
  userContent,
  priorTurns = [],
  maxOutputTokens,
  promptCacheKey,               // OpenAI only; safe to pass to Grok (ignored)
  ctx,
  signal,
  onTextChunk,
  onToolCall,
  onStatus,
  onActivity,                   // fires on every raw upstream chunk (stall-watchdog keepalive)
  providerLabel = 'openai',
  chatToolNames,
  forceToolName,                // when set, force this tool on the first hop
  maxHops,
  codingMode,
  continueIncompleteResearch = false,
}) {
  if (!apiKey) {
    return { ok: false, hadText: false, toolCalls: [], reason: 'error', errorMessage: `${providerLabel} API key missing` };
  }
  const tools = buildOpenAiTools(chatToolNames);
  if (!tools) {
    return { ok: false, hadText: false, toolCalls: [], reason: 'error', errorMessage: 'no_chat_tools_whitelisted' };
  }

  const editingArtifact = isEditArtifactTurn(ctx);
  const hopLimit = resolveMaxHops({ maxHops, codingMode, editingArtifact });
  const toolCallsPerHop = resolveMaxToolCallsPerHop({ codingMode, editingArtifact });
  const effectiveHopLimit = continueIncompleteResearch
    ? hopLimit + MAX_RESEARCH_CONTINUES
    : hopLimit;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  for (const t of buildPriorTurns(priorTurns)) messages.push(t);
  messages.push({ role: 'user', content: userContent });

  const allToolCalls = [];
  const record = makeToolCallRecorder(onToolCall, allToolCalls);
  const stripper = makeToolSyntaxStripper(onTextChunk);
  let hadText = false;
  // Once the FORCED tool has run successfully, lock tools off for the rest
  // of the turn. Without this, expensive builders (e.g. the React-artifact
  // tool, whose args are the entire component source) get re-invoked "one
  // more time" by eager models — each redo streams tens of KB of arguments
  // again, and a few redos in a row blows straight through the route's
  // hard SSE timeout while the user watches nothing happen.
  let forcedToolDone = false;
  // Edit turns: after the first successful artifact ship, lock tools off so
  // we don't emit 5 more "edited versions" as separate cards in one prompt.
  let artifactDelivered = false;
  let truncatedRetries = 0;
  let researchContinues = 0;
  let accumulatedAssistantText = '';

  for (let hop = 0; hop < effectiveHopLimit; hop++) {
    if (signal?.aborted) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: 'aborted' };
    }

    let res;
    try {
      // Force a specific tool on the first hop when requested (e.g. the
      // chat-bar "+" Generate-image mode). Once it has succeeded, tools go
      // to 'none' so the model must write its final reply; otherwise
      // subsequent hops go back to 'auto'.
      const forceThisHop = hop === 0 && forceToolName;
      const toolsLocked = forcedToolDone || artifactDelivered || researchContinues > 0;
      const body = {
        model,
        messages,
        tools,
        tool_choice: forceThisHop
          ? { type: 'function', function: { name: forceToolName } }
          : (toolsLocked ? 'none' : 'auto'),
        parallel_tool_calls: forceThisHop || editingArtifact ? false : true,
        max_completion_tokens: maxOutputTokens,
        stream: true,
        ...(promptCacheKey && providerLabel === 'openai' ? { prompt_cache_key: promptCacheKey } : {}),
        // gpt-5.6-* reasoning models reject function tools on
        // /chat/completions unless reasoning is off ("use /v1/responses or
        // set reasoning_effort to 'none'"). Tool turns don't need the
        // reasoning pass, so turn it off rather than porting the whole loop
        // to the Responses API.
        ...(providerLabel === 'openai' && /^gpt-5\.6/.test(String(model)) ? { reasoning_effort: 'none' } : {}),
      };
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: err?.message || String(err) };
    }

    if (!res.ok) {
      let errBody;
      try { errBody = await res.json(); } catch { errBody = null; }
      const msg = errBody?.error?.message || res.statusText || `${providerLabel} ${res.status}`;
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: msg };
    }

    const pendingCalls = new Map(); // index → { id, name, argsBuf }
    let finishReason = '';
    let hopText = '';
    const narrate = makeToolArgNarrator(onStatus);

    try {
      await readSseStream(res.body, (payload) => {
        const parsed = safeJsonParse(payload);
        const choice = parsed?.choices?.[0];
        if (!choice) return;
        const delta = choice.delta || {};
        if (typeof delta.content === 'string' && delta.content) {
          hadText = true;
          hopText += delta.content;
          stripper.ingest(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            let acc = pendingCalls.get(idx);
            if (!acc) { acc = { id: '', name: '', argsBuf: '' }; pendingCalls.set(idx, acc); }
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') acc.argsBuf += tc.function.arguments;
            narrate(acc.name, acc.argsBuf);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }, onActivity);
    } catch (err) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: err?.message || String(err) };
    }

    if (hopText) accumulatedAssistantText += hopText;

    // Truncated stream: the provider closed the connection without ever
    // sending finish_reason. With a forced tool still pending that means
    // the model died mid-reasoning (xAI does this reproducibly whenever an
    // image is attached to a forced-tool request, and intermittently on
    // long thinking pauses) — nothing was produced, so silently accepting
    // it strands the user with no artifact and no error. Retry the hop;
    // once retries are exhausted, surface a distinct reason so the caller
    // can re-run the whole turn on a different provider.
    if (!finishReason && pendingCalls.size === 0 && forceToolName && !forcedToolDone) {
      if (truncatedRetries < MAX_TRUNCATED_STREAM_RETRIES) {
        truncatedRetries++;
        console.warn(`[chat-agent-loop] ${providerLabel} stream ended with no finish_reason and no forced tool call — retrying hop (${truncatedRetries}/${MAX_TRUNCATED_STREAM_RETRIES})`);
        hop--;
        continue;
      }
      stripper.flush();
      return {
        ok: false,
        hadText,
        toolCalls: allToolCalls,
        reason: 'forced_tool_incomplete',
        errorMessage: `${providerLabel} stream truncated ${MAX_TRUNCATED_STREAM_RETRIES + 1}x before the forced tool call completed`,
      };
    }

    // Trust the accumulated tool_call deltas over finish_reason: when
    // tool_choice FORCES a function, OpenAI ends the stream with
    // finish_reason "stop" (not "tool_calls") even though a complete tool
    // call was emitted — gating on finish_reason alone silently dropped
    // every forced call (image gen came back "tools=0, hadText=false").
    if (pendingCalls.size === 0) {
      stripper.flush();
      if (
        shouldContinueIncompleteResearch({
          continueIncompleteResearch,
          researchContinues,
          accumulatedText: accumulatedAssistantText,
          pendingToolCalls: false,
        })
      ) {
        researchContinues++;
        console.warn(
          `[chat-agent-loop] ${providerLabel} research report incomplete ` +
            `(finish=${finishReason || 'none'}, continues=${researchContinues}/${MAX_RESEARCH_CONTINUES}) — continuing`,
        );
        try { onStatus?.('Finishing the report…'); } catch { /* swallow */ }
        if (hopText) messages.push({ role: 'assistant', content: hopText });
        messages.push({ role: 'user', content: RESEARCH_CONTINUE_PROMPT });
        continue;
      }
      return {
        ok: true,
        hadText,
        toolCalls: allToolCalls,
        reason: isLengthStopReason(finishReason) ? 'length' : 'stop',
        errorMessage: null,
      };
    }

    // Build the assistant turn EXACTLY as OpenAI / Grok expect it.
    const assistantCalls = [];
    for (const [, acc] of [...pendingCalls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!acc.id || !acc.name) continue;
      assistantCalls.push({
        id: acc.id,
        type: 'function',
        function: { name: acc.name, arguments: acc.argsBuf || '{}' },
      });
    }
    if (assistantCalls.length === 0) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: 'malformed tool_call deltas' };
    }

    messages.push({ role: 'assistant', content: null, tool_calls: assistantCalls });

    try {
      const firstName = assistantCalls[0]?.function?.name || '';
      onStatus?.(
        ARG_STREAM_START_LINES[firstName]
          ? (ARG_PROGRESS_VERBS[firstName] ? `${ARG_PROGRESS_VERBS[firstName]}…` : ARG_STREAM_START_LINES[firstName])
          : 'Running tools…',
      );
    } catch { /* swallow */ }

    const resolved = assistantCalls.map((c) => ({
      id: c.id,
      name: c.function.name,
      args: safeJsonParse(c.function.arguments),
    }));
    const results = await runToolBatch(resolved, ctx, record, chatToolNames, onActivity, toolCallsPerHop);
    for (const r of results) {
      messages.push({
        role: 'tool',
        tool_call_id: r.id,
        content: serialiseToolResult(r.payload),
      });
      if (
        forceToolName &&
        r.name === forceToolName &&
        !r.isError &&
        r.payload?.ok !== false
      ) {
        forcedToolDone = true;
      }
    }
    if (editingArtifact && artifactShippedFromResults(results)) {
      artifactDelivered = true;
    }
  }

  stripper.flush();
  return {
    ok: false,
    hadText,
    toolCalls: allToolCalls,
    reason: 'hop_cap',
    errorMessage: `Tool loop exceeded ${effectiveHopLimit} hops`,
  };
}

// ===========================================================================
// Anthropic Claude agent loop
// ===========================================================================
// Anthropic Messages API:
//   request:  { model, system, messages, tools, stream: true }
//   response stream events:
//     message_start
//     content_block_start  { content_block: { type, ... } }
//     content_block_delta  { delta: { type: 'text_delta'|'input_json_delta', ... } }
//     content_block_stop
//     message_delta        { delta: { stop_reason } }
//     message_stop
//
// `tool_use` content blocks arrive as content_block_start with
// { type: 'tool_use', id, name, input: {} }, followed by
// content_block_delta with { type: 'input_json_delta', partial_json: '...' }
// that we concatenate per block index to build the arguments JSON.
//
// stop_reason === 'tool_use' is the agent-loop signal.

async function runAnthropicLoop({
  apiKey,
  model,
  systemPrompt,
  userContent,                  // string OR Anthropic content-parts array (text + image blocks)
  priorTurns = [],
  maxOutputTokens,
  ctx,
  signal,
  onTextChunk,
  onToolCall,
  onStatus,
  onActivity,                   // fires on every raw upstream chunk (stall-watchdog keepalive)
  chatToolNames,
  forceToolName,                // when set, force this tool on the first hop
  maxHops,
  codingMode,
  continueIncompleteResearch = false,
}) {
  if (!apiKey) {
    return { ok: false, hadText: false, toolCalls: [], reason: 'error', errorMessage: 'ANTHROPIC_API_KEY missing' };
  }
  const tools = buildAnthropicTools(chatToolNames);
  if (!tools) {
    return { ok: false, hadText: false, toolCalls: [], reason: 'error', errorMessage: 'no_chat_tools_whitelisted' };
  }
  const editingArtifact = isEditArtifactTurn(ctx);
  const hopLimit = resolveMaxHops({ maxHops, codingMode, editingArtifact });
  const toolCallsPerHop = resolveMaxToolCallsPerHop({ codingMode, editingArtifact });
  const effectiveHopLimit = continueIncompleteResearch
    ? hopLimit + MAX_RESEARCH_CONTINUES
    : hopLimit;

  // Anthropic messages — `system` is top-level, NOT a message turn. Build
  // the user-content blob (string or array of text/image blocks).
  const messages = [];
  for (const t of buildPriorTurns(priorTurns)) messages.push({ role: t.role, content: t.content });
  messages.push({ role: 'user', content: userContent });

  const allToolCalls = [];
  const record = makeToolCallRecorder(onToolCall, allToolCalls);
  const stripper = makeToolSyntaxStripper(onTextChunk);
  let hadText = false;
  // Same redo-guard as the OpenAI loop: after the forced tool succeeds,
  // tool_choice 'none' forces the final text reply instead of letting the
  // model rebuild the (potentially huge) artifact again.
  let forcedToolDone = false;
  let artifactDelivered = false;
  let researchContinues = 0;
  let accumulatedAssistantText = '';

  for (let hop = 0; hop < effectiveHopLimit; hop++) {
    if (signal?.aborted) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: 'aborted' };
    }

    let res;
    try {
      const forceThisHop = hop === 0 && forceToolName;
      const toolsLocked = forcedToolDone || artifactDelivered || researchContinues > 0;
      const body = {
        model,
        messages,
        tools,
        max_tokens: maxOutputTokens,
        stream: true,
        ...(forceThisHop
          ? { tool_choice: { type: 'tool', name: forceToolName } }
          : (toolsLocked ? { tool_choice: { type: 'none' } } : {})),
      };
      if (systemPrompt) {
        // Cache the system block — Anthropic charges 25% extra on the
        // first call but every subsequent in-conversation call reuses
        // the cached block for free, which dominates the cost on a
        // tool-heavy multi-hop turn.
        body.system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
      }
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: err?.message || String(err) };
    }

    if (!res.ok) {
      let errBody;
      try { errBody = await res.json(); } catch { errBody = null; }
      const msg = errBody?.error?.message || res.statusText || `anthropic ${res.status}`;
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: msg };
    }

    // Build up the full assistant content array as the stream arrives.
    // Anthropic requires the assistant turn append to be the EXACT shape
    // it produced — text + tool_use blocks in order — so we accumulate
    // a faithful copy here.
    //
    // contentBlocks[index] = { type: 'text', text: '...' } OR
    //                        { type: 'tool_use', id, name, input: ... , _argsBuf: '...' }
    const contentBlocks = [];
    let stopReason = '';
    const narrate = makeToolArgNarrator(onStatus);

    try {
      await readSseStream(res.body, (payload) => {
        const evt = safeJsonParse(payload);
        const type = evt?.type;
        if (!type) return;

        if (type === 'content_block_start') {
          const idx = evt.index;
          const blk = evt.content_block || {};
          if (blk.type === 'text') {
            contentBlocks[idx] = { type: 'text', text: blk.text || '' };
          } else if (blk.type === 'tool_use') {
            contentBlocks[idx] = {
              type: 'tool_use',
              id: blk.id,
              name: blk.name,
              input: blk.input || {},
              _argsBuf: '',
            };
            narrate(blk.name, '');
          } else {
            contentBlocks[idx] = { type: blk.type || 'unknown' };
          }
          return;
        }

        if (type === 'content_block_delta') {
          const idx = evt.index;
          const d = evt.delta || {};
          const blk = contentBlocks[idx];
          if (!blk) return;
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            hadText = true;
            blk.text = (blk.text || '') + d.text;
            stripper.ingest(d.text);
          } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            blk._argsBuf = (blk._argsBuf || '') + d.partial_json;
            if (blk.type === 'tool_use') narrate(blk.name, blk._argsBuf);
          }
          return;
        }

        if (type === 'message_delta') {
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
          return;
        }

        if (type === 'message_stop') {
          // nothing — readSseStream resolves on `end`
          return;
        }
      }, onActivity);
    } catch (err) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: err?.message || String(err) };
    }

    // Materialise the assistant turn for the messages array, finalising
    // the input JSON for each tool_use block.
    const assistantContent = [];
    const toolCallsThisHop = [];
    let hopText = '';
    for (const blk of contentBlocks) {
      if (!blk) continue;
      if (blk.type === 'text') {
        if (blk.text) {
          hopText += blk.text;
          assistantContent.push({ type: 'text', text: blk.text });
        }
      } else if (blk.type === 'tool_use') {
        const input = blk._argsBuf ? safeJsonParse(blk._argsBuf) : (blk.input || {});
        assistantContent.push({ type: 'tool_use', id: blk.id, name: blk.name, input });
        toolCallsThisHop.push({ id: blk.id, name: blk.name, args: input });
      }
    }
    if (hopText) accumulatedAssistantText += hopText;

    if (stopReason !== 'tool_use' || toolCallsThisHop.length === 0) {
      stripper.flush();
      if (
        shouldContinueIncompleteResearch({
          continueIncompleteResearch,
          researchContinues,
          accumulatedText: accumulatedAssistantText,
          pendingToolCalls: false,
        })
      ) {
        researchContinues++;
        console.warn(
          `[chat-agent-loop] anthropic research report incomplete ` +
            `(stop=${stopReason || 'none'}, continues=${researchContinues}/${MAX_RESEARCH_CONTINUES}) — continuing`,
        );
        try { onStatus?.('Finishing the report…'); } catch { /* swallow */ }
        if (assistantContent.length) messages.push({ role: 'assistant', content: assistantContent });
        else if (hopText) messages.push({ role: 'assistant', content: hopText });
        messages.push({ role: 'user', content: RESEARCH_CONTINUE_PROMPT });
        continue;
      }
      return {
        ok: true,
        hadText,
        toolCalls: allToolCalls,
        reason: isLengthStopReason(stopReason) ? 'length' : 'stop',
        errorMessage: null,
      };
    }

    messages.push({ role: 'assistant', content: assistantContent });

    try {
      const firstName = toolCallsThisHop[0]?.name || '';
      onStatus?.(
        ARG_STREAM_START_LINES[firstName]
          ? (ARG_PROGRESS_VERBS[firstName] ? `${ARG_PROGRESS_VERBS[firstName]}…` : ARG_STREAM_START_LINES[firstName])
          : 'Running tools…',
      );
    } catch { /* swallow */ }

    const results = await runToolBatch(toolCallsThisHop, ctx, record, chatToolNames, onActivity, toolCallsPerHop);
    for (const r of results) {
      if (forceToolName && r.name === forceToolName && !r.isError && r.payload?.ok !== false) {
        forcedToolDone = true;
      }
    }
    if (editingArtifact && artifactShippedFromResults(results)) {
      artifactDelivered = true;
    }
    // Anthropic expects tool_result blocks wrapped as a SINGLE user
    // turn whose content is the array of tool_result blocks (one per
    // tool_use id from the assistant turn). Order doesn't matter as
    // long as every id is matched.
    const resultBlocks = results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: serialiseToolResult(r.payload),
      is_error: Boolean(r.isError),
    }));
    messages.push({ role: 'user', content: resultBlocks });
  }

  stripper.flush();
  return {
    ok: false,
    hadText,
    toolCalls: allToolCalls,
    reason: 'hop_cap',
    errorMessage: `Tool loop exceeded ${effectiveHopLimit} hops`,
  };
}

// ===========================================================================
// Google Gemini agent loop
// ===========================================================================
// Gemini streamGenerateContent:
//   request:
//     contents:       [{ role: 'user'|'model', parts: [{ text }|{ functionCall }|{ functionResponse }] }]
//     systemInstruction: { parts: [{ text }] }
//     tools:          [{ functionDeclarations: [...] }]
//
//   response (per SSE chunk):
//     candidates: [{ content: { parts: [{ text }|{ functionCall: { name, args } }] }, finishReason }]
//
// Gemini does NOT have streaming function-call deltas like OpenAI's
// character-by-character JSON — when it emits a functionCall it emits
// the whole part at once (potentially in a later chunk after some text).
// We accumulate every part across chunks, then on stream end:
//   • if any part has functionCall → that's the agent-loop signal
//   • else → done with the final text reply
//
// We also have to handle `thought: true` parts (Gemini 2.5+ thinking
// mode emits intermediate-reasoning parts that we drop — same as in
// server.js).

async function runGeminiLoop({
  apiKey,
  model,                        // resolved Gemini model id (e.g. gemini-flash-latest)
  systemPrompt,
  userContent,                  // string OR Gemini parts array (text + inline_data for images)
  priorTurns = [],
  maxOutputTokens,
  ctx,
  signal,
  onTextChunk,
  onToolCall,
  onStatus,
  onActivity,                   // fires on every raw upstream chunk (stall-watchdog keepalive)
  chatToolNames,
  forceToolName,                // when set, force this tool on the first hop
  maxHops,
  codingMode,
  continueIncompleteResearch = false,
}) {
  if (!apiKey) {
    return { ok: false, hadText: false, toolCalls: [], reason: 'error', errorMessage: 'GOOGLE_API_KEY missing' };
  }
  const tools = buildGeminiTools(chatToolNames);
  if (!tools) {
    return { ok: false, hadText: false, toolCalls: [], reason: 'error', errorMessage: 'no_chat_tools_whitelisted' };
  }
  const editingArtifact = isEditArtifactTurn(ctx);
  const hopLimit = resolveMaxHops({ maxHops, codingMode, editingArtifact });
  const toolCallsPerHop = resolveMaxToolCallsPerHop({ codingMode, editingArtifact });
  const effectiveHopLimit = continueIncompleteResearch
    ? hopLimit + MAX_RESEARCH_CONTINUES
    : hopLimit;

  // Build the contents array. Gemini uses role 'model' (not 'assistant')
  // and wraps text in { parts: [{ text }] }.
  const contents = [];
  for (const t of buildPriorTurns(priorTurns)) {
    contents.push({
      role: t.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: t.content }],
    });
  }
  // userContent can already be an array of parts (multimodal) — preserve.
  const userParts = Array.isArray(userContent)
    ? userContent
    : [{ text: String(userContent || '') }];
  contents.push({ role: 'user', parts: userParts });

  const allToolCalls = [];
  const record = makeToolCallRecorder(onToolCall, allToolCalls);
  const stripper = makeToolSyntaxStripper(onTextChunk);
  let hadText = false;
  // Same redo-guard as the OpenAI loop: after the forced tool succeeds,
  // functionCallingConfig NONE forces the final text reply instead of
  // letting the model rebuild the (potentially huge) artifact again.
  let forcedToolDone = false;
  let artifactDelivered = false;
  let researchContinues = 0;
  let accumulatedAssistantText = '';

  for (let hop = 0; hop < effectiveHopLimit; hop++) {
    if (signal?.aborted) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: 'aborted' };
    }

    let res;
    try {
      const forceThisHop = hop === 0 && forceToolName;
      const toolsLocked = forcedToolDone || artifactDelivered || researchContinues > 0;
      const body = {
        contents,
        tools,
        generationConfig: {
          maxOutputTokens,
          temperature: 0.7,
        },
        ...(forceThisHop
          ? { toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [forceToolName] } } }
          : (toolsLocked
              ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } }
              : {})),
      };
      if (systemPrompt) {
        body.systemInstruction = { parts: [{ text: systemPrompt }] };
      }
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${apiKey}`;
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: err?.message || String(err) };
    }

    if (!res.ok) {
      let errBody;
      try { errBody = await res.json(); } catch { errBody = null; }
      const msg = errBody?.error?.message || res.statusText || `gemini ${res.status}`;
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: msg };
    }

    // Accumulate every model-emitted part across chunks. Text parts get
    // streamed to the client live; functionCall parts collect into the
    // assistant turn for the next hop.
    const assistantParts = [];      // parts to echo back in `contents` for the next request
    const toolCallsThisHop = [];    // calls to execute at end-of-stream
    const seenCallKeys = new Set(); // Gemini can re-emit the SAME functionCall across chunks
    // Gemini delivers functionCall args whole (no delta stream), so this
    // only fires the opening "Designing…" beat when the call lands.
    const narrate = makeToolArgNarrator(onStatus);
    let finishReason = '';
    let hopText = '';

    try {
      await readGeminiSseStream(res.body, (parsed) => {
        const cand = parsed?.candidates?.[0];
        if (!cand) return;
        if (cand.finishReason) finishReason = cand.finishReason;
        const parts = cand?.content?.parts;
        if (!Array.isArray(parts)) return;
        for (const part of parts) {
          if (part?.thought === true) continue; // drop thinking-mode reasoning
          if (typeof part?.text === 'string') {
            if (part.text) {
              hadText = true;
              hopText += part.text;
              stripper.ingest(part.text);
              assistantParts.push({ text: part.text });
            }
            continue;
          }
          if (part?.functionCall && typeof part.functionCall === 'object') {
            const fc = part.functionCall;
            // Gemini sometimes streams the identical functionCall part in
            // several SSE chunks (observed 4x on big forced builds). Execute
            // — and echo back — each unique call only once, or an expensive
            // builder runs repeatedly and the echoed turn confuses hop 2.
            const key = `${fc.name}:${JSON.stringify(fc.args || {})}`;
            if (seenCallKeys.has(key)) continue;
            seenCallKeys.add(key);
            narrate(fc.name, '');
            const id = fc.id || `fc_${hop}_${toolCallsThisHop.length}`;
            const args = fc.args && typeof fc.args === 'object' ? fc.args : {};
            assistantParts.push({
              functionCall: { name: fc.name, args, ...(fc.id ? { id: fc.id } : {}) },
              // Gemini 3.x REQUIRES the thought signature to be echoed back
              // on the functionCall part — omitting it 400s the next hop.
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            });
            toolCallsThisHop.push({ id, name: fc.name, args });
            continue;
          }
        }
      }, onActivity);
    } catch (err) {
      stripper.flush();
      return { ok: false, hadText, toolCalls: allToolCalls, reason: 'error', errorMessage: err?.message || String(err) };
    }

    if (hopText) accumulatedAssistantText += hopText;

    if (toolCallsThisHop.length === 0) {
      stripper.flush();
      if (
        shouldContinueIncompleteResearch({
          continueIncompleteResearch,
          researchContinues,
          accumulatedText: accumulatedAssistantText,
          pendingToolCalls: false,
        })
      ) {
        researchContinues++;
        console.warn(
          `[chat-agent-loop] gemini research report incomplete ` +
            `(finish=${finishReason || 'none'}, continues=${researchContinues}/${MAX_RESEARCH_CONTINUES}) — continuing`,
        );
        try { onStatus?.('Finishing the report…'); } catch { /* swallow */ }
        if (assistantParts.length) contents.push({ role: 'model', parts: assistantParts });
        contents.push({ role: 'user', parts: [{ text: RESEARCH_CONTINUE_PROMPT }] });
        continue;
      }
      return {
        ok: true,
        hadText,
        toolCalls: allToolCalls,
        reason: isLengthStopReason(finishReason) ? 'length' : 'stop',
        errorMessage: null,
      };
    }

    // Push the assistant turn EXACTLY as Gemini produced it (text +
    // functionCall parts, in order).
    contents.push({ role: 'model', parts: assistantParts });

    try {
      const firstName = toolCallsThisHop[0]?.name || '';
      onStatus?.(
        ARG_STREAM_START_LINES[firstName]
          ? (ARG_PROGRESS_VERBS[firstName] ? `${ARG_PROGRESS_VERBS[firstName]}…` : ARG_STREAM_START_LINES[firstName])
          : 'Running tools…',
      );
    } catch { /* swallow */ }

    const results = await runToolBatch(toolCallsThisHop, ctx, record, chatToolNames, onActivity, toolCallsPerHop);
    for (const r of results) {
      if (forceToolName && r.name === forceToolName && !r.isError && r.payload?.ok !== false) {
        forcedToolDone = true;
      }
    }
    if (editingArtifact && artifactShippedFromResults(results)) {
      artifactDelivered = true;
    }

    // Gemini wants functionResponse parts in a NEW user turn. Each
    // functionResponse mirrors a prior functionCall by `name` (and id
    // if we set one). `response` is a free-form object — we wrap the
    // tool payload in `{ payload }` so the model never accidentally
    // collides with a reserved key.
    const responseParts = results.map((r) => ({
      functionResponse: {
        name: r.name,
        response: {
          ok: !r.isError,
          payload: r.payload,
        },
      },
    }));
    contents.push({ role: 'user', parts: responseParts });
  }

  stripper.flush();
  return {
    ok: false,
    hadText,
    toolCalls: allToolCalls,
    reason: 'hop_cap',
    errorMessage: `Tool loop exceeded ${effectiveHopLimit} hops`,
  };
}

// ===========================================================================
// Deterministic "show me what I saved" safety net
// ===========================================================================
// The #1 chat complaint: the user asks to SEE a saved item ("pull them in",
// "show me my porsche pics"), the model runs lykn_searchVault, narrates the
// hits, but never calls lykn_loadNeurons — so nothing actually renders in the
// chat (searchVault hits are snippets; only loadNeuron(s) produce the visible
// cards). Prompt guidance reduces this but can't guarantee it. This net runs
// AFTER the model's turn: if the user clearly wanted to view saved items and
// the model searched the vault but never loaded the results, we load the top
// hits ourselves and emit the tool_call events so the cards appear.

// Keep this small: auto-load is a repair for "model forgot to surface", not
// a dump of the whole search page. Six unrelated cards under a careful reply
// is worse than under-surfacing.
const AUTO_LOAD_MAX = 3;

// View verbs alone are NOT enough ("show me how X works", "I see", "bring
// it together"). Require an explicit saved/vault cue, or a short yes after
// the assistant offered to pull saved items up.
const VIEW_INTENT_RE =
  /\b(show|see|view|open|display|render|pull\s*(?:up|in)|bring\s*(?:up|in)|drop\s+in|load)\b/i;
const SAVED_CONTEXT_RE =
  /\b(?:vault|saved|artifact|artifacts|ai\s*drive|what\s+(?:have|did)\s+i\s+save|something\s+i\s+saved|what\s+i\s+saved)\b/i;
const VAULT_AFFIRMATION_RE =
  /^(?:\s*(?:yes|yep|yeah|yup|ya|sure|ok|okay|k|please|do\s*it|go(?:\s*ahead)?|go\s*for\s*it|sounds?\s*good|that\s*one|those|them|all\s*(?:of\s*)?(?:them|those))\b[\s.,!]*)+$/i;
const VAULT_SURFACE_OFFER_RE =
  /\b(pull\s*(?:them|those|it|up|in)|bring\s*(?:them|those|it|up|in)|show\s*(?:you|them|those|it)|want\s*me\s*to\s*(?:pull|show|bring|open|load)|i\s*(?:can|could)\s*(?:pull|show|bring)|in\s*(?:your\s*)?vault|saved\s*(?:note|notes|item|items|image|images|file|files))\b/i;

// When the model already listed hits and is WAITING for the user to pick
// ("let me know which…", "want me to pull any in?"), auto-loading the raw
// search page dumps unrelated vault cards under an otherwise-correct reply.
// Skip the repair; the next "yes / the porsche ones" turn still surfaces.
const ASSISTANT_DEFERRED_SURFACE_RE =
  /\b(?:let\s+me\s+know\s+if\s+you\s+(?:want|would)|(?:do\s+you\s+want|would\s+you\s+like)\s+me\s+to\s+(?:pull|bring|show|open|load)|want\s+me\s+to\s+(?:pull|bring|show|open|load)|if\s+you(?:'d|\s+would)?\s+like\s+(?:me\s+to\s+)?(?:pull|bring|show|open|load|see)|specify\s+which|which\s+one(?:s)?\s+you\s+(?:want|would|like)|just\s+(?:say|tell)\s+(?:the\s+word|me\s+which)|i\s+(?:can|could)\s+(?:pull|bring|show)\s+(?:them|those|it|any|one))\b/i;

// Words to strip when deriving a search topic from the user's message: the
// view verbs themselves plus pronouns / filler / vault-domain nouns that
// carry no topic signal. What's left should be the actual subject ("porsche").
const QUERY_STOPWORDS = new Set([
  // view verbs
  'show', 'see', 'view', 'open', 'display', 'render', 'pull', 'bring', 'drop',
  'load', 'pullup', 'bringin',
  // pronouns / determiners / filler
  'the', 'them', 'they', 'those', 'these', 'that', 'this', 'it', 'its', 'my',
  'mine', 'our', 'your', 'his', 'her', 'into', 'over', 'here', 'there', 'now',
  'all', 'any', 'some', 'please', 'can', 'could', 'would', 'will', 'you',
  'want', 'wanna', 'like', 'get', 'from', 'for', 'and', 'with', 'about', 'out',
  'have', 'has', 'had', 'are', 'was', 'were', 'plz', 'pls',
  // vault-domain nouns
  'vault', 'saved', 'save', 'note', 'notes', 'image', 'images', 'img', 'pic',
  'pics', 'picture', 'pictures', 'photo', 'photos', 'file', 'files', 'item',
  'items', 'thing', 'things', 'stuff', 'link', 'links', 'content',
]);

function extractUserText(userContent) {
  if (typeof userContent === 'string') return userContent;
  if (Array.isArray(userContent)) {
    return userContent
      .map((p) => (typeof p === 'string' ? p : (typeof p?.text === 'string' ? p.text : '')))
      .join(' ');
  }
  return '';
}

/** True only when the user asked to SEE saved vault items this turn. */
function userAskedToViewSavedItems(userText, priorTurns) {
  const t = String(userText || '').trim();
  if (!t) return false;
  if (VIEW_INTENT_RE.test(t) && SAVED_CONTEXT_RE.test(t)) return true;
  // "pull up my porsche pics from the vault" / "show my saved notes on X"
  if (
    /\b(?:show|see|open|pull|bring|display|load)\b.{0,48}\b(?:vault|saved|artifact|artifacts)\b/i.test(
      t,
    )
  ) {
    return true;
  }
  if (
    /\b(?:show|see|open|pull|bring|display|load)\b.{0,48}\b(?:my|the|that|those)\b.{0,24}\b(?:notes?|files?|pics?|pictures?|photos?|images?|docs?|links?|articles?)\b/i.test(
      t,
    ) &&
    /\b(?:vault|saved)\b/i.test(t)
  ) {
    return true;
  }
  if (VAULT_AFFIRMATION_RE.test(t) && Array.isArray(priorTurns)) {
    for (let i = priorTurns.length - 1; i >= 0; i--) {
      const m = priorTurns[i];
      if (m?.role !== 'assistant') continue;
      return VAULT_SURFACE_OFFER_RE.test(String(m.content || ''));
    }
  }
  return false;
}

// Reduce the user's message to its topic words so we can run a vault search
// when the model answered from injected context instead of calling the tool.
// Returns '' when nothing meaningful is left (e.g. a bare "pull them in").
function deriveVaultQuery(userText) {
  const tokens = String(userText || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 3 && !QUERY_STOPWORDS.has(t));
  return [...new Set(tokens)].join(' ').trim();
}

function collectVaultNodeIds(searchHits, into = [], seen = new Set()) {
  for (const h of searchHits || []) {
    const id = typeof h?.node_id === 'string' ? h.node_id : '';
    if (!id.startsWith('vault_') || seen.has(id)) continue;
    seen.add(id);
    into.push(id);
    if (into.length >= AUTO_LOAD_MAX) break;
  }
  return into;
}

function assistantDeferredVaultSurface(assistantText) {
  return ASSISTANT_DEFERRED_SURFACE_RE.test(String(assistantText || ''));
}

function userAskedForImages(userText) {
  return /\b(?:pics?|pictures?|photos?|images?|imgs?)\b/i.test(String(userText || ''));
}

/**
 * AI-authored "I noted that you wanted X saved" rollups. Search ranks these
 * highly on the topic word, so the model loads them and claims it pulled the
 * real media — while the actual images never appear. Keep them out of
 * auto-load (and treat loading only these as a miss to repair).
 */
function isMetaVaultHit(hit) {
  const title = String(hit?.title || '').trim();
  const snippet = String(hit?.snippet || hit?.content || '').trim();
  if (/^saved items\s*:/i.test(title)) return true;
  if (/i have noted this as a saved item/i.test(snippet)) return true;
  if (/the user asked to save\b/i.test(snippet) && snippet.length < 800) return true;
  if (/\b(?:pulled|pulling)\s+(?:in|up)\b.{0,40}\b(?:vault|saved)\b/i.test(snippet) && snippet.length < 800) {
    return true;
  }
  return false;
}

/** true / false / null (unknown) — search hits don't carry a media type. */
function looksLikeImageHit(hit) {
  if (isMetaVaultHit(hit)) return false;
  const blob = `${hit?.title || ''} ${hit?.snippet || ''} ${hit?.source || ''}`.toLowerCase();
  if (
    /\b(image|photo|picture|png|jpe?g|webp|gif|heic|pexels|unsplash|generated image)\b/.test(blob)
    || /\.(png|jpe?g|webp|gif|heic)\b/.test(blob)
  ) {
    return true;
  }
  if (/\b(from:|subject:|replied to your post|mailto:)\b/.test(blob)) return false;
  return null;
}

function loadedVaultPayloads(calls) {
  const out = [];
  for (const c of calls || []) {
    if (c?.status !== 'done') continue;
    if (c.name === 'lykn_loadNeuron' && c.result?.ok && c.result?.kind === 'vault') {
      out.push(c.result);
      continue;
    }
    if (c.name === 'lykn_loadNeurons' && Array.isArray(c.result?.results)) {
      for (const r of c.result.results) {
        if (r?.ok && r?.kind === 'vault') out.push(r);
      }
    }
  }
  return out;
}

function vaultPayloadLooksLikeImage(payload) {
  const note = payload?.note || {};
  const title = String(note.title || '');
  const content = String(note.content || '');
  if (isMetaVaultHit({ title, snippet: content.slice(0, 500) })) return false;
  if (/\[ATTACHMENTS_JSON:/.test(content)) {
    if (/"type"\s*:\s*"(?:image|photo)"/i.test(content)) return true;
    if (/\.(png|jpe?g|webp|gif|heic)\b/i.test(content)) return true;
    if (/"mime"\s*:\s*"image\//i.test(content)) return true;
  }
  return looksLikeImageHit({ title, snippet: content.slice(0, 240) }) === true;
}

function vaultPayloadIsMeta(payload) {
  const note = payload?.note || {};
  return isMetaVaultHit({
    title: note.title,
    snippet: String(note.content || '').slice(0, 800),
  });
}

/**
 * True when the model already called loadNeuron(s) but what it brought in
 * still doesn't satisfy the user's ask (e.g. loaded a "Saved items: Porsche"
 * meta-note while they wanted the actual car photos).
 */
function needsVaultLoadRepair(calls, userText) {
  const loaded = loadedVaultPayloads(calls);
  if (loaded.length === 0) return true;
  if (loaded.every(vaultPayloadIsMeta)) return true;
  if (userAskedForImages(userText) && !loaded.some(vaultPayloadLooksLikeImage)) return true;
  return false;
}

/**
 * Pick which search hits to auto-load.
 *   1) Prefer hits whose titles the model already named in its reply.
 *   2) For pic/image asks, drop clear non-images (emails, etc.).
 *   3) Cap at `max`.
 */
function selectAutoLoadHits(hits, { assistantText = '', userText = '', max = AUTO_LOAD_MAX } = {}) {
  const list = Array.isArray(hits)
    ? hits.filter(
        (h) =>
          typeof h?.node_id === 'string' &&
          h.node_id.startsWith('vault_') &&
          !isMetaVaultHit(h),
      )
    : [];
  if (!list.length) return [];

  const text = String(assistantText || '').toLowerCase();
  const mentioned = [];
  const rest = [];
  for (const h of list) {
    const title = String(h?.title || '').trim();
    if (!title) {
      rest.push(h);
      continue;
    }
    // Models usually echo the vault title (or a long filename prefix) when
    // narrating hits. Match a stable prefix so we only auto-load what they
    // actually talked about — not the rest of a noisy search page.
    // Skip meta titles even if the model narrated them ("Saved items: X").
    if (isMetaVaultHit(h)) continue;
    const needle = title.toLowerCase().slice(0, Math.min(title.length, 48));
    if (needle.length >= 6 && text.includes(needle)) mentioned.push(h);
    else rest.push(h);
  }

  let pool = mentioned.length > 0 ? mentioned : rest;

  if (userAskedForImages(userText)) {
    const images = pool.filter((h) => looksLikeImageHit(h) === true);
    const unknown = pool.filter((h) => looksLikeImageHit(h) == null);
    // Prefer real image hits. Meta / email / plain-text rollups are never
    // good enough when the user asked for pics.
    if (images.length > 0) {
      pool = [...images, ...unknown];
    } else if (mentioned.length > 0) {
      pool = pool.filter((h) => looksLikeImageHit(h) !== false);
    } else {
      pool = unknown.length ? unknown : pool;
    }
  }

  return pool.slice(0, Math.max(1, max));
}

/**
 * Make "show me / pull in my saved X" actually render the items as cards,
 * deterministically — independent of whether the model remembered to call
 * the tools. Runs AFTER the model's turn when:
 *   • the user expressed a view intent, AND
 *   • the model did NOT already loadNeuron(s) this turn — OR it loaded
 *     only meta / non-image junk while the user asked for real media.
 *
 * Node_ids come from (1) a searchVault the model ran this turn, or — when the
 * model answered straight from the injected vault dossier without searching —
 * (2) a search we run ourselves on the topic in the user's message. Then we
 * loadNeurons the top hits and emit the tool_call events so the cards appear.
 * Mutates `result.toolCalls`. Best-effort: failures are swallowed.
 */
async function autoLoadVaultNeuronsIfMissed(opts, result, assistantText = '') {
  if (!result || result.reason !== 'stop') return; // only on a clean finish
  if (!opts?.ctx?.userId) return;

  const userText = extractUserText(opts.userContent);
  // Critical: do NOT fire on generic "show/see/pull" chat — only when the
  // user clearly wants saved Vault items on screen.
  if (!userAskedToViewSavedItems(userText, opts.priorTurns)) return;

  const calls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  // Model already loaded something — but it may have grabbed a meta "Saved
  // items: …" note (or other non-image) while claiming it pulled the photos.
  // Only skip repair when the load actually satisfies the ask.
  const mustRepair = needsVaultLoadRepair(calls, userText);
  const alreadyLoaded =
    calls.some((c) => c.name === 'lykn_loadNeurons' || c.name === 'lykn_loadNeuron');
  if (alreadyLoaded && !mustRepair) return;

  // Model offered "want me to pull any in?" with no (or only-correct) load —
  // wait for the user. Override only when it already loaded the WRONG thing
  // (meta note / zero images for a pics ask) and claimed success.
  if (assistantDeferredVaultSurface(assistantText) && !(alreadyLoaded && mustRepair)) return;

  const allowedToolNames = Array.isArray(opts.chatToolNames) ? opts.chatToolNames : null;
  // If loadNeurons isn't reachable for this model (custom agent with a
  // narrowed tool set), skip rather than emit a misleading error card.
  if (allowedToolNames && !allowedToolNames.includes('lykn_loadNeurons')) return;
  const toolOpts = allowedToolNames ? { allowedToolNames } : {};

  // 1) Prefer hits from a searchVault the model already ran this turn, then
  //    narrow to titles it narrated (or image-like hits for pic asks).
  const rawHits = [];
  const seenHit = new Set();
  for (const c of calls) {
    if (c.name !== 'lykn_searchVault' || c.status !== 'done') continue;
    for (const h of c.result?.hits || []) {
      const id = typeof h?.node_id === 'string' ? h.node_id : '';
      if (!id.startsWith('vault_') || seenHit.has(id)) continue;
      seenHit.add(id);
      rawHits.push(h);
    }
  }

  // 2) The model answered from the injected vault dossier without searching.
  //    Run our own search on the topic in the user's message so the cards
  //    still render. Skip if there's no searchable topic (bare anaphora like
  //    "pull them in" — the prompt guidance handles re-search in that case).
  if (rawHits.length === 0) {
    if (allowedToolNames && !allowedToolNames.includes('lykn_searchVault')) return;
    const query = deriveVaultQuery(userText);
    if (!query) return;
    const sv = await runChatTool(
      'lykn_searchVault',
      { query, limit: Math.max(AUTO_LOAD_MAX, 8) },
      opts.ctx,
      toolOpts,
    );
    for (const h of sv?.payload?.hits || []) {
      const id = typeof h?.node_id === 'string' ? h.node_id : '';
      if (!id.startsWith('vault_') || seenHit.has(id)) continue;
      seenHit.add(id);
      rawHits.push(h);
    }
  }

  const selected = selectAutoLoadHits(rawHits, {
    assistantText,
    userText,
    max: AUTO_LOAD_MAX,
  });
  // Don't re-load node_ids the model already hydrated this turn.
  const alreadyIds = new Set(
    loadedVaultPayloads(calls)
      .map((p) => (typeof p?.node_id === 'string' ? p.node_id : ''))
      .filter(Boolean),
  );
  const nodeIds = [];
  collectVaultNodeIds(
    selected.filter((h) => !alreadyIds.has(h.node_id)),
    nodeIds,
  );

  if (nodeIds.length === 0) return;

  const id = `auto_load_${Date.now()}`;
  const args = { node_ids: nodeIds };
  const emit = (evt) => { try { opts.onToolCall?.(evt); } catch { /* swallow */ } };

  emit({ id, name: 'lykn_loadNeurons', args, status: 'running' });
  const { payload, isError, latencyMs } = await runChatTool(
    'lykn_loadNeurons',
    args,
    opts.ctx,
    toolOpts,
  );
  emit({
    id,
    name: 'lykn_loadNeurons',
    args,
    status: isError ? 'error' : 'done',
    result: payload,
    latencyMs,
  });
  calls.push({
    id,
    name: 'lykn_loadNeurons',
    args,
    status: isError ? 'error' : 'done',
    result: payload,
    error: isError ? (payload?.error || 'auto-load failed') : undefined,
    latencyMs,
  });
  result.toolCalls = calls;
}

// ===========================================================================
// Dispatcher
// ===========================================================================
/**
 * Run the in-app chat agent loop for one user turn. Dispatches on
 * `provider` to the right per-provider implementation.
 *
 *   await runAgentLoop({
 *     provider,               // 'openai' | 'grok' | 'anthropic' | 'gemini'
 *     model,                  // provider-correct model id
 *     systemPrompt,           // string (may be '')
 *     userContent,            // string OR provider-native multimodal parts
 *     priorTurns,             // [{ role: 'user'|'assistant', content }]
 *     maxOutputTokens,        // per-hop cap
 *     promptCacheKey,         // OpenAI only
 *     env,                    // { OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY, XAI_API_KEY }
 *     ctx,                    // buildChatToolCtx(req)
 *     signal,                 // optional AbortSignal
 *     onTextChunk,            // (text) => void
 *     onToolCall,             // (event) => void   running → done | error
 *     onStatus,               // (status) => void  optional human status
 *   });
 *
 * Returns:
 *   { ok, hadText, toolCalls, reason, errorMessage }
 */
export async function runAgentLoop(opts) {
  const provider = String(opts?.provider || '').toLowerCase();
  // Capture the streamed assistant prose so the vault auto-load net can
  // tell "model forgot to surface" apart from "model listed hits and is
  // waiting for the user to pick which ones".
  let assistantText = '';
  const origOnTextChunk = opts?.onTextChunk;
  const optsWithCapture = {
    ...opts,
    onTextChunk: (chunk) => {
      if (typeof chunk === 'string' && chunk) assistantText += chunk;
      try {
        return origOnTextChunk?.(chunk);
      } catch {
        /* swallow — same contract as emitNormalized */
      }
    },
  };

  let result;
  switch (provider) {
    case 'openai':
      result = await runOpenAiCompatLoop({
        ...optsWithCapture,
        apiKey: opts.env?.OPENAI_API_KEY,
        baseUrl: 'https://api.openai.com/v1',
        providerLabel: 'openai',
      });
      break;
    case 'grok':
      result = await runOpenAiCompatLoop({
        ...optsWithCapture,
        apiKey: opts.env?.XAI_API_KEY,
        baseUrl: 'https://api.x.ai/v1',
        providerLabel: 'grok',
      });
      break;
    case 'anthropic':
      result = await runAnthropicLoop({
        ...optsWithCapture,
        apiKey: opts.env?.ANTHROPIC_API_KEY,
      });
      break;
    case 'gemini':
      result = await runGeminiLoop({
        ...optsWithCapture,
        apiKey: opts.env?.GOOGLE_API_KEY,
      });
      break;
    default:
      return {
        ok: false,
        hadText: false,
        toolCalls: [],
        reason: 'error',
        errorMessage: `unsupported provider: ${provider}`,
      };
  }

  // Deterministic safety net: if the user asked to SEE saved items and the
  // model searched the vault but never loaded the hits into view, load them
  // now so the cards actually render in the chat. Runs before the caller
  // closes the SSE stream, so the emitted tool_call events reach the client.
  try {
    await autoLoadVaultNeuronsIfMissed(optsWithCapture, result, assistantText);
  } catch (err) {
    console.warn('[chat-agent-loop] auto-load vault neurons failed:', err?.message || err);
  }

  return result;
}

// Back-compat export — early version of /api/ai/stream used this name.
// Keep so an in-flight branch doesn't break if it imports it.
export const runOpenAiAgentLoop = (opts) => runAgentLoop({ ...opts, provider: 'openai' });
