#!/usr/bin/env node
/**
 * Architecture ratchet. Offline, fast, no product behavior.
 *
 *   node scripts/architecture/check-architecture.mjs
 *   node scripts/architecture/check-architecture.mjs --root <dir> --budgets <json>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../..');
const DEFAULT_BUDGETS = path.join(HERE, 'architecture-budgets.json');

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  'ios',
  '.worktrees',
  'vendor',
  'public',
  'remotion',
  'supabase-migrations',
]);
const SOURCE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx']);
const IDENTIFIER_SKIP_PREFIXES = [
  'tests/',
  'docs/',
  'scripts/architecture/',
];

const FORBIDDEN_IMPORT_RULES = [
  {
    fromPrefix: 'electron/task-runtime/',
    cannotMatch: /(^|[\\/])main\.cjs$/,
    label: 'electron/task-runtime must not import electron/main.cjs',
  },
  {
    fromPrefix: 'server/memory/',
    cannotMatch: /(^|[\\/])server\.js$/,
    label: 'server/memory must not import server.js',
  },
  {
    fromPrefix: 'server/ai/',
    cannotMatch: /(^|[\\/])server\.js$/,
    label: 'server/ai must not import server.js',
  },
  {
    fromPrefix: 'lib/mcp/',
    cannotMatch: /(pages[\\/]Vault|components[\\/]vault[\\/])/i,
    label: 'lib/mcp must not import Vault page/UI modules',
  },
  {
    fromPrefix: 'electron/task-runtime/executors/',
    cannotMatch: /(src[\\/]pages[\\/]|src[\\/]components[\\/])/i,
    label: 'executors must not import renderer page components',
  },
  {
    fromPrefix: 'src/',
    cannotMatch: /(^|[\\/])server\.js$|[\\/]server[\\/](ai|routes|memory|services)[\\/]/,
    label: 'frontend must not import server implementation modules',
  },
];

function parseArgs(argv) {
  const out = { root: DEFAULT_ROOT, budgets: DEFAULT_BUDGETS, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') out.root = path.resolve(argv[++i]);
    else if (argv[i] === '--budgets') out.budgets = path.resolve(argv[++i]);
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

function loadBudgets(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

function walkSource(root) {
  const files = [];
  function rec(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        if (entry.isDirectory() && entry.name !== '.') continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        rec(full);
        continue;
      }
      if (!SOURCE_EXT.has(path.extname(entry.name))) continue;
      files.push(full);
    }
  }
  rec(root);
  return files;
}

function countLines(file) {
  const buf = fs.readFileSync(file);
  if (!buf.length) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 10) n += 1;
  }
  if (buf[buf.length - 1] !== 10) n += 1;
  return n;
}

function extractImports(src) {
  const specs = [];
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) specs.push(m[1]);
  return specs;
}

function resolveImport(fromFile, spec, root) {
  if (!spec.startsWith('.')) return spec;
  const abs = path.resolve(path.dirname(fromFile), spec);
  return toPosix(path.relative(root, abs));
}

function countDirectServerRoutes(src) {
  const withoutBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  let n = 0;
  for (const line of withoutBlock.split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    if (/\bapp\.(get|post|put|patch|delete)\s*\(/.test(code)) n += 1;
  }
  return n;
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function padLeft(s, n) {
  const str = String(s);
  return str.length >= n ? str : ' '.repeat(n - str.length) + str;
}

export function checkArchitecture({ root, budgets } = {}) {
  const repoRoot = root || DEFAULT_ROOT;
  const cfg = typeof budgets === 'string'
    ? loadBudgets(budgets)
    : budgets || loadBudgets(DEFAULT_BUDGETS);

  const failures = [];
  const warnings = [];
  const budgetRows = [];
  const exceptionRows = [];
  const reviewRows = [];

  const important = cfg.importantFiles || {};
  const exceptions = cfg.exceptions || {};
  const reviewThreshold = cfg.reviewThreshold ?? 1500;
  const failThreshold = cfg.failThreshold ?? 2500;
  const maxDirect = cfg.maxDirectServerRoutes ?? 4;

  const files = walkSource(repoRoot).sort();
  const sizes = new Map();
  for (const abs of files) {
    const rel = toPosix(path.relative(repoRoot, abs));
    sizes.set(rel, countLines(abs));
  }

  for (const [rel, spec] of Object.entries(important)) {
    const current = sizes.get(rel);
    const max = spec.maxLines;
    const row = { path: rel, current: current ?? null, max, owner: spec.owner, reason: spec.reason };
    budgetRows.push(row);
    if (current == null) {
      failures.push({
        kind: 'missing-important-file',
        path: rel,
        message: `Important file ${rel} is missing. This budget exists to prevent silent deletion of a composition root.`,
      });
      continue;
    }
    if (current > max) {
      failures.push({
        kind: 'important-budget',
        path: rel,
        message: `${rel} is ${current} lines (budget ${max}). ${spec.reason || ''} Do not auto-raise this budget. Split by ownership or document a justified exception.`,
      });
    }
  }

  for (const [rel, spec] of Object.entries(exceptions)) {
    const current = sizes.get(rel) ?? 0;
    exceptionRows.push({
      path: rel,
      current,
      max: spec.maxLines,
      owner: spec.owner,
      reason: spec.reason,
    });
    if (current > spec.maxLines) {
      failures.push({
        kind: 'exception-budget',
        path: rel,
        message: `${rel} exceeded its documented exception (${current} / ${spec.maxLines}). ${spec.reason || ''} Do not auto-raise this budget.`,
      });
    }
  }

  for (const [rel, current] of sizes) {
    if (current <= reviewThreshold) continue;
    const exception = exceptions[rel];
    const importantSpec = important[rel];
    const cap = exception?.maxLines ?? (current > failThreshold ? failThreshold : null);
    reviewRows.push({ path: rel, current, exception: Boolean(exception), important: Boolean(importantSpec) });
    if (current > failThreshold && !exception) {
      failures.push({
        kind: 'generic-size',
        path: rel,
        message: `${rel} is ${current} lines (generic fail threshold ${failThreshold}). Moving unrelated lines into a new file is not a fix. Add a documented exception with owner, maxLines, and reason in scripts/architecture/architecture-budgets.json only if the file is a cohesive owner.`,
      });
    } else if (!exception && !importantSpec && current > reviewThreshold) {
      warnings.push({
        kind: 'review-size',
        path: rel,
        message: `${rel} is ${current} lines (review threshold ${reviewThreshold}). Justify cohesion before adding substantial new logic.`,
      });
    }
    if (exception && cap && current > cap) {
      // already reported above
    }
  }

  const serverPath = path.join(repoRoot, 'server.js');
  if (fs.existsSync(serverPath)) {
    const serverSrc = fs.readFileSync(serverPath, 'utf8');
    const direct = countDirectServerRoutes(serverSrc);
    budgetRows.push({
      path: 'server.js direct app.get/post/patch/delete',
      current: direct,
      max: maxDirect,
      owner: 'composition-root',
      reason: 'Route implementation belongs in extracted route modules.',
    });
    if (direct > maxDirect) {
      failures.push({
        kind: 'server-routes',
        path: 'server.js',
        message: `server.js has ${direct} direct app.get/post/patch/delete calls (budget ${maxDirect}). Register routes from extracted modules instead of growing the composition root.`,
      });
    }
  }

  for (const rel of cfg.retiredFiles || []) {
    if (fs.existsSync(path.join(repoRoot, rel))) {
      failures.push({
        kind: 'retired-file',
        path: rel,
        message: `${rel} was retired and must not return. Legacy connector sync / OAuth routes are not part of Universal MCP.`,
      });
    }
  }

  const forbidden = cfg.forbiddenIdentifiers || [];
  for (const [rel] of sizes) {
    if (IDENTIFIER_SKIP_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue;
    if (/\.(?:test|spec)\.[^.]+$/.test(rel)) continue;
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    for (const token of forbidden) {
      if (src.includes(token)) {
        failures.push({
          kind: 'forbidden-identifier',
          path: rel,
          message: `${rel} contains forbidden legacy identifier \`${token}\`. Canonical Task/MCP/memory ownership forbids this runtime.`,
        });
      }
    }
  }

  for (const abs of files) {
    const rel = toPosix(path.relative(repoRoot, abs));
    const src = fs.readFileSync(abs, 'utf8');
    const specs = extractImports(src);
    for (const spec of specs) {
      const resolved = resolveImport(abs, spec, repoRoot);
      for (const rule of FORBIDDEN_IMPORT_RULES) {
        if (!rel.startsWith(rule.fromPrefix)) continue;
        if (rule.cannotMatch.test(resolved) || rule.cannotMatch.test(spec)) {
          failures.push({
            kind: 'forbidden-import',
            path: rel,
            message: `${rel} imports \`${spec}\` (${rule.label}).`,
          });
        }
      }
    }
  }

  const top = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    budgetRows,
    exceptionRows,
    reviewRows: reviewRows.filter((row) => row.current > reviewThreshold).sort((a, b) => b.current - a.current),
    top,
    sizes,
  };
}

function formatReport(result) {
  const lines = [];
  lines.push('Architecture budgets');
  lines.push('');
  for (const row of result.budgetRows) {
    const current = row.current == null ? '?' : row.current;
    const mark = row.current == null || row.current > row.max ? '✗' : '✓';
    lines.push(
      `${mark} ${pad(row.path, 42)} ${padLeft(current, 6)} / ${row.max}`,
    );
  }
  lines.push('');
  lines.push('Exceptions');
  lines.push('');
  for (const row of result.exceptionRows) {
    const mark = row.current > row.max ? '✗' : '✓';
    lines.push(
      `${mark} ${pad(row.path, 42)} ${padLeft(row.current, 6)} / ${row.max}`,
    );
    if (row.reason) lines.push(`  ${row.reason}`);
  }
  if (result.warnings.length) {
    lines.push('');
    lines.push(`Review (${result.warnings.length} files over ${1500} lines, not budgeted)`);
    for (const warning of result.warnings) {
      lines.push(`• ${warning.message}`);
    }
  }
  if (result.failures.length) {
    lines.push('');
    lines.push('Failures');
    for (const failure of result.failures) {
      lines.push(`✗ ${failure.message}`);
    }
    lines.push('');
    lines.push('Budgets are ratchets. Do not auto-modify them.');
    lines.push('To add a justified exception, edit scripts/architecture/architecture-budgets.json with path, maxLines, owner, and reason.');
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const result = checkArchitecture({ root: args.root, budgets: args.budgets });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

export { formatReport, DEFAULT_ROOT, DEFAULT_BUDGETS };
