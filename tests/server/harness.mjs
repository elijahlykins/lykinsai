// ============================================================================
// tests/server/harness.mjs — server characterization harness (Wave 0)
// ============================================================================
// Loads the production `app` from server.js WITHOUT starting the listener,
// the pollers, or any external integration, and with every secret in the
// process environment replaced by an inert dummy value.
//
// HOW IMPORT SAFETY WORKS (verified against server.js @ 27,839 lines):
//   1. server.js guards `app.listen(...)` behind `NODE_ENV !== 'test'`.
//      This harness force-sets NODE_ENV=test BEFORE importing, so the
//      listener, startSessionCleanup(), the RSS poller, the connector
//      poller, and the Cursor-build poller (all inside the listen
//      callback) never start.
//   2. server.js loads `.env` via dotenv, which does NOT override keys
//      already present in process.env. scrubEnv() below pre-sets EVERY
//      key that appears in .env (parsed by name only — values are never
//      read) to a harmless dummy, so no real credential can enter the
//      test process even though .env holds production secrets.
//   3. All URL-shaped env vars point at http://127.0.0.1:9 — a closed
//      loopback port. Any code path that unexpectedly performs I/O fails
//      instantly with ECONNREFUSED instead of reaching a real service.
//   4. Remaining import-time side effects are inert: validateSecrets()
//      only warns outside production; the Supabase/Stripe/Resend clients
//      are constructed lazily or without network I/O at construction.
//
// This file deliberately performs NO structural change to server.js.

import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 48-char dummy: long enough to satisfy every per-call secret length floor
// (>=32 chars) so secret-gated routes exercise their real comparison path
// (and fail it, deterministically) instead of the "unconfigured" branch.
const DUMMY_SECRET = 'lykn-server-harness-dummy-0123456789abcdef01234';
// Loopback URL on a closed port: instant ECONNREFUSED, never leaves the box.
const DUMMY_URL = 'http://127.0.0.1:9/lykn-server-harness';
// 64 hex chars — CONNECTOR_TOKEN_KEY must parse as an AES-256 key.
const DUMMY_HEX_64 = '0123456789abcdef'.repeat(4);

// Keys the smoke tests rely on for deterministic behavior, forced even if
// absent from .env. Values are inert dummies.
const FORCED_KEYS = {
  NODE_ENV: 'test',
  VITE_SUPABASE_URL: DUMMY_URL,
  VITE_SUPABASE_ANON_KEY: DUMMY_SECRET,
  SUPABASE_SERVICE_ROLE_KEY: DUMMY_SECRET,
  STRIPE_SECRET_KEY: DUMMY_SECRET,
  STRIPE_WEBHOOK_SECRET: DUMMY_SECRET,
  ADMIN_INGEST_SECRET: DUMMY_SECRET,
  DISCOVER_INGEST_SECRET: DUMMY_SECRET,
  BACKFILL_SECRET: DUMMY_SECRET,
  VOICE_SESSION_SECRET: DUMMY_SECRET,
  CONNECTOR_TOKEN_KEY: DUMMY_HEX_64,
  ADMIN_EMAILS: 'server-harness-admin@example.invalid',
  // Guest-stream's "any provider configured?" gate must pass so the route
  // reaches its own input validation (which is what we characterize).
  OPENAI_API_KEY: DUMMY_SECRET,
  ANTHROPIC_API_KEY: DUMMY_SECRET,
  GOOGLE_API_KEY: DUMMY_SECRET,
  XAI_API_KEY: DUMMY_SECRET,
};

const URLISH_KEY_RE = /(URL|URI|ENDPOINT|_HOST)$/;

/** Parse .env for key NAMES only. Values are never read into this process. */
function readEnvKeyNames() {
  const envPath = path.join(repoRoot, '.env');
  let raw = '';
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return [];
  }
  const keys = [];
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

let scrubbed = false;

/**
 * Force-replace every .env-declared key (plus FORCED_KEYS) with an inert
 * dummy BEFORE server.js's dotenv.config() runs, so dotenv's no-override
 * behavior keeps every real value out of process.env.
 */
export function scrubEnv() {
  if (scrubbed) return;
  scrubbed = true;
  for (const key of readEnvKeyNames()) {
    if (key in FORCED_KEYS) continue;
    process.env[key] = URLISH_KEY_RE.test(key) ? DUMMY_URL : DUMMY_SECRET;
  }
  for (const [key, value] of Object.entries(FORCED_KEYS)) {
    process.env[key] = value;
  }
}

let appPromise = null;

/** Import server.js (once per process) with a scrubbed environment. */
export function loadApp() {
  if (!appPromise) {
    scrubEnv();
    appPromise = import('../../server.js').then((mod) => {
      if (!mod.app) throw new Error('server.js did not export `app`');
      return mod.app;
    });
  }
  return appPromise;
}

/**
 * Start the exported app on an ephemeral loopback port for smoke tests.
 * This is the harness's OWN listener (node:http) — production app.listen
 * remains untouched and skipped under NODE_ENV=test.
 */
export async function startEphemeral() {
  const app = await loadApp();
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export const HARNESS_DUMMY_SECRET = DUMMY_SECRET;
