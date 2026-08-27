// Fail if extracted Chat/billing modules import server.js at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

function listJs(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return out;
    throw err;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(p));
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const SERVER_IMPORT_RE =
  /(?:from|import)\s*['"](?:\.\.\/)*server\.js['"]|require\(\s*['"](?:\.\.\/)*server\.js['"]\s*\)/;

test('server/ai and server/services do not import server.js', () => {
  const files = [...listJs(join(ROOT, 'server/ai')), ...listJs(join(ROOT, 'server/services'))];
  assert.ok(files.length > 0, 'expected extracted server modules');
  const offenders = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (SERVER_IMPORT_RE.test(src)) offenders.push(file.slice(ROOT.length + 1));
  }
  assert.deepEqual(offenders, []);
});
