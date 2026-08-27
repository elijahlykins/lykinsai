#!/usr/bin/env node
// ============================================================================
// scripts/rotate-connector-key.mjs — re-encrypt shared credentials in place
// ============================================================================
// LYKN encrypts trusted-runtime credentials with AES-256-GCM keyed on
// CONNECTOR_TOKEN_KEY (64 hex chars / 32 bytes). Rotating that key naively
// makes every stored credential unreadable. This script covers generic,
// MCP, custom REST, and retained legacy credential stores.
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

const TARGETS = Object.freeze([
  {
    table: 'lykn_credentials',
    columns: ['secret_encrypted'],
    context: 'credential_type',
  },
  {
    table: 'lykn_mcp_connections',
    columns: ['secret_encrypted', 'oauth_encrypted'],
    context: 'name',
  },
  {
    table: 'lykn_custom_connections',
    columns: ['secret_encrypted'],
    context: 'slug',
  },
  {
    table: 'social_connections',
    columns: ['access_token', 'refresh_token'],
    context: 'provider',
  },
]);

function isMissingTable(error) {
  const message = String(error?.message || '');
  return error?.code === '42P01'
    || /relation .* does not exist/i.test(message)
    || /could not find the table/i.test(message);
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
  console.log(`Target tables: ${TARGETS.map((target) => target.table).join(', ')}`);
  console.log('');

  let totalRows = 0;
  let rotatedBlobs = 0;
  let skippedBlobs = 0;
  let failedBlobs = 0;
  const failureSummaries = [];

  for (const target of TARGETS) {
    console.log(`[${target.table}]`);
    let lastId = null;
    let tableRows = 0;

    while (true) {
      const selected = ['id', 'user_id', target.context, ...target.columns].join(', ');
      let query = supabase
        .from(target.table)
        .select(selected)
        .order('id', { ascending: true })
        .limit(BATCH_SIZE);
      if (lastId) query = query.gt('id', lastId);

      const { data: rows, error } = await query;
      if (error) {
        if (isMissingTable(error)) {
          console.log('  skipped (table not deployed)');
          break;
        }
        die(`failed to fetch ${target.table} after id=${lastId}: ${error.message}`);
      }
      if (!rows || rows.length === 0) break;

      for (const row of rows) {
        totalRows += 1;
        tableRows += 1;
        lastId = row.id;
        const update = {};
        const outcomes = [];

        for (const column of target.columns) {
          const blob = row[column];
          if (!blob) {
            skippedBlobs += 1;
            outcomes.push(`${column}=empty`);
            continue;
          }
          try {
            const plaintext = decryptTokenWithKey(blob, OLD_KEY);
            update[column] = encryptTokenWithKey(plaintext, NEW_KEY);
            outcomes.push(`${column}=ok`);
          } catch (error) {
            failedBlobs += 1;
            outcomes.push(`${column}=fail`);
            failureSummaries.push(
              `${target.table}.${column} id=${row.id} user=${row.user_id} context=${row[target.context] || ''}: ${error.message}`,
            );
          }
        }

        console.log(
          `  ${DRY_RUN ? '[dry-run] ' : ''}${row.id} (${outcomes.join(', ')})`,
        );

        if (Object.keys(update).length === 0) continue;
        if (!DRY_RUN) {
          const { error: updateError } = await supabase
            .from(target.table)
            .update(update)
            .eq('id', row.id);
          if (updateError) {
            failedBlobs += Object.keys(update).length;
            failureSummaries.push(
              `${target.table} update id=${row.id}: ${updateError.message}`,
            );
            continue;
          }
        }
        rotatedBlobs += Object.keys(update).length;
      }

      if (rows.length < BATCH_SIZE) break;
    }
    if (tableRows === 0) console.log('  no rows');
  }

  // ---------------------------------------------------------------------------
  // Result
  // ---------------------------------------------------------------------------
  console.log('');
  console.log('─────────────────────────────────────────────');
  console.log(`Rows processed:       ${totalRows}`);
  console.log(`Credential blobs:     ${rotatedBlobs} ok, ${failedBlobs} fail, ${skippedBlobs} empty`);
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
        '  • The row was previously corrupted; reconnect the affected credential.',
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
    console.log('  3. Smoke-test MCP, Calendar, Cursor Cloud, and Custom API credentials.');
    console.log('  4. Remove the OLD key from any operator notes.');
  }
}

rotate().catch((err) => {
  console.error('Fatal:', err?.stack || err?.message || String(err));
  process.exit(1);
});
