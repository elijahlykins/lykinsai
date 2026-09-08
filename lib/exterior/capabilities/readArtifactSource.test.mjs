import test from 'node:test';
import assert from 'node:assert/strict';

import { readArtifactSource } from './readArtifactSource.js';

const CODE = [
  'import React from "react";',
  '',
  'const SIZE = 8;',
  '',
  'function Cell({ value }) {',
  '  return <span className="p-2">{value}</span>;',
  '}',
  '',
  'export default function App() {',
  '  return <Cell value={SIZE} />;',
  '}',
].join('\n');

const singleFileCtx = { activeArtifactCode: CODE };
const projectCtx = {
  activeArtifactEntry: 'App.jsx',
  activeArtifactFiles: [
    { path: 'App.jsx', content: CODE },
    { path: 'components/Cell.jsx', content: 'export const Cell = () => null;\n' },
  ],
};

test('refuses when no artifact is open', async () => {
  const res = await readArtifactSource({}, {});
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_artifact_open');
});

test('find mode returns copyable source plus an occurrence count', async () => {
  const res = await readArtifactSource({ find: 'function Cell' }, singleFileCtx);
  assert.equal(res.ok, true);
  assert.equal(res.occurrences, 1);
  // The returned source is unnumbered so it can go straight into `find`.
  assert.ok(res.source.includes('function Cell({ value }) {'));
  assert.ok(!/^\s*\d+:/m.test(res.source));
});

test('find mode warns when the snippet is not unique', async () => {
  const res = await readArtifactSource({ find: 'value' }, singleFileCtx);
  assert.equal(res.ok, true);
  assert.ok(res.occurrences > 1);
  assert.match(res.usage_hint, /occurrence.*replace_all|replace_all/);
});

test('a missing snippet reports the miss instead of returning the wrong region', async () => {
  const res = await readArtifactSource({ find: 'function Nope' }, singleFileCtx);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'find_not_found');
});

test('range mode reads the requested lines and reports the file length', async () => {
  const res = await readArtifactSource({ start_line: 5, end_line: 7 }, singleFileCtx);
  assert.equal(res.ok, true);
  assert.equal(res.start_line, 5);
  assert.equal(res.end_line, 7);
  assert.equal(res.total_lines, CODE.split('\n').length);
  assert.equal(res.source, 'function Cell({ value }) {\n  return <span className="p-2">{value}</span>;\n}');
});

test('an out-of-range request clamps rather than erroring', async () => {
  const res = await readArtifactSource({ start_line: 900, end_line: 999 }, singleFileCtx);
  assert.equal(res.ok, true);
  assert.equal(res.end_line, res.total_lines);
});

test('multi-file projects read by path and default to the entry', async () => {
  const byPath = await readArtifactSource(
    { path: 'components/Cell.jsx', start_line: 1, end_line: 1 },
    projectCtx,
  );
  assert.equal(byPath.ok, true);
  assert.equal(byPath.source, 'export const Cell = () => null;');

  const defaulted = await readArtifactSource({ start_line: 1, end_line: 1 }, projectCtx);
  assert.equal(defaulted.path, 'App.jsx');

  const missing = await readArtifactSource({ path: 'nope.jsx' }, projectCtx);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'path_not_found');
});
