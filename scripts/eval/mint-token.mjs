#!/usr/bin/env node
// ============================================================================
// scripts/eval/mint-token.mjs — mint an access token for the eval harness
// ============================================================================
// Usage:
//   node --env-file-if-exists=.env scripts/eval/mint-token.mjs            # prints the token
//   export LYKN_EVAL_TOKEN=$(node --env-file-if-exists=.env scripts/eval/mint-token.mjs --quiet)
//
// Reads LYKN_EVAL_EMAIL and LYKN_EVAL_PASSWORD from the environment and does a
// password grant against Supabase. Use a DEDICATED eval account, never a real
// one: the harness drives a browser with this identity for hours unattended.
//
// The token is printed to stdout and never written to disk. The supervisor
// passes it to the Electron child through the environment, so it stays out of
// the process table and out of the job files.
//
// A plain fetch rather than supabase-js: this needs one HTTP call, and the
// harness deliberately adds no dependencies.
// ============================================================================

const quiet = process.argv.includes('--quiet');
const log = (...a) => { if (!quiet) console.error(...a); };

const url = process.env.VITE_SUPABASE_URL;
const anon = process.env.VITE_SUPABASE_ANON_KEY;
const email = process.env.LYKN_EVAL_EMAIL;
const password = process.env.LYKN_EVAL_PASSWORD;

const missing = Object.entries({
  VITE_SUPABASE_URL: url,
  VITE_SUPABASE_ANON_KEY: anon,
  LYKN_EVAL_EMAIL: email,
  LYKN_EVAL_PASSWORD: password,
}).filter(([, v]) => !v).map(([k]) => k);

if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}`);
  console.error('Add LYKN_EVAL_EMAIL / LYKN_EVAL_PASSWORD for a dedicated eval account to .env.');
  process.exit(2);
}

const res = await fetch(`${url.replace(/\/$/, '')}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anon, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});

const data = await res.json().catch(() => ({}));
if (!res.ok || !data.access_token) {
  // Never echo the response body: a failed auth response can contain the
  // submitted identity.
  console.error(`Token grant failed: ${res.status} ${data.error_code || data.error || ''}`.trim());
  process.exit(1);
}

const expires = data.expires_in ? `${Math.round(data.expires_in / 60)} min` : 'unknown';
log(`Minted access token for ${email} (expires in ${expires}).`);
process.stdout.write(`${data.access_token}\n`);
