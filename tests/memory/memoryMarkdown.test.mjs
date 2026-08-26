// Markdown patch ops + deterministic summaries — the server-authoritative formatter.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMemoryPatch,
  deriveMemorySummary,
  splitMemorySections,
  clampMemoryMarkdownToTokens,
  normalizeMemoryMarkdown,
} from '../../server/memory/memoryMarkdown.js';

const DOC = `# Preferences

- Prefers concise answers.

## Coding

- Prefers JavaScript.
- Uses two-space indentation.

## Writing

- Plain dash, never em dash.
`;

test('append_section adds to an existing section', () => {
  const out = applyMemoryPatch(DOC, { op: 'append_section', section: 'Coding', text: '- Prefers small PRs.' });
  assert.equal(out.ok, true);
  const coding = out.ok && out.markdown.split('## Writing')[0];
  assert.match(String(coding), /- Prefers small PRs\./);
  assert.match(String(coding), /- Uses two-space indentation\.\n- Prefers small PRs\./);
});

test('append_section creates a missing section at the end', () => {
  const out = applyMemoryPatch(DOC, { op: 'append_section', section: 'Tools', text: '- Uses Cursor.' });
  assert.equal(out.ok, true);
  assert.match(out.ok ? out.markdown : '', /## Tools\n\n- Uses Cursor\./);
});

test('update_section replaces an existing body and fails on a missing one', () => {
  const out = applyMemoryPatch(DOC, { op: 'update_section', section: 'Writing', text: '- Oxford commas always.' });
  assert.equal(out.ok, true);
  assert.ok(out.ok && !out.markdown.includes('Plain dash'));
  assert.match(out.ok ? out.markdown : '', /## Writing\n\n- Oxford commas always\./);

  const missing = applyMemoryPatch(DOC, { op: 'update_section', section: 'Nope', text: 'x' });
  assert.deepEqual(missing, { ok: false, error: 'section_not_found' });
});

test('replace_text supersedes a contradicted statement (update over accumulation)', () => {
  const out = applyMemoryPatch(DOC, {
    op: 'replace_text',
    find: '- Prefers JavaScript.',
    replace: '- Prefers TypeScript (switched from JavaScript).',
  });
  assert.equal(out.ok, true);
  assert.ok(out.ok && !out.markdown.includes('- Prefers JavaScript.'));
  assert.ok(out.ok && out.markdown.includes('Prefers TypeScript'));
});

test('replace_text fails on zero and on ambiguous matches', () => {
  assert.deepEqual(
    applyMemoryPatch(DOC, { op: 'replace_text', find: 'not present', replace: 'x' }),
    { ok: false, error: 'text_not_found' },
  );
  const ambiguous = `${DOC}\n- Prefers JavaScript.\n`;
  assert.deepEqual(
    applyMemoryPatch(ambiguous, { op: 'replace_text', find: '- Prefers JavaScript.', replace: 'x' }),
    { ok: false, error: 'text_ambiguous' },
  );
});

test('remove_text and remove_section drop known facts', () => {
  const t = applyMemoryPatch(DOC, { op: 'remove_text', find: '- Uses two-space indentation.\n' });
  assert.equal(t.ok, true);
  assert.ok(t.ok && !t.markdown.includes('two-space'));

  const s = applyMemoryPatch(DOC, { op: 'remove_section', section: 'Writing' });
  assert.equal(s.ok, true);
  assert.ok(s.ok && !s.markdown.includes('## Writing'));
  assert.ok(s.ok && !s.markdown.includes('em dash'));
  assert.ok(s.ok && s.markdown.includes('## Coding'));
});

test('malformed patches fail closed', () => {
  assert.equal(applyMemoryPatch(DOC, { op: 'exec', find: 'x' }).ok, false);
  assert.equal(applyMemoryPatch(DOC, null).ok, false);
  assert.equal(applyMemoryPatch(DOC, { op: 'append_section', section: '', text: 'x' }).ok, false);
  assert.equal(applyMemoryPatch(DOC, { op: 'append_section', section: 'Coding', text: '' }).ok, false);
  assert.equal(applyMemoryPatch(DOC, { op: 'replace_text', find: '   ', replace: 'x' }).ok, false);
  assert.equal(applyMemoryPatch(DOC, { op: 'replace_text', find: 'Coding', replace: '' }).ok, false);
});

test('sections parse with heading names and ranges', () => {
  const sections = splitMemorySections(DOC);
  const names = sections.map((s) => s.heading);
  assert.deepEqual(names, ['Preferences', 'Coding', 'Writing']);
});

test('summary is deterministic, compact, and much smaller than the body', () => {
  const summary = deriveMemorySummary(DOC);
  assert.ok(summary.includes('Prefers concise answers'));
  assert.ok(summary.includes('Sections: Preferences, Coding, Writing.'));
  assert.ok(summary.length < DOC.length);
  assert.ok(summary.length <= 600);
  const big = `- ${'fact '.repeat(500)}\n`;
  assert.ok(deriveMemorySummary(big).length <= 600);
});

test('token clamp truncates on a line boundary and flags it', () => {
  const long = Array.from({ length: 200 }, (_, i) => `- fact number ${i} about the user`).join('\n');
  const out = clampMemoryMarkdownToTokens(long, 100);
  assert.equal(out.truncated, true);
  assert.ok(out.tokens <= 100);
  assert.match(out.markdown, /\[memory truncated — over token budget\]$/);
  const small = clampMemoryMarkdownToTokens('- one fact', 100);
  assert.deepEqual([small.truncated, small.markdown], [false, '- one fact']);
});

test('normalization collapses blank runs and trailing whitespace', () => {
  assert.equal(normalizeMemoryMarkdown('a  \n\n\n\nb\r\nc   \n\n\n'), 'a\n\nb\nc\n');
});
