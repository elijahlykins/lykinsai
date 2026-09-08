// Live build progress: forward the artifact source to the client WHILE the
// model is still writing it into its tool-call argument.
//
// Before this, a coded build was invisible until the tool call completed —
// the user got a status line and a byte counter for as long as it took, then
// the finished artifact appeared all at once. The bytes were already
// arriving; nothing was reading them.
//
// The provider streams tool arguments as raw JSON text, so mid-stream the
// buffer is a TRUNCATED JSON object:
//
//   {"title":"Habit Tracker","code":"import React, { useState } from \"re
//
// extractPartialStringField decodes as much of a string field as has
// arrived, escapes included, without waiting for valid JSON.

/**
 * Decode as much of `field`'s string value as the partial JSON buffer holds.
 * Returns '' when the field hasn't started yet.
 *
 * @param {string} buf   Partial JSON tool-call arguments.
 * @param {string} field Top-level string property to read.
 * @returns {string}
 */
export function extractPartialStringField(buf, field) {
  const src = String(buf || '');
  const key = `"${field}"`;
  const keyAt = src.indexOf(key);
  if (keyAt === -1) return '';

  // Walk past `"field"` , whitespace, `:`, whitespace, to the opening quote.
  let i = keyAt + key.length;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== ':') return '';
  i++;
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src[i] !== '"') return '';
  i++;

  const out = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') break; // closing quote — field complete
    if (ch !== '\\') {
      out.push(ch);
      i++;
      continue;
    }
    // Escape sequence; it may be cut in half at the buffer's edge.
    const next = src[i + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = src.slice(i + 2, i + 6);
      if (hex.length < 4) break; // truncated \uXXXX — stop cleanly
      out.push(String.fromCharCode(parseInt(hex, 16)));
      i += 6;
      continue;
    }
    const SIMPLE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    out.push(SIMPLE[next] !== undefined ? SIMPLE[next] : next);
    i += 2;
  }
  return out.join('');
}

/** Tool calls whose arguments carry artifact source worth streaming. */
const SOURCE_FIELD_BY_TOOL = Object.freeze({
  lykn_build_react_artifact: 'code',
  lykn_manage_file: 'content',
});

/**
 * Throttled emitter for partial artifact source.
 *
 * @param {object} opts
 * @param {(payload: object) => void} opts.send   SSE writer.
 * @param {number} [opts.throttleMs=350]          Minimum gap between frames.
 * @param {number} [opts.maxChars=200000]         Stop forwarding past this.
 * @returns {(name: string, argsBuf: string) => void}
 */
export function makeArtifactProgressEmitter({ send, throttleMs = 350, maxChars = 200000 } = {}) {
  if (typeof send !== 'function') return () => {};
  let lastAt = 0;
  let lastLen = -1;
  let title = '';

  return function emit(name, argsBuf = '') {
    const field = SOURCE_FIELD_BY_TOOL[name];
    if (!field) return;
    try {
      const buf = String(argsBuf || '');
      // `title` lands before `code` in practice, but never assume ordering.
      if (!title) title = extractPartialStringField(buf, 'title').slice(0, 120);

      const code = extractPartialStringField(buf, field);
      // An `edits` patch has no `code` field — nothing to preview.
      if (!code) return;
      if (code.length > maxChars) return;

      const now = Date.now();
      if (code.length === lastLen) return;      // no new bytes
      if (now - lastAt < throttleMs) return;    // too soon
      lastAt = now;
      lastLen = code.length;

      send({ artifact_progress: { tool: name, title, code, chars: code.length } });
    } catch {
      // Progress is cosmetic — it must never break a build.
    }
  };
}
