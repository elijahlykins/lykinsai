// ============================================================================
// scripts/server/update-route-manifest.mjs
// ============================================================================
// Regenerates tests/server/serverRouteManifest.json from the live Express app.
//
// Usage:
//   npm run test:server:update-manifest        # rewrite the checked-in manifest
//   node scripts/server/update-route-manifest.mjs --check   # diff only, exit 1 on drift
//
// Run this ONLY when a surface change is intentional, and review the diff of
// the JSON file like any other code change: every changed line is a changed
// route contract (order, method, path, or middleware chain).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApp } from '../../tests/server/harness.mjs';
import { buildManifest } from '../../tests/server/routeSurface.mjs';

const manifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'tests', 'server', 'serverRouteManifest.json',
);

const app = await loadApp();
const manifest = buildManifest(app);
const next = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : '';
  if (current === next) {
    console.log(`✅ route manifest up to date (${manifest.routeCount} routes, ${manifest.middlewareCount} app-level middleware)`);
    process.exit(0);
  }
  console.error('❌ route manifest drift detected. If the change is intentional, run: npm run test:server:update-manifest');
  process.exit(1);
}

fs.writeFileSync(manifestPath, next);
console.log(`✅ wrote ${manifestPath} (${manifest.routeCount} routes, ${manifest.middlewareCount} app-level middleware)`);
