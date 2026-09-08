import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bundleCodeProject,
  applyProjectEdits,
  applyFileOps,
  locateEditTarget,
  normalizeProjectFiles,
  spliceEditSites,
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

test('locateEditTarget matches exactly and rejects ambiguity', () => {
  const src = 'const a = 1;\nconst b = 2;\nconst a = 1;\n';
  const unique = locateEditTarget(src, 'const b = 2;');
  assert.equal(unique.ok, true);
  assert.equal(unique.exact, true);
  assert.equal(unique.sites.length, 1);
  assert.equal(src.slice(unique.sites[0].start, unique.sites[0].end), 'const b = 2;');

  const ambiguous = locateEditTarget(src, 'const a = 1;');
  assert.equal(ambiguous.error, 'edit_target_ambiguous');
  assert.equal(ambiguous.matchCount, 2);
  assert.equal(locateEditTarget(src, 'const z = 9;').error, 'edit_target_not_found');
});

test('occurrence and replace_all resolve a repeated snippet', () => {
  const src = 'const a = 1;\nconst b = 2;\nconst a = 1;\n';

  const second = locateEditTarget(src, 'const a = 1;', { occurrence: 2 });
  assert.equal(second.ok, true);
  assert.equal(second.sites.length, 1);
  assert.equal(spliceEditSites(src, second.sites, 'const a = 9;'), 'const a = 1;\nconst b = 2;\nconst a = 9;\n');

  const all = locateEditTarget(src, 'const a = 1;', { replaceAll: true });
  assert.equal(all.ok, true);
  assert.equal(all.sites.length, 2);
  assert.equal(spliceEditSites(src, all.sites, 'const a = 9;'), 'const a = 9;\nconst b = 2;\nconst a = 9;\n');

  const past = locateEditTarget(src, 'const a = 1;', { occurrence: 5 });
  assert.equal(past.error, 'edit_occurrence_out_of_range');
  assert.equal(past.matchCount, 2);
});

test('locateEditTarget tolerates a re-indented multi-line snippet', () => {
  const src = [
    'function App() {',
    '    return (',
    '      <div className="p-4">',
    '        <h1>Hello</h1>',
    '      </div>',
    '    );',
    '}',
  ].join('\n');
  // Model reproduced the block at the wrong base indentation.
  const find = ['<div className="p-4">', '  <h1>Hello</h1>', '</div>'].join('\n');
  const hit = locateEditTarget(src, find);
  assert.equal(hit.ok, true);
  assert.equal(hit.exact, false);
  const replaced = spliceEditSites(
    src,
    hit.sites,
    ['<div className="p-4">', '  <h1>Hi</h1>', '</div>'].join('\n'),
  );
  // Replacement lands at the file's real indentation, not the snippet's.
  assert.ok(replaced.includes('      <div className="p-4">\n        <h1>Hi</h1>\n      </div>'));
  assert.ok(replaced.startsWith('function App() {\n    return (\n'));
  assert.ok(replaced.endsWith('\n    );\n}'));
});

test('single-line snippets never fall back to fuzzy matching', () => {
  const src = '  const total = items.length;\n';
  assert.equal(locateEditTarget(src, 'const total = items.length;').exact, true);
  // Differing content on one line stays a miss — no accidental line match.
  assert.equal(locateEditTarget(src, 'const total = items.size;').error, 'edit_target_not_found');
});

test('applyProjectEdits patches through the whitespace-tolerant path', () => {
  const files = new Map([['App.jsx', 'export default function App() {\n      const x = 1;\n      return x;\n}\n']]);
  const out = applyProjectEdits(
    files,
    [{ path: 'App.jsx', find: 'const x = 1;\nreturn x;', replace: 'const x = 2;\nreturn x;' }],
    'App.jsx',
  );
  assert.equal(out.ok, true);
  assert.equal(out.files.get('App.jsx'), 'export default function App() {\n      const x = 2;\n      return x;\n}\n');
});

test('a failed batch reports every bad edit and changes nothing', () => {
  const files = new Map([['App.jsx', 'const a = 1;\nconst b = 2;\nconst c = 3;\n']]);
  const out = applyProjectEdits(
    files,
    [
      { find: 'const a = 1;', replace: 'const a = 9;' },
      { find: 'const NOPE = 1;', replace: 'x' },
      { find: 'const ALSO_NOPE = 2;', replace: 'y' },
    ],
    'App.jsx',
  );
  assert.equal(out.ok, false);
  // Both failures reported in one go — not just the first.
  assert.equal(out.failed_edits.length, 2);
  assert.deepEqual(out.failed_edits.map((f) => f.index), [1, 2]);
  assert.equal(out.edits_locatable, 1);
  assert.match(out.hint, /2 of 3 edit\(s\)/);
  // Atomic: the source map is untouched.
  assert.equal(files.get('App.jsx'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
});

test('applyProjectEdits honors replace_all across a file', () => {
  const files = new Map([['App.jsx', 'p-2 x p-2 y p-2\n']]);
  const out = applyProjectEdits(files, [{ find: 'p-2', replace: 'p-4', replace_all: true }], 'App.jsx');
  assert.equal(out.ok, true);
  assert.equal(out.files.get('App.jsx'), 'p-4 x p-4 y p-4\n');
});
