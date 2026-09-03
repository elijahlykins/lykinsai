#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkLive = process.argv.includes('--live');
const checkEnv = process.argv.includes('--env');
const results = [];

function record(level, name, detail) {
  results.push({ level, name, detail });
}

async function exists(relativePath) {
  try {
    await access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function checkRepository() {
  const requiredFiles = [
    'vercel.json',
    'render.yaml',
    'electron-builder.json',
    'supabase-migrations/131_usage_balance.sql',
    'supabase-migrations/132_user_files_storage_policies.sql',
    'supabase-migrations/133_model_platform.sql',
    'supabase-migrations/134_usage_pricing_profiles.sql',
    'supabase-migrations/135_usage_internal_rls.sql',
    'scripts/anon-permission-probe.mjs',
    'scripts/verify-usage-balance.sql',
  ];

  for (const relativePath of requiredFiles) {
    record(
      (await exists(relativePath)) ? 'pass' : 'fail',
      `file:${relativePath}`,
      (await exists(relativePath)) ? 'present' : 'missing',
    );
  }

  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  record(packageJson.scripts?.start === 'node server.js' ? 'pass' : 'fail', 'server:start', packageJson.scripts?.start || 'missing');
  record(packageJson.scripts?.build ? 'pass' : 'fail', 'web:build', packageJson.scripts?.build || 'missing');
  record(packageJson.scripts?.['electron:release'] ? 'pass' : 'fail', 'desktop:release', packageJson.scripts?.['electron:release'] || 'missing');

  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    record(dirty ? 'fail' : 'pass', 'git:release-snapshot', dirty ? `${branch}@${sha} has uncommitted changes` : `${branch}@${sha} is clean`);
  } catch (error) {
    record('fail', 'git:release-snapshot', error.message);
  }
}

function checkProductionEnvironment() {
  const required = [
    'VITE_SUPABASE_URL',
    'VITE_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'APP_URL',
    'PUBLIC_API_BASE_URL',
    'ALLOWED_ORIGINS',
    'STRIPE_SECRET_KEY',
    'STRIPE_PUBLISHABLE_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_STUDIO_MONTHLY',
    'STRIPE_PRICE_STUDIO_ANNUAL',
    'STRIPE_PRICE_STUDENT_MONTHLY',
    'STRIPE_PRICE_STUDENT_ANNUAL',
    'STRIPE_PRICE_MAX_MONTHLY',
    'STRIPE_PRICE_MAX_ANNUAL',
    'BACKFILL_SECRET',
    'ADMIN_INGEST_SECRET',
    'CONNECTOR_TOKEN_KEY',
    'ADMIN_EMAILS',
    'VOICE_SESSION_SECRET',
    'OPENROUTER_API_KEY',
  ];

  for (const name of required) {
    const value = String(process.env[name] || '').trim();
    record(value ? 'pass' : 'fail', `env:${name}`, value ? 'set' : 'missing');
  }

  const connectorKey = String(process.env.CONNECTOR_TOKEN_KEY || '');
  if (connectorKey) {
    record(/^[a-f0-9]{64}$/i.test(connectorKey) ? 'pass' : 'fail', 'env:CONNECTOR_TOKEN_KEY_FORMAT', 'must be exactly 64 hexadecimal characters');
  }

  const serverOnlyLeaks = Object.keys(process.env).filter((name) => (
    name.startsWith('VITE_')
    && /(SECRET|SERVICE_ROLE|PRIVATE|TOKEN_KEY|API_KEY)/.test(name)
    && name !== 'VITE_SUPABASE_ANON_KEY'
  ));
  record(serverOnlyLeaks.length ? 'fail' : 'pass', 'env:public-secret-prefixes', serverOnlyLeaks.length ? serverOnlyLeaks.join(', ') : 'none');
}

async function checkEndpoint(name, url, expectedStatuses = [200]) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'LYKN-production-readiness/1.0' },
    });
    record(expectedStatuses.includes(response.status) ? 'pass' : 'fail', name, `${response.status} ${response.url}`);
    return response;
  } catch (error) {
    record('fail', name, error.message);
    return null;
  }
}

async function checkProductionEndpoints() {
  await checkEndpoint('live:web', 'https://lykn.io');
  await checkEndpoint('live:web-www', 'https://www.lykn.io');
  const health = await checkEndpoint('live:api-health', 'https://api.lykn.io/api/health');
  if (health?.ok) {
    try {
      const payload = await health.json();
      record(
        payload.status === 'ok' && payload.checks?.database === 'ok' && payload.checks?.secrets === 'ok' ? 'pass' : 'fail',
        'live:api-health-payload',
        `status=${payload.status}, database=${payload.checks?.database}, secrets=${payload.checks?.secrets}`,
      );
    } catch (error) {
      record('fail', 'live:api-health-payload', error.message);
    }
  }
  await checkEndpoint('live:stripe-config', 'https://api.lykn.io/api/billing/stripe-config');
  await checkEndpoint('live:managed-toolkit-catalog', 'https://api.lykn.io/api/public/toolkits');
  await checkEndpoint('live:artifact-host-lockdown', 'https://artifacts.lykn.io/api/health', [404]);
}

await checkRepository();
if (checkEnv) checkProductionEnvironment();
if (checkLive) await checkProductionEndpoints();

for (const result of results) {
  const marker = result.level === 'pass' ? 'PASS' : result.level === 'warn' ? 'WARN' : 'FAIL';
  console.log(`[${marker}] ${result.name}: ${result.detail}`);
}

const failures = results.filter((result) => result.level === 'fail');
console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
if (failures.length) {
  console.error(`${failures.length} launch blocker(s) remain.`);
  process.exitCode = 1;
}
