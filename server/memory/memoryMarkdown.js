// ============================================================================
// server/memory/memoryMarkdown.js — Markdown structure, patch ops, summaries
// ============================================================================
// The formatter of the memory core. Documents are small Markdown files with
// `## Section` headings and bullet facts. The model PROPOSES a patch; this
// module APPLIES it deterministically — the server stays authoritative and a
// malformed proposal fails closed instead of mangling the document.
//
// Patch contract (smallest reliable set):
//   { op: 'append_section',  section, text }  — add lines to a section,
//                                               creating the section if absent.
//   { op: 'update_section',  section, text }  — replace an EXISTING section body.
//   { op: 'replace_text',    find, replace }  — supersede one known statement
//                                               (contradiction handling: update,
//                                               don't accumulate).
//   { op: 'remove_text',     find }           — remove one known statement.
//   { op: 'remove_section',  section }        — remove a whole section.
//
// `find` must match EXACTLY ONCE — zero matches and ambiguous matches both
// fail, so a patch can never silently land somewhere unintended.

import { MEMORY_SUMMARY_MAX_CHARS, estimateMemoryTokens } from './memoryConfig.js';

export const MEMORY_PATCH_OPS = Object.freeze([
  'append_section',
  'update_section',
  'replace_text',
  'remove_text',
  'remove_section',
]);

/** Collapse 3+ blank lines and trailing whitespace; keep content intact. */
export function normalizeMemoryMarkdown(markdown) {
  return String(markdown || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
}

/**
 * Split a document into heading-delimited sections.
 * @param {string} markdown
 * @returns {Array<{ heading: string|null, level: number, start: number, end: number }>}
 *   Line-index ranges [start, end). A leading preamble (before any heading)
 *   appears as heading:null.
 */
export function splitMemorySections(markdown) {
  const lines = String(markdown || '').split('\n');
  /** @type {Array<{ heading: string|null, level: number, start: number, end: number }>} */
  const sections = [];
  let current = { heading: /** @type {string|null} */ (null), level: 0, start: 0, end: lines.length };
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    current.end = i;
    if (current.heading !== null || current.end > current.start) sections.push(current);
    current = { heading: m[2], level: m[1].length, start: i, end: lines.length };
  }
  sections.push(current);
  return sections.filter((s) => s.heading !== null || s.end > s.start);
}

function findSection(markdown, sectionName) {
  const want = String(sectionName || '').trim().toLowerCase();
  if (!want) return null;
  const sections = splitMemorySections(markdown);
  const hit = sections.find((s) => (s.heading || '').trim().toLowerCase() === want);
  return hit || null;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Apply one patch operation. Pure — returns new Markdown, never mutates.
 * @param {string} markdown current document body
 * @param {{ op: string, section?: string, text?: string, find?: string, replace?: string }} patch
 * @returns {{ ok: true, markdown: string } | { ok: false, error: string }}
 */
export function applyMemoryPatch(markdown, patch) {
  const doc = String(markdown || '');
  const op = patch && typeof patch === 'object' ? String(patch.op || '') : '';
  if (!MEMORY_PATCH_OPS.includes(op)) return { ok: false, error: 'unknown_patch_op' };

  if (op === 'append_section' || op === 'update_section') {
    const sectionName = String(patch.section || '').trim();
    const text = String(patch.text || '').trim();
    if (!sectionName) return { ok: false, error: 'section_required' };
    if (!text) return { ok: false, error: 'text_required' };
    const section = findSection(doc, sectionName);
    if (!section) {
      if (op === 'update_section') return { ok: false, error: 'section_not_found' };
      const base = doc.trim();
      const next = `${base ? `${base}\n\n` : ''}## ${sectionName}\n\n${text}\n`;
      return { ok: true, markdown: normalizeMemoryMarkdown(next) };
    }
    const lines = doc.split('\n');
    const head = lines.slice(0, op === 'update_section' ? section.start + 1 : section.end);
    const tail = lines.slice(section.end);
    const middle = op === 'update_section' ? ['', text] : [text];
    // Drop trailing blank lines inside the kept head so appended text sits
    // directly under the section content.
    while (head.length && head[head.length - 1].trim() === '') head.pop();
    const next = [...head, ...middle, tail.length ? '' : null, ...tail]
      .filter((l) => l !== null)
      .join('\n');
    return { ok: true, markdown: normalizeMemoryMarkdown(next) };
  }

  if (op === 'replace_text' || op === 'remove_text') {
    const find = String(patch.find || '');
    if (!find.trim()) return { ok: false, error: 'find_required' };
    const occurrences = countOccurrences(doc, find);
    if (occurrences === 0) return { ok: false, error: 'text_not_found' };
    if (occurrences > 1) return { ok: false, error: 'text_ambiguous' };
    const replacement = op === 'replace_text' ? String(patch.replace || '') : '';
    if (op === 'replace_text' && !replacement.trim()) {
      return { ok: false, error: 'replace_required' };
    }
    const next = doc.replace(find, replacement);
    return { ok: true, markdown: normalizeMemoryMarkdown(next) };
  }

  // remove_section
  const sectionName = String(patch.section || '').trim();
  if (!sectionName) return { ok: false, error: 'section_required' };
  const section = findSection(doc, sectionName);
  if (!section) return { ok: false, error: 'section_not_found' };
  const lines = doc.split('\n');
  const next = [...lines.slice(0, section.start), ...lines.slice(section.end)].join('\n');
  return { ok: true, markdown: normalizeMemoryMarkdown(next) };
}

/**
 * Deterministic compact summary — NO LLM. First real content line plus the
 * section map. Cheap enough to recompute on every write, which keeps the
 * registry from ever drifting out of sync with the document.
 * @param {string} markdown
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
export function deriveMemorySummary(markdown, { maxChars = MEMORY_SUMMARY_MAX_CHARS } = {}) {
  const doc = String(markdown || '');
  const lines = doc.split('\n');
  const firstContent = lines.find((l) => {
    const t = l.trim();
    return t && !t.startsWith('#');
  });
  const lead = String(firstContent || '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const headings = splitMemorySections(doc)
    .map((s) => s.heading)
    .filter(Boolean);
  const parts = [];
  if (lead) parts.push(lead);
  if (headings.length) parts.push(`Sections: ${headings.join(', ')}.`);
  const summary = parts.join(' ').trim();
  if (summary.length <= maxChars) return summary;
  return `${summary.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Truncate Markdown to a token budget on a line boundary, flagging truncation.
 * @param {string} markdown
 * @param {number} maxTokens
 * @returns {{ markdown: string, truncated: boolean, tokens: number }}
 */
export function clampMemoryMarkdownToTokens(markdown, maxTokens) {
  const doc = String(markdown || '');
  const tokens = estimateMemoryTokens(doc);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0 || tokens <= maxTokens) {
    return { markdown: doc, truncated: false, tokens };
  }
  const maxChars = maxTokens * 4;
  const cut = doc.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  const clamped = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return {
    markdown: `${clamped}\n\n[memory truncated — over token budget]`,
    truncated: true,
    tokens: estimateMemoryTokens(clamped),
  };
}
