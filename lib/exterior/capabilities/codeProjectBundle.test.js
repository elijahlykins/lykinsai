import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bundleCodeProject,
  applyProjectEdits,
  applyFileOps,
  normalizeProjectFiles,
  resolveProjectImport,
} from './codeProjectBundle.js';

test('bundleCodeProject resolves relative imports and default export', () => {
  const bundled = bundleCodeProject(
    [
      {
        path: 'App.jsx',
        content: `import Player from './game/Player.js';\nexport default function App(){ return <Player />; }\n`,
      },
      {
        path: 'game/Player.js',
        content: `export default function Player(){ return <div>P</div>; }\n`,
      },
    ],
    'App.jsx',
  );
  assert.equal(bundled.ok, true);
  assert.equal(bundled.entry, 'App.jsx');
  assert.equal(bundled.file_count, 2);
  assert.match(bundled.code, /__lyknRequire/);
  assert.match(bundled.code, /game\/Player\.js/);
});

test('bundleCodeProject fails on unresolved import', () => {
  const bundled = bundleCodeProject([
    {
      path: 'App.jsx',
      content: `import Missing from './nope.js';\nexport default function App(){ return null; }\n`,
    },
  ]);
  assert.equal(bundled.ok, false);
  assert.equal(bundled.error, 'unresolved_import');
});

test('resolveProjectImport finds .jsx without extension', () => {
  const files = new Map([
    ['App.jsx', ''],
    ['components/Hero.jsx', ''],
  ]);
  assert.equal(resolveProjectImport('App.jsx', './components/Hero', files), 'components/Hero.jsx');
});

test('applyProjectEdits patches a specific path', () => {
  const files = normalizeProjectFiles([
    { path: 'App.jsx', content: 'const X = 1;\nexport default function App(){ return X; }\n' },
    { path: 'lib/math.js', content: 'export const add = (a,b) => a+b;\n' },
  ]);
  const patched = applyProjectEdits(files.files, [
    { path: 'lib/math.js', find: 'a+b', replace: 'a + b' },
  ], 'App.jsx');
  assert.equal(patched.ok, true);
  assert.match(patched.files.get('lib/math.js'), /a \+ b/);
  assert.equal(patched.files.get('App.jsx'), files.files.get('App.jsx'));
});

test('applyFileOps write and delete', () => {
  const files = normalizeProjectFiles([
    { path: 'App.jsx', content: 'export default function App(){ return null; }\n' },
  ]);
  const written = applyFileOps(files.files, [
    { op: 'write', path: 'util.js', content: 'export const n = 1;\n' },
  ]);
  assert.equal(written.ok, true);
  assert.equal(written.files.has('util.js'), true);
  const deleted = applyFileOps(written.files, [{ op: 'delete', path: 'util.js' }]);
  assert.equal(deleted.ok, true);
  assert.equal(deleted.files.has('util.js'), false);
});
