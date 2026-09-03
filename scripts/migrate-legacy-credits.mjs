#!/usr/bin/env node
// Convert remaining legacy credit wallet balances into purchased Usage
// Balance dollars, preserving what each user actually paid.
//
// Usage:
//   npm run billing:migrate-credits -- --dry-run   (default)
//   npm run billing:migrate-credits -- --execute
//
// Per wallet with remaining credits:
//   1. Value the remainder from the user's lykn_credit_topups history
//      (blended paid rate; catalog price fills missing amount_cents; the
//      best catalog rate is the fallback for walletless history).
//   2. Grant that many microdollars as a non-expiring purchased lot
//      (idempotency key legacy-credit-migration:<userId> — reruns are safe).
//   3. Zero the wallet via lykn_credit_wallet_spend so the legacy path
//      stops matching.
//
// Grant-then-zero ordering means a crash mid-run can only ever leave a user
// with MORE value (both balances) until the rerun zeroes the wallet — never
// less. The grant never duplicates thanks to the ledger idempotency key.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  LEGACY_MIGRATION_TXN,
  legacyMigrationIdempotencyKey,
  valueLegacyWallet,
} from '../lib/billing/legacyCreditMigration.js';
import { grantUsageBalance } from '../lib/billing/usageBalance.js';
import { formatUsd } from '../lib/billing/money.js';

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');

const url = process.env.VITE_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });

// Environments that never applied migration 123 have no legacy credit
// tables at all — that means zero wallets to migrate, not a failure.
function isMissingTable(error) {
  return /could not find the table/i.test(String(error?.message || ''));
}

async function listWalletsWithBalance() {
  const wallets = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('lykn_credit_wallets')
      .select('user_id, credits_granted, credits_used')
      .range(from, from + pageSize - 1);
    if (error && isMissingTable(error)) {
      console.log('lykn_credit_wallets does not exist in this database — no legacy credits to migrate.');
      return [];
    }
    if (error) throw new Error(`wallet list failed: ${error.message}`);
    for (const row of data || []) {
      if ((row.credits_granted || 0) > (row.credits_used || 0)) wallets.push(row);
    }
    if (!data || data.length < pageSize) break;
  }
  return wallets;
}

async function listTopups(userId) {
  const { data, error } = await supabase
    .from('lykn_credit_topups')
    .select('pack_id, credits, amount_cents')
    .eq('user_id', userId);
  if (error) throw new Error(`topup list failed for ${userId}: ${error.message}`);
  return data || [];
}

async function zeroWallet(userId, credits) {
  const { data, error } = await supabase.rpc('lykn_credit_wallet_spend', {
    p_user_id: userId,
    p_credits: credits,
  });
  if (error) throw new Error(`wallet zero failed for ${userId}: ${error.message}`);
  return data;
}

const wallets = await listWalletsWithBalance();
console.log(`${wallets.length} wallet(s) with a remaining legacy balance. Mode: ${execute ? 'EXECUTE' : 'dry-run'}`);

let totalGrantMicros = 0;
for (const wallet of wallets) {
  const userId = wallet.user_id;
  const topups = await listTopups(userId);
  const plan = valueLegacyWallet(
    { granted: wallet.credits_granted, used: wallet.credits_used },
    topups,
  );
  if (plan.grantMicros <= 0) continue;
  totalGrantMicros += plan.grantMicros;
  console.log(
    `${userId}: ${plan.remainingCredits} credits → ${formatUsd(plan.grantMicros)} ` +
    `(${topups.length} topup(s), ${(plan.microsPerCredit / 1_000_000).toFixed(6)} $/credit)`,
  );
  if (!execute) continue;

  const grant = await grantUsageBalance(userId, {
    amountMicros: plan.grantMicros,
    bucket: 'purchased',
    pricingProfile: 'topup',
    txnType: LEGACY_MIGRATION_TXN,
    expiresAt: null,
    idempotencyKey: legacyMigrationIdempotencyKey(userId),
    metadata: {
      reason: 'legacy_credit_migration',
      remaining_credits: plan.remainingCredits,
    },
  });
  if (!grant?.ok) {
    console.error(`  grant FAILED for ${userId}: ${grant?.error || 'unknown'} — wallet left untouched`);
    continue;
  }
  console.log(`  granted${grant.duplicate ? ' (already granted on a previous run)' : ''}`);
  await zeroWallet(userId, plan.remainingCredits);
  console.log('  wallet zeroed');
}

console.log(`Total conversion value: ${formatUsd(totalGrantMicros)}${execute ? '' : ' (dry-run, nothing written)'}`);
