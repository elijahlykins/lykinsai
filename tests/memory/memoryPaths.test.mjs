// Path validation — the gate between anything path-shaped and the store.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMemoryPath,
  normalizeMemoryPath,
  isValidMemorySlug,
  MEMORY_BUILT_IN_PATHS,
} from '../../server/memory/memoryPaths.js';

test('built-in paths parse with their fixed types', () => {
  for (const [path, def] of Object.entries(MEMORY_BUILT_IN_PATHS)) {
    const out = parseMemoryPath(path);
    assert.equal(out.ok, true, path);
    assert.equal(out.ok && out.kind, 'builtin');
    assert.equal(out.ok && out.type, def.type);
  }
});

test('dynamic project/topic paths parse with slug + type', () => {
  const p = parseMemoryPath('projects/lykn.md');
  assert.deepEqual(p.ok && [p.kind, p.type, p.slug], ['dynamic', 'project', 'lykn']);
  const t = parseMemoryPath('topics/token-budgets.md');
  assert.deepEqual(t.ok && [t.kind, t.type, t.slug], ['dynamic', 'topic', 'token-budgets']);
});

test('normalization: case, whitespace, leading ./', () => {
  assert.equal(normalizeMemoryPath('  Profile.MD  '), 'profile.md');
  assert.equal(normalizeMemoryPath('./goals.md'), 'goals.md');
  assert.equal(parseMemoryPath('PROJECTS/Lykn.md').ok, true);
});

test('traversal and escape attempts are rejected', () => {
  const attacks = [
    '../profile.md',
    'projects/../../../etc/passwd',
    'projects/..%2f..%2fsecrets.md',
    '/etc/passwd',
    'projects//x.md',
    'projects/./x.md',
    'projects\\x.md',
    'projects/x.md\u0000',
    'profile.md/..',
    '..',
    '',
    null,
    42,
    'a/'.repeat(100) + 'x.md',
  ];
  for (const a of attacks) {
    assert.equal(parseMemoryPath(a).ok, false, JSON.stringify(a));
  }
});

test('unknown root files and unknown namespaces are rejected', () => {
  assert.equal(parseMemoryPath('random.md').ok, false);
  assert.equal(parseMemoryPath('secrets/keys.md').ok, false);
  assert.equal(parseMemoryPath('projects/deep/nested.md').ok, false);
  assert.equal(parseMemoryPath('profile.txt').ok, false);
  assert.equal(parseMemoryPath('projects/valid').ok, false); // missing .md
});

test('slug rules: lowercase alphanumerics + inner hyphens, bounded length', () => {
  assert.equal(isValidMemorySlug('lykn'), true);
  assert.equal(isValidMemorySlug('a'), true);
  assert.equal(isValidMemorySlug('my-project-2'), true);
  assert.equal(isValidMemorySlug('-leading'), false);
  assert.equal(isValidMemorySlug('trailing-'), false);
  assert.equal(isValidMemorySlug('has space'), false);
  assert.equal(isValidMemorySlug('ünïcode'), false);
  assert.equal(isValidMemorySlug('x'.repeat(65)), false);
  assert.equal(parseMemoryPath(`projects/${'x'.repeat(64)}.md`).ok, true);
  assert.equal(parseMemoryPath(`projects/${'x'.repeat(65)}.md`).ok, false);
});
