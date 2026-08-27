import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkArchitecture,
  DEFAULT_ROOT,
  DEFAULT_BUDGETS,
} from '../../scripts/architecture/check-architecture.mjs';

const productionBudgets = JSON.parse(fs.readFileSync(DEFAULT_BUDGETS, 'utf8'));
const fixtureBudgets = {
  reviewThreshold: 1500,
  failThreshold: 2500,
  maxDirectServerRoutes: 4,
  importantFiles: {},
  exceptions: {},
  retiredFiles: ['connectors-service.js'],
  forbiddenIdentifiers: productionBudgets.forbiddenIdentifiers,
};

function makeTree() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lykn-arch-'));
}

function write(root, rel, body) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

test('integrated HEAD satisfies architecture budgets and ownership rules', () => {
  const result = checkArchitecture({ root: DEFAULT_ROOT, budgets: productionBudgets });
  assert.equal(result.ok, true, result.failures.map((f) => f.message).join('\n'));
  assert.ok(result.budgetRows.length >= 8);
  const server = result.budgetRows.find((row) => row.path === 'server.js');
  assert.ok(server);
  assert.ok(server.current > 1000);
  assert.ok(server.current <= server.max);
});

test('oversized synthetic file fails the generic threshold', () => {
  const root = makeTree();
  write(root, 'lib/newManager.ts', `${'export const x = 1;\n'.repeat(2601)}`);
  const result = checkArchitecture({ root, budgets: fixtureBudgets });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.kind === 'generic-size' && f.path === 'lib/newManager.ts'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('forbidden import fails without touching production files', () => {
  const root = makeTree();
  write(root, 'server.js', 'export const app = {};\n');
  write(root, 'server/memory/memoryChat.js', "import { app } from '../../server.js';\n");
  const result = checkArchitecture({ root, budgets: fixtureBudgets });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.kind === 'forbidden-import' && f.path === 'server/memory/memoryChat.js'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('forbidden legacy identifier fails without touching production files', () => {
  const root = makeTree();
  write(root, 'electron/host.cjs', 'const flag = "browser_legacy_fallback";\n');
  const result = checkArchitecture({ root, budgets: fixtureBudgets });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.kind === 'forbidden-identifier' && f.path === 'electron/host.cjs'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('checker module lives next to the budgets file', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(
    path.basename(path.resolve(here, '../../scripts/architecture/architecture-budgets.json')),
    'architecture-budgets.json',
  );
});
