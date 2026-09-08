import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SOURCE_INLINE_LIMIT,
  buildReactSourceView,
  outlineSource,
} from './artifactSourceView.js';

const SMALL = [
  'import React, { useState } from "react";',
  '',
  'const THEME = { bg: "#111" };',
  '',
  'function Cell({ value }) {',
  '  return <span>{value}</span>;',
  '}',
  '',
  'export default function App() {',
  '  const [n, setN] = useState(0);',
  '  return <Cell value={n} />;',
  '}',
].join('\n');

function bigSource(chars) {
  const head = 'import React from "react";\n\nexport default function App() {\n';
  const filler = '  // pad pad pad pad pad pad pad pad pad pad pad pad pad\n';
  let body = '';
  while (head.length + body.length < chars) body += filler;
  return `${head}${body}  return null;\n}\n`;
}

test('a small artifact is inlined verbatim', () => {
  const view = buildReactSourceView({ code: SMALL });
  assert.equal(view.mode, 'inline');
  assert.equal(view.fileCount, 1);
  // Byte-for-byte: whatever the model copies into `find` must be real source.
  assert.ok(view.block.includes(SMALL));
  assert.ok(!view.block.includes('truncated'));
});

test('a large artifact switches to the structure map instead of truncating', () => {
  const src = bigSource(SOURCE_INLINE_LIMIT + 5000);
  const view = buildReactSourceView({ code: src });
  assert.equal(view.mode, 'outline');
  assert.ok(view.totalChars > SOURCE_INLINE_LIMIT);
  // The old path sliced at 60k with no marker; the new one says so and says
  // what to do about it.
  assert.match(view.block, /LARGE artifact/);
  assert.match(view.block, /lykn_read_artifact_source/);
  assert.match(view.block, /NOT part of the source/);
  // The full body is NOT inlined.
  assert.ok(!view.block.includes(src));
});

test('multi-file projects list every file in both views', () => {
  const files = [
    { path: 'App.jsx', content: SMALL },
    { path: 'components/Cell.jsx', content: SMALL },
  ];
  const view = buildReactSourceView({ files, entry: 'App.jsx' });
  assert.equal(view.mode, 'inline');
  assert.equal(view.fileCount, 2);
  assert.match(view.block, /\[entry\]/);
  assert.ok(view.block.includes('components/Cell.jsx'));

  const bigFiles = [
    { path: 'App.jsx', content: bigSource(SOURCE_INLINE_LIMIT) },
    { path: 'components/Cell.jsx', content: SMALL },
  ];
  const outlined = buildReactSourceView({ files: bigFiles, entry: 'App.jsx' });
  assert.equal(outlined.mode, 'outline');
  assert.ok(outlined.block.includes('App.jsx'));
  assert.ok(outlined.block.includes('components/Cell.jsx'));
});

test('the outline maps top-level declarations to line numbers', () => {
  const entries = outlineSource(SMALL);
  const byText = Object.fromEntries(entries.map((e) => [e.text, e.line]));
  assert.equal(byText['import React, { useState } from "react";'], 1);
  assert.equal(byText['const THEME = { bg: "#111" };'], 3);
  assert.equal(byText['function Cell({ value }) {'], 5);
  assert.equal(byText['export default function App() {'], 9);
  // Indented lines are not top-level structure.
  assert.ok(!entries.some((e) => e.text.startsWith('  ')));
});
