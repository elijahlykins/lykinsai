#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const target = process.argv.includes('--win') ? 'win' : 'mac';
const failures = [];

function requireValue(name) {
  if (!String(process.env[name] || '').trim()) failures.push(`Missing ${name}`);
}

try {
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (dirty) failures.push('Desktop releases must be built from a clean git worktree');
} catch (error) {
  failures.push(`Unable to inspect git worktree: ${error.message}`);
}

if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  failures.push('Missing GH_TOKEN or GITHUB_TOKEN for GitHub Releases publishing');
}

if (target === 'mac') {
  const hasApiKey = process.env.APPLE_API_KEY
    && process.env.APPLE_API_KEY_ID
    && process.env.APPLE_API_ISSUER;
  const hasAppleId = process.env.APPLE_ID
    && process.env.APPLE_APP_SPECIFIC_PASSWORD
    && process.env.APPLE_TEAM_ID;
  if (!hasApiKey && !hasAppleId) {
    failures.push('Missing a complete Apple notarization credential set');
  }

  if (!process.env.CSC_LINK && process.platform === 'darwin') {
    try {
      const identities = execFileSync(
        'security',
        ['find-identity', '-v', '-p', 'codesigning'],
        { encoding: 'utf8' },
      );
      if (!/Developer ID Application/.test(identities)) {
        failures.push('No Developer ID Application signing identity found in the keychain');
      }
    } catch (error) {
      failures.push(`Unable to inspect macOS signing identities: ${error.message}`);
    }
  } else if (!process.env.CSC_LINK) {
    failures.push('Missing CSC_LINK for macOS signing outside a configured macOS keychain');
  }
}

if (target === 'win') {
  requireValue('CSC_LINK');
  requireValue('CSC_KEY_PASSWORD');
}

if (failures.length) {
  console.error(`Desktop ${target} release preflight failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Desktop ${target} release preflight passed.`);
