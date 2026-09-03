/**
 * Legacy credit wallet → Usage Balance migration.
 *
 * Purchased credit packs (lykn_credit_wallets / lykn_credit_topups) are
 * retired. Remaining wallet balances convert once into non-expiring
 * purchased usage dollars, preserving what the user actually paid:
 *
 *   value per credit = total paid for their packs / total credits granted
 *
 * When a top-up row is missing amount_cents (webhook edge), the catalog
 * price for its pack_id fills in. A wallet with no top-up rows at all
 * (should not exist, but fail generous) uses the best catalog rate.
 *
 * Pure valuation logic lives here so it is unit-testable; the runner in
 * scripts/migrate-legacy-credits.mjs does the I/O.
 */

import { CREDIT_PACKS } from '../../src/lib/pricing-config.js';
import { MICROS_PER_USD, centsToMicros, usdToMicros } from './money.js';

export const LEGACY_MIGRATION_TXN = 'legacy_credit_migration';

export function legacyMigrationIdempotencyKey(userId) {
  return `legacy-credit-migration:${userId}`;
}

/** Highest catalog $-per-credit (the $5 / 1,000 pack) — the generous fallback. */
export function fallbackMicrosPerCredit() {
  let best = 0;
  for (const pack of CREDIT_PACKS) {
    if (!pack.credits) continue;
    const per = usdToMicros(pack.priceUsd) / pack.credits;
    if (per > best) best = per;
  }
  return best || Math.round(0.005 * MICROS_PER_USD);
}

/**
 * Paid value of one top-up row in microdollars. Prefers the recorded
 * amount_cents; falls back to the catalog price for the pack id.
 */
export function topupPaidMicros(topup) {
  const cents = Number(topup?.amount_cents);
  if (Number.isFinite(cents) && cents > 0) return centsToMicros(cents);
  const pack = CREDIT_PACKS.find((p) => p.id === topup?.pack_id);
  if (pack) return usdToMicros(pack.priceUsd);
  return 0;
}

/**
 * Compute the one-time conversion for a wallet.
 *
 * @param {{ granted: number, used: number }} wallet
 * @param {{ pack_id?: string, credits?: number, amount_cents?: number }[]} topups
 * @returns {{ remainingCredits: number, grantMicros: number, microsPerCredit: number }}
 */
export function valueLegacyWallet(wallet, topups = []) {
  const granted = Math.max(0, Number(wallet?.granted ?? wallet?.credits_granted ?? 0));
  const used = Math.max(0, Number(wallet?.used ?? wallet?.credits_used ?? 0));
  const remainingCredits = Math.max(0, granted - used);
  if (remainingCredits <= 0) {
    return { remainingCredits: 0, grantMicros: 0, microsPerCredit: 0 };
  }

  let paidMicros = 0;
  let paidCredits = 0;
  for (const topup of topups) {
    const credits = Number(topup?.credits) || 0;
    const micros = topupPaidMicros(topup);
    if (credits > 0 && micros > 0) {
      paidCredits += credits;
      paidMicros += micros;
    }
  }

  const microsPerCredit = paidCredits > 0
    ? paidMicros / paidCredits
    : fallbackMicrosPerCredit();
  const grantMicros = Math.round(remainingCredits * microsPerCredit);
  return { remainingCredits, grantMicros, microsPerCredit };
}
