#!/usr/bin/env node
// ============================================================================
// scripts/rotate-connector-key.mjs — re-encrypt connector tokens in place
// ============================================================================
// LYKN encrypts every stored connector OAuth token (access + refresh) at
// rest with AES-256-GCM keyed on CONNECTOR_TOKEN_KEY (64 hex chars / 32
// bytes). Rotating that key naively makes every stored token unreadable —
// every user would have to reconnect every connector. This script avoids
// that by decrypting each row with the OLD key and re-encrypting with the
// NEW key in a single pass.
//
// USAGE (dry-run first, ALWAYS):
//   OLD_CONNECTOR_TOKEN_KEY=<old-64-hex> \
//   CONNECTOR_TOKEN_KEY=<new-64-hex>     \
//   node scripts/rotate-connector-key.mjs --dry-run
//
// THEN, if dry-run reports zero failures, the LIVE rotation:
//   OLD_CONNECTOR_TOKEN_KEY=<old-64-hex> \
//   CONNECTOR_TOKEN_KEY=<new-64-hex>     \
//   node scripts/rotate-connector-key.mjs
//
// After a successful live run, swap CONNECTOR_TOKEN_KEY in Render to the
// NEW value and redeploy. The OLD key is no longer needed and should be
// removed from any operator notes.
//
// Required env (also reads .env via `dotenv/config`):
//   • VITE_SUPABASE_URL              — the Supabase project URL
//   • SUPABASE_SERVICE_ROLE_KEY      — service-role (RLS bypass)
//   • OLD_CONNECTOR_TOKEN_KEY        — the key currently in production
//   • CONNECTOR_TOKEN_KEY            — the NEW key to migrate to
//
// SAFETY GATES:
//   • Refuses to run if OLD_CONNECTOR_TOKEN_KEY === CONNECTOR_TOKEN_KEY.
//   • Refuses to run if either key is missing or not 64 hex chars.
//   • Dry-run mode reads + decrypts every row but writes nothing. The
//     decrypt step proves the OLD key is correct for every existing blob.
//     ALWAYS run dry-run first; if dry-run reports failures, DO NOT run
//     live — fix the underlying issue first.
//   • Live mode re-encrypts in batches of 100, ordered by id, with each
//     row's UPDATE keyed on its row id (no full-table update ever issued).
//
// CIA: Availability (CONNECTOR_TOKEN_KEY can now be rotated without
//      destroying every user's connector integrations).
// Principle: SbD (dry-run first is mandatory), KISS (one script, clear output).
//
// LYKN Security Plan — Agent 06 of 6
// ============================================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  encryptTokenWithKey,
  decryptTokenWithKey,
} from '../lib/security/credentialStore.js';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 100;

const OLD_KEY = process.env.OLD_CONNECTOR_TOKEN_KEY;
const NEW_KEY = process.env.CONNECTOR_TOKEN_KEY;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function die(msg, code = 1) {
  console.error(`ERROR: ${msg}`);
  process.exit(code);
}

function logTokenSummary(row, accessOk, refreshOk) {
  // Only opaque identifiers — never any token material.
  console.log(
    `  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} (provider=${row.provider}, user=${row.user_id})` +
    ` access=${accessOk ? 'ok' : 'fail'} refresh=${refreshOk}`,
  );
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

if (!SUPABASE_URL) die('VITE_SUPABASE_URL is required (typically loaded from .env).');
if (!SERVICE_ROLE) die('SUPABASE_SERVICE_ROLE_KEY is required.');
if (!OLD_KEY)     die('OLD_CONNECTOR_TOKEN_KEY is required.');
if (!NEW_KEY)     die('CONNECTOR_TOKEN_KEY is required.');
if (!/^[0-9a-fA-F]{64}$/.test(OLD_KEY)) die('OLD_CONNECTOR_TOKEN_KEY must be 64 hex chars.');
if (!/^[0-9a-fA-F]{64}$/.test(NEW_KEY)) die('CONNECTOR_TOKEN_KEY must be 64 hex chars.');
if (OLD_KEY.toLowerCase() === NEW_KEY.toLowerCase()) {
  die('OLD and NEW keys are identical. Nothing to rotate.');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function rotate() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE (will rewrite rows)'}`);
  console.log(`Target table: social_connections`);
  console.log('');

  // Pull just the columns we need; in particular, NO non-token metadata
  // beyond ids/provider so the log output is forensically safe to keep.
  // No LIMIT — paginate by id so the rotation tolerates table growth
  // during the run.
  let lastId = null;
  let totalRows = 0;
  let successAccess = 0;
  let successRefresh = 0;
  let skippedRefresh = 0;
  let failedAccess = 0;
  let failedRefresh = 0;
  const failureSummaries = [];

  while (true) {
    let q = supabase
      .from('social_connections')
      .select('id, user_id, provider, access_token, refresh_token')
      .order('id', { ascending: true })
      .limit(BATCH_SIZE);
    if (lastId) q = q.gt('id', lastId);

    const { data: rows, error } = await q;
    if (error) die(`failed to fetch batch after id=${lastId}: ${error.message}`);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      totalRows += 1;
      lastId = row.id;

      // ── 1. Decrypt access_token with OLD key.
      let plaintextAccess;
      let accessOk = false;
      if (!row.access_token) {
        // No token stored — nothing to migrate for this column.
        accessOk = true;
      } else {
        try {
          plaintextAccess = decryptTokenWithKey(row.access_token, OLD_KEY);
          accessOk = true;
        } catch (err) {
          failedAccess += 1;
          failureSummaries.push(
            `decrypt access on id=${row.id} (provider=${row.provider}, user=${row.user_id}): ${err.message}`,
          );
        }
      }

      // ── 2. Decrypt refresh_token with OLD key (may be null).
      let plaintextRefresh = null;
      let refreshOk = 'n/a';
      if (row.refresh_token) {
        try {
          plaintextRefresh = decryptTokenWithKey(row.refresh_token, OLD_KEY);
          refreshOk = 'ok';
        } catch (err) {
          refreshOk = 'fail';
          failedRefresh += 1;
          failureSummaries.push(
            `decrypt refresh on id=${row.id} (provider=${row.provider}, user=${row.user_id}): ${err.message}`,
          );
        }
      } else {
        skippedRefresh += 1;
      }

      logTokenSummary(row, accessOk, refreshOk);

      // ── 3. Re-encrypt with NEW key and write back (live mode only).
      if (!DRY_RUN && accessOk) {
        const newAccess = row.access_token
          ? encryptTokenWithKey(plaintextAccess, NEW_KEY)
          : null;
        const newRefresh = (row.refresh_token && refreshOk === 'ok')
          ? encryptTokenWithKey(plaintextRefresh, NEW_KEY)
          : row.refresh_token; // preserve OLD-encrypted blob if decrypt failed (don't corrupt)

        const update = {};
        if (row.access_token) update.access_token = newAccess;
        // Only re-encrypt refresh if the decrypt actually succeeded — we
        // never want to overwrite a decryptable blob with garbage from a
        // failed re-encrypt path.
        if (row.refresh_token && refreshOk === 'ok') update.refresh_token = newRefresh;

        if (Object.keys(update).length > 0) {
          const { error: updErr } = await supabase
            .from('social_connections')
            .update(update)
            .eq('id', row.id);
          if (updErr) {
            failureSummaries.push(
              `update row id=${row.id}: ${updErr.message}`,
            );
            failedAccess += 1;
          } else {
            successAccess += row.access_token ? 1 : 0;
            successRefresh += (row.refresh_token && refreshOk === 'ok') ? 1 : 0;
          }
        }
      } else if (accessOk) {
        // Dry-run accounting.
        successAccess += row.access_token ? 1 : 0;
        successRefresh += (row.refresh_token && refreshOk === 'ok') ? 1 : 0;
      }
    }

    if (rows.length < BATCH_SIZE) break;
  }

  // ---------------------------------------------------------------------------
  // Result
  // ---------------------------------------------------------------------------
  console.log('');
  console.log('─────────────────────────────────────────────');
  console.log(`Rows processed:      ${totalRows}`);
  console.log(`  access decrypted:  ${successAccess} ok, ${failedAccess} fail`);
  console.log(`  refresh decrypted: ${successRefresh} ok, ${failedRefresh} fail, ${skippedRefresh} skipped (null)`);
  console.log('─────────────────────────────────────────────');

  if (failureSummaries.length > 0) {
    console.log('');
    console.log('FAILURES (first 20):');
    for (const f of failureSummaries.slice(0, 20)) {
      console.log(`  - ${f}`);
    }
    console.log('');
    if (DRY_RUN) {
      console.error(
        'Dry-run reported failures. DO NOT run the live rotation until every failing row is investigated.\n' +
        'Common causes:\n' +
        '  • OLD_CONNECTOR_TOKEN_KEY does not match the key the row was encrypted with.\n' +
        '  • The row predates AES-256-GCM (legacy plaintext) — these should be re-connected by hand.\n' +
        '  • The row was previously corrupted; remove it via the Connections UI to force re-auth.',
      );
      process.exit(1);
    } else {
      console.error(
        'Live rotation completed with errors. Inspect the failures above before swapping CONNECTOR_TOKEN_KEY in Render.',
      );
      process.exit(2);
    }
  }

  if (DRY_RUN) {
    console.log('Dry-run complete — every row is decryptable with OLD_CONNECTOR_TOKEN_KEY.');
    console.log('Safe to proceed with the live rotation:');
    console.log('  unset --dry-run and re-run the same command.');
  } else {
    console.log('LIVE rotation complete.');
    console.log('Next steps (per ROTATION_RUNBOOK.md):');
    console.log('  1. Swap CONNECTOR_TOKEN_KEY in Render to the NEW value.');
    console.log('  2. Redeploy.');
    console.log('  3. Smoke-test a connector sync (e.g. trigger /api/connections/poll-due).');
    console.log('  4. Remove the OLD key from any operator notes.');
  }
}

rotate().catch((err) => {
  console.error('Fatal:', err?.stack || err?.message || String(err));
  process.exit(1);
});
