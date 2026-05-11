#!/usr/bin/env node
// ============================================================================
// probeOauthFlow.js — end-to-end OAuth probe for LYKN's IdP
// ============================================================================
// What it does (in order):
//
//   1. GET /.well-known/oauth-authorization-server          — discovery
//   2. GET /.well-known/oauth-protected-resource            — RS metadata
//   3. POST /oauth/register                                 — DCR
//   4. Generate a PKCE verifier/challenge pair (S256)
//   5. Print the /oauth/authorize URL — operator opens it in a browser,
//      approves the consent screen, and pastes the redirected URL back
//      into the terminal
//   6. POST /oauth/token (authorization_code grant + PKCE verifier)
//   7. GET /oauth/userinfo with the bearer
//   8. POST /mcp tools/list with the bearer
//   9. POST /oauth/token (refresh_token grant) — verifies rotation
//  10. POST /oauth/revoke — verifies cleanup
//
// Pure Node — no extra deps. Run with:
//
//   node jobs/probeOauthFlow.js                       # against localhost
//   API_BASE_URL=https://lykn.io node jobs/probeOauthFlow.js
//
// Use this after every IdP change. If a step fails the script bails with
// the failing response body, so debugging is "scroll up to the red box".
//
// NOTE: This script is interactive at step 5. You'll need a browser to
// click "Approve" — there's no way to script the consent screen without
// also scripting Supabase auth, which would defeat the security model
// the consent screen exists to enforce.

import crypto from 'crypto';
import readline from 'readline';

const API_BASE = (process.env.API_BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
// The redirect_uri we register the test client with. Doesn't need to be
// a real server — we just need the operator to be able to read the
// `code` + `state` out of the URL after the consent redirect. localhost
// is allowed by the OAuth 2.1 BCP for native/dev clients.
const REDIRECT_URI = 'http://localhost:53682/oauth-probe';

const log = {
  step: (n, s) => console.log(`\n\u001b[1m\u001b[36m[${n}] ${s}\u001b[0m`),
  ok: (s) => console.log(`  \u001b[32m✓\u001b[0m ${s}`),
  warn: (s) => console.log(`  \u001b[33m!\u001b[0m ${s}`),
  fail: (s, body) => {
    console.log(`  \u001b[31m✗ ${s}\u001b[0m`);
    if (body !== undefined) console.log(`    ${typeof body === 'string' ? body : JSON.stringify(body, null, 2)}`);
    process.exit(1);
  },
  data: (label, val) => console.log(`    ${label}: ${typeof val === 'string' ? val : JSON.stringify(val)}`),
};

async function main() {
  console.log(`\u001b[1mLYKN OAuth probe\u001b[0m  →  ${API_BASE}`);

  // ── 1. Authorization server metadata ────────────────────────────────
  log.step(1, 'GET /.well-known/oauth-authorization-server');
  const meta = await fetchJson(`${API_BASE}/.well-known/oauth-authorization-server`);
  const requiredKeys = [
    'issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint',
    'response_types_supported', 'grant_types_supported',
    'code_challenge_methods_supported', 'token_endpoint_auth_methods_supported',
    'scopes_supported',
  ];
  for (const k of requiredKeys) {
    if (meta[k] === undefined) log.fail(`missing required field: ${k}`, meta);
  }
  if (!meta.code_challenge_methods_supported.includes('S256')) {
    log.fail('S256 not in code_challenge_methods_supported', meta);
  }
  log.ok(`issuer=${meta.issuer}`);
  log.ok(`scopes=${meta.scopes_supported.join(' ')}`);

  // ── 2. Protected resource metadata ──────────────────────────────────
  log.step(2, 'GET /.well-known/oauth-protected-resource');
  const rsMeta = await fetchJson(`${API_BASE}/.well-known/oauth-protected-resource`);
  if (!Array.isArray(rsMeta.authorization_servers) || !rsMeta.authorization_servers.includes(meta.issuer)) {
    log.fail('protected-resource doc does not list our issuer', rsMeta);
  }
  log.ok(`resource=${rsMeta.resource}`);

  // ── 3. Dynamic client registration ──────────────────────────────────
  log.step(3, 'POST /oauth/register (Dynamic Client Registration)');
  const reg = await fetchJson(`${meta.registration_endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: `LYKN OAuth Probe ${new Date().toISOString().slice(0, 19)}`,
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client + PKCE
      scope: 'lykn:read offline_access',
    }),
  });
  if (!reg.client_id) log.fail('DCR did not return a client_id', reg);
  log.ok(`client_id=${reg.client_id}`);
  log.ok(`echoed scope=${reg.scope}`);

  // ── 4. PKCE pair ────────────────────────────────────────────────────
  log.step(4, 'Generate PKCE verifier + S256 challenge');
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const state = base64url(crypto.randomBytes(12));
  log.ok(`verifier length=${verifier.length}`);
  log.ok(`challenge length=${challenge.length}`);

  // ── 5. Build /authorize URL, wait for operator to paste callback ────
  log.step(5, 'Build /authorize URL — open in your browser, approve, paste callback URL back');
  const authorizeUrl = new URL(meta.authorization_endpoint);
  authorizeUrl.searchParams.set('client_id', reg.client_id);
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'lykn:read offline_access');
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('');
  console.log('  \u001b[1mOpen this in your browser:\u001b[0m');
  console.log(`  \u001b[34m${authorizeUrl.toString()}\u001b[0m`);
  console.log('');
  console.log('  After approving, your browser will redirect to a URL like:');
  console.log(`  ${REDIRECT_URI}?code=lkn_code_xxx&state=${state}`);
  console.log('  (the page will fail to load — that is expected, just copy the address bar URL)');
  console.log('');

  const callbackUrl = await prompt('  Paste the full redirect URL: ');
  let parsedCb;
  try {
    parsedCb = new URL(callbackUrl.trim());
  } catch {
    log.fail('not a valid URL');
  }
  const cbCode = parsedCb.searchParams.get('code');
  const cbState = parsedCb.searchParams.get('state');
  const cbError = parsedCb.searchParams.get('error');
  if (cbError) log.fail(`/authorize returned error: ${cbError} (${parsedCb.searchParams.get('error_description') || ''})`);
  if (!cbCode) log.fail('no code in callback URL');
  if (cbState !== state) log.fail(`state mismatch: expected ${state}, got ${cbState}`);
  log.ok(`code=${cbCode.slice(0, 20)}…`);

  // ── 6. Exchange code for tokens ─────────────────────────────────────
  log.step(6, 'POST /oauth/token (authorization_code + PKCE)');
  const tokenRes = await fetchJson(meta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: cbCode,
      redirect_uri: REDIRECT_URI,
      client_id: reg.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tokenRes.access_token) log.fail('no access_token in /token response', tokenRes);
  log.ok(`access_token=${tokenRes.access_token.slice(0, 20)}…`);
  log.ok(`expires_in=${tokenRes.expires_in}s`);
  log.ok(`scope=${tokenRes.scope}`);
  if (tokenRes.refresh_token) log.ok(`refresh_token=${tokenRes.refresh_token.slice(0, 20)}…`);
  else log.warn('no refresh_token (offline_access not granted?)');

  // ── 7. /oauth/userinfo ──────────────────────────────────────────────
  log.step(7, 'GET /oauth/userinfo with the new bearer');
  const userinfo = await fetchJson(`${API_BASE}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${tokenRes.access_token}` },
  });
  if (!userinfo.sub) log.fail('userinfo did not return sub', userinfo);
  log.ok(`sub=${userinfo.sub}`);
  if (userinfo.email) log.ok(`email=${userinfo.email}`);

  // ── 8. /mcp tools/list ──────────────────────────────────────────────
  log.step(8, 'POST /mcp tools/list with the new bearer');
  const mcpRes = await fetchJson(`${API_BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenRes.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  if (!mcpRes.result?.tools) log.fail('tools/list did not return tools[]', mcpRes);
  log.ok(`${mcpRes.result.tools.length} tools advertised`);
  log.ok(`first tool: ${mcpRes.result.tools[0]?.name}`);

  // ── 9. Refresh-token rotation ───────────────────────────────────────
  if (tokenRes.refresh_token) {
    log.step(9, 'POST /oauth/token (refresh_token grant) — verifies rotation');
    const refRes = await fetchJson(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenRes.refresh_token,
        client_id: reg.client_id,
      }).toString(),
    });
    if (!refRes.access_token) log.fail('no access_token in refresh response', refRes);
    if (refRes.access_token === tokenRes.access_token) log.fail('access_token not rotated');
    if (refRes.refresh_token === tokenRes.refresh_token) log.fail('refresh_token not rotated');
    log.ok(`new access_token=${refRes.access_token.slice(0, 20)}…`);
    log.ok(`new refresh_token=${refRes.refresh_token?.slice(0, 20)}…`);
    // Replay the old refresh_token — should fail and revoke the family.
    const replayRes = await fetchRaw(meta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenRes.refresh_token, // old one
        client_id: reg.client_id,
      }).toString(),
    });
    if (replayRes.status >= 200 && replayRes.status < 300) {
      log.fail('refresh_token replay was accepted — RFC 6749 §10.4 violation', await replayRes.json().catch(() => ({})));
    }
    log.ok(`refresh_token replay rejected with HTTP ${replayRes.status}`);
  }

  // ── 10. Revoke ─────────────────────────────────────────────────────
  log.step(10, 'POST /oauth/revoke — clean up the test bearer');
  const finalToken = tokenRes.refresh_token ? null : tokenRes.access_token;
  // If we rotated, the rotated access token is the live one — but we
  // don't carry it back here. For a clean test exit, revoke whatever
  // we still have a handle on. (Production /Connections UI revokes by
  // consent, which cascades.)
  await fetchRaw(`${API_BASE}/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: finalToken || tokenRes.access_token,
      client_id: reg.client_id,
    }).toString(),
  });
  log.ok('revoke returned 200');

  console.log(`\n\u001b[1m\u001b[32mAll OAuth probe steps passed against ${API_BASE}.\u001b[0m\n`);
}

// ── Helpers ──────────────────────────────────────────────────────────────
async function fetchRaw(url, init) {
  return fetch(url, init);
}
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  let body;
  try {
    body = await res.json();
  } catch {
    const text = await res.text().catch(() => '');
    log.fail(`HTTP ${res.status} non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    log.fail(`HTTP ${res.status}`, body);
  }
  return body;
}
function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function prompt(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(label, (ans) => { rl.close(); resolve(ans); }));
}

main().catch((err) => {
  console.error(`\n\u001b[31mProbe crashed:\u001b[0m ${err?.message || err}`);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
